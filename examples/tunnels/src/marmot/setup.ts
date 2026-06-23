import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core/event-store";
import { normalizeRelayUrl } from "applesauce-core/helpers";
import { relaySet } from "applesauce-core/helpers/relays";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";

import {
  DEFAULT_CONVERGENCE_POLICY,
  GroupRumorHistory,
  MarmotClient,
} from "@internet-privacy/marmot-ts";
import { KeyValueRumorHistoryBackend } from "@internet-privacy/marmot-ts/extra";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { Directory, LOOKUP_RELAYS } from "../helpers/discovery.js";
import { PrefixedKeyValueStore } from "../helpers/prefixed-store.js";
import { RelayPool } from "../helpers/relay-pool.js";
import { SqliteKeyValueStore } from "../helpers/sqlite-store.js";
import { TunnelServer } from "./server.js";
import type { MessageMeta } from "./server.js";

/** Relays used when neither the specific nor the shared relay var is set. */
const DEFAULT_RELAYS = [
  "wss://relay.us.whitenoise.chat",
  "wss://relay.damus.io",
  "wss://nos.lol",
];

export interface TunnelConfig {
  /** Where SQLite state + the generated identity key live. */
  dataDir: string;
  /**
   * NIP-65 outbox relays (kind 10002): where the server publishes its profile,
   * relay lists, and KeyPackage — i.e. where peers discover it to invite it.
   */
  outboxRelays: string[];
  /**
   * Welcome-inbox relays (kind 10050): where the server watches for gift-wrapped
   * invites and where inviters deliver Welcomes.
   */
  inboxRelays: string[];
  /** HTTP port for the web UI. */
  port: number;
  /** Optional hex secret override (else read/generated under `dataDir`). */
  secretOverride?: string;
  /**
   * Optional inactivity TTL in hours. When set (> 0), groups with no kind-445
   * activity for at least this many hours are periodically purged from local
   * storage. Unset/0 means retain every group forever (the default).
   */
  groupTtlHours?: number;
}

/**
 * Read the server configuration from the environment. Inbox and outbox relays
 * are configured separately (`TUNNELS_INBOX_RELAYS` / `TUNNELS_OUTBOX_RELAYS`),
 * each falling back to the shared `TUNNELS_RELAYS` and then to a built-in
 * default set.
 */
export function configFromEnv(env = process.env): TunnelConfig {
  const shared = env.TUNNELS_RELAYS;
  return {
    dataDir: env.TUNNELS_DATA?.trim() || join(process.cwd(), "data"),
    outboxRelays: parseRelays(env.TUNNELS_OUTBOX_RELAYS ?? shared),
    inboxRelays: parseRelays(env.TUNNELS_INBOX_RELAYS ?? shared),
    port: Number(env.PORT) || 3000,
    secretOverride: env.TUNNELS_SECRET?.trim() || undefined,
    groupTtlHours: parseTtlHours(env.TUNNELS_GROUP_TTL_HOURS),
  };
}

/** Parse a positive number of hours, or `undefined` for retain-forever. */
function parseTtlHours(value: string | undefined): number | undefined {
  const hours = Number(value?.trim());
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/** The union of outbox + inbox relays (pool defaults, group ingest fallback). */
export function allRelays(config: TunnelConfig): string[] {
  return relaySet(config.outboxRelays, config.inboxRelays);
}

function parseRelays(value: string | undefined): string[] {
  const raw = (value?.trim() ? value.split(",") : DEFAULT_RELAYS).map((relay) =>
    relay.trim(),
  );
  return relaySet(
    raw.flatMap((relay) => {
      try {
        return [normalizeRelayUrl(relay)];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * Resolve the server's Nostr identity. A `TUNNELS_SECRET` env var is
 * authoritative and never written to disk; otherwise the key is loaded from
 * `dataDir/identity.key`, generating (and persisting) a fresh one on first run
 * so restarts keep the same identity — and therefore the same group
 * memberships.
 */
function loadOrCreateSecret(config: TunnelConfig): string {
  if (config.secretOverride) return config.secretOverride;
  const keyPath = join(config.dataDir, "identity.key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const account = PrivateKeyAccount.generateNew();
  const hex = Buffer.from(account.signer.key).toString("hex");
  writeFileSync(keyPath, hex);
  return hex;
}

/**
 * Wire up the full debugger stack: SQLite-backed stores, an applesauce relay
 * pool + event loader for discovery, and a {@link MarmotClient} configured to
 * *retain and process everything*. With `maxRewindCommits` /
 * `appPayloadPastEpochLimit` and both ingestion-pool bounds set to `Infinity`,
 * the engine never prunes a fork, never expires an app-payload witness, and
 * never drops an undecryptable event — so the client can follow and decrypt
 * every fork of every group it is invited to.
 */
export async function createServer(
  config: TunnelConfig,
): Promise<TunnelServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const relays = allRelays(config);

  // One SQLite connection holds every key-value store (groups, rewind history,
  // key packages, invites, messages) as separate tables.
  const db = new DatabaseSync(join(config.dataDir, "state.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const secretHex = loadOrCreateSecret(config);
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  // keepAlive: 0 tears a relay's health-watcher down as soon as nothing
  // subscribes, so a clean shutdown isn't blocked by a lingering timer.
  const nostr = new AsRelayPool({ keepAlive: 0 });

  const eventStore = new EventStore();
  createEventLoaderForStore(eventStore, nostr, {
    lookupRelays: LOOKUP_RELAYS,
    extraRelays: relays,
  });

  const directory = new Directory(eventStore);
  const pool = new RelayPool(nostr, relays, directory);

  // One shared message table holds every group's rumor history, each scoped to
  // a `${groupHex}:` keyspace so groups never read or clear each other's
  // messages. Keyed by rumor id, so re-ingesting an event overwrites in place.
  const messagesStore = new SqliteKeyValueStore<Rumor>(db, "messages");
  const historyFactory = GroupRumorHistory.makeFactory(
    (groupId) =>
      new KeyValueRumorHistoryBackend(
        new PrefixedKeyValueStore(
          messagesStore,
          Buffer.from(groupId).toString("hex") + ":",
        ),
      ),
  );

  const client = new MarmotClient({
    signer: account.signer,
    accountProofSigner: accountProofSignerFor(account),
    network: pool,
    groupStateStore: new SqliteKeyValueStore(db, "groups") as any,
    rewindStore: new SqliteKeyValueStore(db, "rewind") as any,
    keyPackageStore: new SqliteKeyValueStore(db, "keypackages") as any,
    inviteStore: new SqliteKeyValueStore(db, "invites") as any,
    historyFactory,
    clientId: "tunnels",
    // Retain and process EVERYTHING — the whole point of this debugger.
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits: Infinity,
      appPayloadPastEpochLimit: Infinity,
    },
    ingestionPool: { maxSize: Infinity, maxEpochAge: Infinity },
  });

  return new TunnelServer({
    client,
    pool,
    directory,
    eventStore,
    signer: account.signer,
    pubkey,
    outboxRelays: config.outboxRelays,
    inboxRelays: config.inboxRelays,
    // Sidecar index: where each application message decrypted — the MLS epoch
    // and the fork-tree node tag — keyed by `${groupHex}:${rumorId}`. Captured
    // during ingest (neither lives on the stored rumor) so the UI can attribute
    // each message to a specific fork, not just an epoch number. The table name
    // is unchanged so older epoch-only rows are read back via legacy coercion.
    metaStore: new SqliteKeyValueStore<MessageMeta>(db, "message_epochs"),
    // Durable archive of every kind-445 group event we ever see, keyed
    // `${groupHex}:${eventId}`. Replayed into the engine on startup so the full
    // history — forks, app messages (convergence witnesses), branch activity —
    // is reconstructed from our own store, independent of whether relays still
    // serve those events.
    eventArchive: new SqliteKeyValueStore<NostrEvent>(db, "events"),
    groupTtlHours: config.groupTtlHours,
    dispose: () => db.close(),
  });
}
