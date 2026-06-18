import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { relaySet } from "applesauce-core/helpers/relays";
import { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import { MarmotClient } from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { Directory } from "../helpers/discovery.js";
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

function makeStore<T>(ephemeral: boolean, path: string) {
  return ephemeral
    ? new InMemoryKeyValueStore<T>()
    : new FileKeyValueStore<T>(path);
}

export async function createController(
  opts: CliOptions,
  _onProgress: (line: string) => void,
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
  const directory = new Directory(nostr);
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
    signer: account.signer,
    pubkey,
    relays: bootstrapRelays,
    clientId,
    debug: opts.debug,
  });
}
