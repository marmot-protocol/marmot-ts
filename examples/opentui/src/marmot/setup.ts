import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core/event-store";
import { relaySet } from "applesauce-core/helpers/relays";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import { MarmotClient } from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { Directory, LOOKUP_RELAYS } from "../helpers/discovery.js";
import { FileKeyValueStore } from "../helpers/file-store.js";
import { RelayPool } from "../helpers/relay-pool.js";
import { MarmotController, type StatusLine } from "./controller.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export const HELP_TEXT = `Usage: marmot-opentui [options]

Options:
  --name <label>   Profile name; data + identity live in ~/.marmot-opentui/<label>/ (default: default)
  --relay <url>    Relay URL to use. Repeatable. (default: ${DEFAULT_RELAYS.join(", ")})
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
  relays: string[];
  secOverride: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const flag = (name: string) => argv.includes(name);
  const option = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const explicitRelays: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--relay" && argv[i + 1]) explicitRelays.push(argv[++i]);
  }
  return {
    label: option("--name", "default"),
    ephemeral: flag("--ephemeral"),
    logsPath: option("--logs", ""),
    debug: flag("--debug") || Boolean(option("--logs", "")),
    relays: relaySet(explicitRelays),
    secOverride: option("--sec", ""),
  };
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

export async function createController(
  opts: CliOptions,
  onStatus: (line: StatusLine) => void,
): Promise<MarmotController> {
  const explicitRelays = opts.relays;
  const bootstrapRelays = explicitRelays.length
    ? explicitRelays
    : relaySet(DEFAULT_RELAYS);
  const clientId = `marmot-opentui-${opts.label}`;

  const dataDir = join(homedir(), ".marmot-opentui", opts.label);
  mkdirSync(dataDir, { recursive: true });

  const keyPath = join(dataDir, "identity.key");
  const secretHex = loadOrCreateSecret(keyPath, opts.secOverride);
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
  });
}
