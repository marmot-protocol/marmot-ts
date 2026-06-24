import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core/event-store";
import { normalizeRelayUrl } from "applesauce-core/helpers";
import { relaySet } from "applesauce-core/helpers/relays";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import { GroupRumorHistory, MarmotClient } from "@internet-privacy/marmot-ts";
import {
  AuditEmitter,
  deriveAccountRef,
  deriveEngineId,
  type AuditContextOptions,
} from "@internet-privacy/marmot-ts/audit";
import {
  InMemoryKeyValueStore,
  KeyValueRumorHistoryBackend,
} from "@internet-privacy/marmot-ts/extra";
import { NodeJsonlAuditRecorder } from "@internet-privacy/marmot-ts/extra/audit/node";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { Directory, LOOKUP_RELAYS } from "../helpers/discovery.js";
import { PrefixedKeyValueStore } from "../helpers/prefixed-store.js";
import { SqliteKeyValueStore } from "../helpers/sqlite-store.js";
import { RelayPool } from "../helpers/relay-pool.js";
import { MarmotController, type StatusLine } from "./controller.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export const HELP_TEXT = `Usage: marmot-opentui [options]

Options:
  --name <label>   Profile name; data + identity live in ~/.marmot-opentui/<label>/ (default: default)
  --sec <hex>      Use a specific 32-byte hex Nostr secret key.
  --ephemeral      Keep app state in memory (audit can still write when enabled).
  --audit          Enable forensic audit JSONL recording.
  --audit-path <path>
                   Write audit JSONL to this path (implies --audit).
  --debug          Include full stack traces and cause chains in status errors.
  --logs <path>    Enable debug logging and append status/debug lines to this file.
  --help, -h       Print this help and exit.
`;

export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export interface CliOptions {
  label: string;
  ephemeral: boolean;
  debug: boolean;
  logsPath: string;
  audit: boolean;
  auditPath: string;
  secOverride: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const flag = (name: string) => argv.includes(name);
  const option = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    label: option("--name", "default"),
    ephemeral: flag("--ephemeral"),
    logsPath: option("--logs", ""),
    audit: flag("--audit") || Boolean(option("--audit-path", "")),
    auditPath: option("--audit-path", ""),
    debug: flag("--debug") || Boolean(option("--logs", "")),
    secOverride: option("--sec", ""),
  };
}

/**
 * The per-label files that together make up one account's local state. All
 * key-value stores share `state.db`; SQLite's WAL mode keeps `-wal`/`-shm`
 * sidecars next to it, which must be removed alongside the main file on reset.
 */
const STATE_FILES = [
  "identity.key",
  "state.db",
  "state.db-wal",
  "state.db-shm",
] as const;

/**
 * Wipe a label's identity and local state so the next {@link createController}
 * call starts a brand-new account. Deleting `identity.key` forces
 * {@link loadOrCreateSecret} to generate a fresh secret; deleting `state.db`
 * drops the previous account's groups, KeyPackages, invites, and messages. The
 * old controller must be stopped first — it holds the SQLite connection open and
 * would otherwise keep writing to (and recreate) the file we just deleted.
 */
function resetAccountFiles(dataDir: string): void {
  for (const file of STATE_FILES) {
    rmSync(join(dataDir, file), { force: true });
  }
}

function loadOrCreateSecret(keyPath: string, override: string): string {
  if (override) {
    writeFileSync(keyPath, override);
    return override;
  }
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const account = PrivateKeyAccount.generateNew();
  const hex = Buffer.from(account.signer.key).toString("hex");
  writeFileSync(keyPath, hex);
  return hex;
}

function loadOrCreateAuditDeviceId(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const id = randomBytes(16).toString("hex");
  writeFileSync(path, id);
  return id;
}

/**
 * Open the shared per-account SQLite database. WAL mode + `synchronous=NORMAL`
 * gives fast, crash-safe single-process writes for a local demo store.
 */
function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/**
 * One key-value store backed by a `db` table, or an in-memory store when `db` is
 * null (the `--ephemeral` path, where nothing touches disk).
 */
function makeStore<T>(db: Database | null, table: string) {
  return db
    ? new SqliteKeyValueStore<T>(db, table)
    : new InMemoryKeyValueStore<T>();
}

/** Normalise a free-form relay list to `wss://` URLs, dropping invalid entries. */
function normalizeRelayList(relays: string[]): string[] {
  return relaySet(
    relays.flatMap((relay) => {
      try {
        return [normalizeRelayUrl(relay)];
      } catch {
        return [];
      }
    }),
  );
}

/** Relay a freshly-created account falls back to when none is entered. */
const DEFAULT_NEW_ACCOUNT_RELAY = "wss://relay.us.whitenoise.chat";

/**
 * Details for the in-app "create a new account" flow. When present,
 * {@link createController} wipes the existing identity/state first and brings
 * the controller up as a brand-new account that publishes `name` + the relay
 * lists on its first start.
 */
export interface NewAccountSetup {
  /** Display name to publish as the new account's kind 0 profile. */
  name: string;
  /** Relays to use as the account's inbox + outbox; empty falls back to default. */
  relays: string[];
}

export async function createController(
  opts: CliOptions,
  onStatus: (line: StatusLine) => void,
  /**
   * When set, wipe this label's identity and stored state first so the
   * controller comes up as the brand-new account described here. Used by the
   * in-app "create a new account" flow; `--sec` is ignored on a reset so we
   * never re-import the key the user just logged out of.
   */
  newAccount?: NewAccountSetup,
): Promise<MarmotController> {
  const fresh = Boolean(newAccount);
  // A fresh account operates on the relays the user just chose (falling back to
  // the default whitenoise relay). A returning account only needs somewhere to
  // bootstrap *discovery* from: it connects to the defaults to read its own
  // advertised NIP-65 outbox + kind-10050 inbox relays, then publishes
  // everything (KeyPackages, profile, relay lists) to those — never back to the
  // defaults the user never configured (see MarmotController). These bootstrap
  // relays are read-only: they are NOT a publish target, and NOT where invites
  // are watched — that follows the kind-10050 inbox list.
  const chosenRelays = fresh
    ? normalizeRelayList(
        newAccount!.relays.length
          ? newAccount!.relays
          : [DEFAULT_NEW_ACCOUNT_RELAY],
      )
    : [];
  const bootstrapRelays = chosenRelays.length
    ? chosenRelays
    : relaySet(DEFAULT_RELAYS);
  const clientId = `marmot-opentui-${opts.label}`;

  const dataDir = join(homedir(), ".marmot-opentui", opts.label);
  mkdirSync(dataDir, { recursive: true });
  if (fresh) resetAccountFiles(dataDir);

  // One SQLite connection holds every key-value store for this account (groups,
  // KeyPackages, invites, messages) as separate tables. Null in ephemeral mode,
  // where each store falls back to memory and nothing touches disk. Opened after
  // any reset above so we never recreate a file we just deleted.
  const db = opts.ephemeral ? null : openDatabase(join(dataDir, "state.db"));

  const keyPath = join(dataDir, "identity.key");
  const secretHex = loadOrCreateSecret(keyPath, fresh ? "" : opts.secOverride);
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  let audit: NodeJsonlAuditRecorder | undefined;
  let auditContext: AuditContextOptions | undefined;
  let auditLogPath: string | undefined;
  if (opts.audit) {
    const deviceId = loadOrCreateAuditDeviceId(
      join(dataDir, "audit-device-id"),
    );
    const engineId = deriveEngineId(pubkey, deviceId);
    auditLogPath = opts.auditPath || join(dataDir, `audit-${engineId}.jsonl`);
    audit = new NodeJsonlAuditRecorder(auditLogPath);
    auditContext = {
      engineId,
      accountRef: deriveAccountRef(pubkey),
      recorderSessionId: randomUUID(),
      dataMode: "obfuscated_sensitive_data",
      source: {
        account_label: opts.label,
        device_id: deviceId,
        device_name: opts.label,
        platform: process.platform,
        app_version: "marmot-opentui/0.0.0",
        upload_trigger: "opentui_cli",
      },
    };
    const emitter = new AuditEmitter({ ...auditContext, sink: audit });
    emitter.emit({ type: "recorder_started", recorder: "marmot-opentui" });
    emitter.emit({ type: "source_context", source: auditContext.source! });
  }

  // keepAlive: 0 so a relay's health-watcher pipeline tears down immediately
  // once nothing subscribes to it, instead of arming a 30s timer that would
  // hold the event loop open after we close the pool on quit. The app keeps
  // long-lived subscriptions (groups/invites/history) open the whole time it
  // runs, so the relay refcount only reaches zero at shutdown — this never
  // causes connection churn during normal use, only a clean exit.
  const nostr = new AsRelayPool({ keepAlive: 0 });

  // One in-memory EventStore powers both the reactive UI (via `castUser().*$`
  // and `use$`) and the imperative {@link Directory} lookups. Attaching a
  // loader makes any subscription to a missing event fetch it from the
  // bootstrap relays (always) and the public {@link LOOKUP_RELAYS} (fallback),
  // batching + de-duplicating along the way.
  const eventStore = new EventStore();
  createEventLoaderForStore(eventStore, nostr, {
    lookupRelays: LOOKUP_RELAYS,
    extraRelays: bootstrapRelays,
  });

  const directory = new Directory(eventStore);
  const pool = new RelayPool(nostr, bootstrapRelays, directory);

  // One shared message store holds every group's rumor history. Each group's
  // backend is scoped to a `${groupHex}:` keyspace so groups never read or
  // clear each other's messages. Keyed by rumor id, so re-ingesting a group
  // event (e.g. relay backfill) overwrites in place rather than duplicating.
  const messagesStore = makeStore<Rumor>(db, "messages");
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
    audit,
    auditContext,
    groupStateStore: makeStore(db, "groups") as any,
    // Persist the convergence rewind window so fork recovery survives a restart
    // (otherwise a client on a minority branch at quit never rewinds on relaunch).
    rewindStore: makeStore(db, "rewind") as any,
    keyPackageStore: makeStore(db, "keypackages") as any,
    inviteStore: makeStore(db, "invites") as any,
    historyFactory,
    clientId,
  });

  return new MarmotController({
    // Closing the SQLite connection on stop() releases the file before any reset
    // deletes it, and flushes the WAL for the next run.
    dispose: () => {
      void audit?.close();
      db?.close();
    },
    client,
    pool,
    directory,
    eventStore,
    signer: account.signer,
    pubkey,
    relays: bootstrapRelays,
    fresh,
    clientId,
    debug: opts.debug,
    auditLogPath,
    statusLog: onStatus,
    // Only freshly-created accounts publish an initial profile on first start.
    initialProfileName: newAccount?.name?.trim() || undefined,
  });
}
