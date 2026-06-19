import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  InMemoryKeyValueStore,
  KeyValueRumorHistoryBackend,
} from "@internet-privacy/marmot-ts/extra";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { Directory, LOOKUP_RELAYS } from "../helpers/discovery.js";
import { FileKeyValueStore } from "../helpers/file-store.js";
import { PrefixedKeyValueStore } from "../helpers/prefixed-store.js";
import { RelayPool } from "../helpers/relay-pool.js";
import { MarmotController, type StatusLine } from "./controller.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export const HELP_TEXT = `Usage: marmot-opentui [options]

Options:
  --name <label>   Profile name; data + identity live in ~/.marmot-opentui/<label>/ (default: default)
  --sec <hex>      Use a specific 32-byte hex Nostr secret key.
  --ephemeral      Keep all state in memory.
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
    debug: flag("--debug") || Boolean(option("--logs", "")),
    secOverride: option("--sec", ""),
  };
}

/** The per-label files that together make up one account's local state. */
const STATE_FILES = [
  "identity.key",
  "groups.json",
  "keypackages.json",
  "invites.json",
  "messages.json",
] as const;

/**
 * Wipe a label's identity and local state so the next {@link createController}
 * call starts a brand-new account. Deleting `identity.key` forces
 * {@link loadOrCreateSecret} to generate a fresh secret; deleting the store
 * files drops the previous account's groups, KeyPackages, and invites. The old
 * controller must be stopped first — it holds these files open in memory and
 * would otherwise rewrite them on its next mutation.
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

function makeStore<T>(ephemeral: boolean, path: string) {
  return ephemeral
    ? new InMemoryKeyValueStore<T>()
    : new FileKeyValueStore<T>(path);
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
const DEFAULT_NEW_ACCOUNT_RELAY = "relay.us.whitenoise.chat";

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
  // bootstrap discovery from: it connects to the defaults, then adopts its own
  // advertised NIP-65 outbox + kind-10050 inbox relays once they're loaded (see
  // MarmotController#loadRelayLists). These bootstrap relays are NOT where
  // invites are watched — that follows the kind-10050 inbox list.
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

  const keyPath = join(dataDir, "identity.key");
  const secretHex = loadOrCreateSecret(keyPath, fresh ? "" : opts.secOverride);
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  const nostr = new AsRelayPool();

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
  const messagesStore = makeStore<Rumor>(
    opts.ephemeral,
    join(dataDir, "messages.json"),
  );
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
    groupStateStore: makeStore(
      opts.ephemeral,
      join(dataDir, "groups.json"),
    ) as any,
    keyPackageStore: makeStore(
      opts.ephemeral,
      join(dataDir, "keypackages.json"),
    ) as any,
    inviteStore: makeStore(
      opts.ephemeral,
      join(dataDir, "invites.json"),
    ) as any,
    historyFactory,
    clientId,
  });

  return new MarmotController({
    client,
    pool,
    directory,
    eventStore,
    signer: account.signer,
    pubkey,
    relays: bootstrapRelays,
    clientId,
    debug: opts.debug,
    statusLog: onStatus,
    // Only freshly-created accounts publish an initial profile on first start.
    initialProfileName: newAccount?.name?.trim() || undefined,
  });
}
