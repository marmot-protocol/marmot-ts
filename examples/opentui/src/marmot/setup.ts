import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { relaySet } from "applesauce-core/helpers/relays";

import {
  getNip65Relays,
  MarmotClient,
  NIP65_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { FileKeyValueStore } from "../helpers/file-store.js";
import { RelayPool } from "../helpers/relay-pool.js";
import { MarmotController } from "./controller.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export interface CliOptions {
  label: string;
  ephemeral: boolean;
  debug: boolean;
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
    debug: flag("--debug"),
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

function newest(events: NostrEvent[]): NostrEvent | undefined {
  return events.slice().sort((a, b) => b.created_at - a.created_at)[0];
}

function makeStore<T>(ephemeral: boolean, path: string) {
  return ephemeral
    ? new InMemoryKeyValueStore<T>()
    : new FileKeyValueStore<T>(path);
}

/**
 * Build the identity, stores, network pool, client, and controller from CLI
 * options. Runs all the up-front network discovery (NIP-65 relay lookup)
 * *before* the TUI renderer takes over the terminal, so there is no flicker.
 */
export async function createController(
  opts: CliOptions,
  onProgress: (line: string) => void,
): Promise<MarmotController> {
  const explicitRelays = opts.relays;
  const bootstrapRelays = explicitRelays.length
    ? explicitRelays
    : relaySet(DEFAULT_RELAYS);
  const clientId = `marmot-opentui-${opts.label}`;

  const dataDir = join(homedir(), ".marmot-opentui", opts.label);
  mkdirSync(dataDir, { recursive: true });

  const keyPath = join(dataDir, "identity.key");
  const created = !opts.secOverride && !existsSync(keyPath);
  const secretHex = loadOrCreateSecret(keyPath, opts.secOverride);
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  const pool = new RelayPool(bootstrapRelays);

  // For a returning identity, adopt the relays advertised in its NIP-65 list.
  let relays = bootstrapRelays;
  if (!created) {
    onProgress("looking up your NIP-65 relay list…");
    const lists = await pool.request(bootstrapRelays, {
      kinds: [NIP65_RELAY_LIST_KIND],
      authors: [pubkey],
    });
    const latest = newest(lists);
    const discovered = latest ? getNip65Relays(latest) : [];
    if (discovered.length) {
      relays = relaySet(discovered, explicitRelays);
      onProgress(`using your NIP-65 relays: ${relays.join(", ")}`);
    } else {
      onProgress("no NIP-65 list found — using bootstrap relays");
    }
  }
  pool.defaultRelays = relays;

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
    signer: account.signer,
    pubkey,
    relays,
    clientId,
    debug: opts.debug,
  });
}
