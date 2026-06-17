import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import {
  getNip65Relays,
  MarmotClient,
  NIP65_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { relaySet } from "applesauce-core/helpers/relays";

import { accountProofSignerFor } from "./account-proof.js";
import { ChatApp, formatError } from "./chat.js";
import { FileKeyValueStore } from "./file-store.js";
import { type LogFile, redirectDebugToFile } from "./logging.js";
import { RelayPool } from "./relay-pool.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

function readFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readOption(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Relays the user passed explicitly via `--relay` (empty if none). */
function readExplicitRelays(): string[] {
  const relays: string[] = [];
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--relay" && args[i + 1]) relays.push(args[++i]);
  }
  return relays;
}

function loadOrCreateSecret(
  keyPath: string,
  override: string,
): { hex: string; created: boolean } {
  if (override) {
    writeFileSync(keyPath, override);
    return { hex: override, created: false };
  }
  if (existsSync(keyPath)) {
    return { hex: readFileSync(keyPath, "utf8").trim(), created: false };
  }
  const account = PrivateKeyAccount.generateNew();
  const hex = Buffer.from(account.signer.key).toString("hex");
  writeFileSync(keyPath, hex);
  return { hex, created: true };
}

function newest(events: NostrEvent[]): NostrEvent | undefined {
  return events.slice().sort((a, b) => b.created_at - a.created_at)[0];
}

function makeStore<T>(ephemeral: boolean, path: string) {
  return ephemeral
    ? new InMemoryKeyValueStore<T>()
    : new FileKeyValueStore<T>(path);
}

async function main(): Promise<void> {
  const label = readOption("--name", "default");
  const ephemeral = readFlag("--ephemeral");
  const debug = readFlag("--debug");
  const logFilePath = readOption("--log-file", join(process.cwd(), "logs.txt"));
  const explicitRelays = relaySet(readExplicitRelays());
  const bootstrapRelays = explicitRelays.length
    ? explicitRelays
    : relaySet(DEFAULT_RELAYS);
  const secOverride = readOption("--sec", "");
  const clientId = `marmot-tui-${label}`;

  const dataDir = join(homedir(), ".marmot-tui", label);
  mkdirSync(dataDir, { recursive: true });

  const { hex: secretHex, created } = loadOrCreateSecret(
    join(dataDir, "identity.key"),
    secOverride,
  );
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  const pool = new RelayPool(bootstrapRelays);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  const log = (line: string): void => {
    // Reprint the line above the live input prompt.
    if (typeof process.stdout.clearLine === "function") {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    console.log(line);
    rl.prompt(true);
  };

  // When debugging, route the library's `debug` output to a file so it never
  // corrupts the live prompt; stack traces in errors stay on too.
  let logFile: LogFile | undefined;
  if (debug) logFile = redirectDebugToFile(logFilePath);

  log(
    `marmot-tui-chat — profile "${label}"${ephemeral ? " (ephemeral)" : ""}` +
      (logFile ? ` (debug: stack traces on, logs → ${logFile.path})` : ""),
  );

  // For a returning identity, adopt the relays the user already advertised in
  // their NIP-65 (kind 10002) list so they don't have to re-specify them.
  let relays = bootstrapRelays;
  if (!created) {
    const lists = await pool.request(bootstrapRelays, {
      kinds: [NIP65_RELAY_LIST_KIND],
      authors: [pubkey],
    });
    const latest = newest(lists);
    const discovered = latest ? getNip65Relays(latest) : [];
    if (discovered.length) {
      relays = relaySet(discovered, explicitRelays);
      log(`found your NIP-65 list — using ${relays.join(", ")}`);
    } else {
      log("no NIP-65 list found for you — using bootstrap relays");
    }
  }
  pool.defaultRelays = relays;

  const client = new MarmotClient({
    signer: account.signer,
    accountProofSigner: accountProofSignerFor(account),
    network: pool,
    groupStateStore: makeStore(ephemeral, join(dataDir, "groups.json")) as any,
    keyPackageStore: makeStore(
      ephemeral,
      join(dataDir, "keypackages.json"),
    ) as any,
    inviteStore: makeStore(ephemeral, join(dataDir, "invites.json")) as any,
    clientId,
  });

  const app = new ChatApp({
    client,
    pool,
    signer: account.signer,
    pubkey,
    relays,
    clientId,
    log,
    debug,
  });

  await app.start();
  rl.prompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    try {
      if (!line) {
        // nothing
      } else if (line.startsWith("/")) {
        await handleCommand(app, rl, log, line);
      } else {
        await app.sendText(line);
      }
    } catch (err) {
      log(`error: ${formatError(err, debug)}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    app.stop();
    logFile?.close();
    process.exit(0);
  });
}

async function handleCommand(
  app: ChatApp,
  rl: ReturnType<typeof createInterface>,
  log: (line: string) => void,
  line: string,
): Promise<void> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
      printHelp(log);
      break;
    case "whoami":
      app.whoami();
      break;
    case "new":
      if (!arg) throw new Error("usage: /new <name>");
      await app.createGroup(arg);
      break;
    case "invite":
      if (!arg) throw new Error("usage: /invite <npub|pubkey-hex>");
      await app.invite(arg);
      break;
    case "groups":
      app.listGroups();
      break;
    case "use":
      if (!arg) throw new Error("usage: /use <index|id-prefix>");
      app.useGroup(arg);
      break;
    case "invites":
      await app.listInvites();
      break;
    case "join":
      if (!arg) throw new Error("usage: /join <index>");
      await app.join(arg);
      break;
    case "leave":
      await app.leave();
      break;
    case "keypackage":
    case "kp":
      await app.keyPackage(arg);
      break;
    case "quit":
    case "exit":
      rl.close();
      break;
    default:
      throw new Error(`unknown command: /${cmd} (try /help)`);
  }
}

function printHelp(log: (line: string) => void): void {
  for (const line of [
    "commands:",
    "  /new <name>            create a group (you become admin)",
    "  /invite <npub|hex>     invite an account to the active group",
    "  /groups                list groups (* = active)",
    "  /use <index|prefix>    set the active group",
    "  /invites               list pending invites",
    "  /join <index>          accept an invite",
    "  /leave                 leave the active group (divergent — see README)",
    "  /keypackage [show|publish|rotate]  manage this device's KeyPackage",
    "  /whoami                print your npub",
    "  /quit                  exit",
    "  <text>                 send a message to the active group",
  ]) {
    log(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
