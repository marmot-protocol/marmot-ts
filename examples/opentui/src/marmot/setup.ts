import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core/event-store";
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
import {
  MarmotController,
  type AuditUploadConfig,
  type StatusLine,
} from "./controller.js";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

/** Reported as the audit `app_version` and the `X-Goggles-App-Version` header. */
const APP_VERSION = "marmot-opentui/0.0.0";

/**
 * The IPF/Marmot Goggles tracker. Used as the audit upload target when
 * `--audit-upload` is given as a bare flag (no explicit URL) and no
 * `$MARMOT_AUDIT_LOG_TRACKER_ENDPOINT` is set.
 */
const DEFAULT_GOGGLES_ENDPOINT = "https://goggles.ipf.dev/";

export const HELP_TEXT = `Usage: marmot-opentui [options]

Options:
  --name <label>   Profile name; data + identity live in ~/.marmot-opentui/<label>/ (default: default)
  --sec <hex>      Use a specific 32-byte hex Nostr secret key.
  --ephemeral      Keep app state in memory (audit can still write when enabled).
  --audit          Enable forensic audit JSONL recording.
  --audit-path <path>
                   Write audit JSONL to this path (implies --audit).
  --audit-upload [url]
                   Upload the audit JSONL to a Goggles tracker on quit and on
                   demand (press U); implies --audit. A bare flag uses
                   https://goggles.ipf.dev/; falls back to
                   $MARMOT_AUDIT_LOG_TRACKER_ENDPOINT.
  --audit-token <token>
                   Bearer token for the tracker, required for non-loopback
                   endpoints. Falls back to $MARMOT_AUDIT_LOG_TRACKER_TOKEN.
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
  /** Goggles tracker endpoint for audit uploads; empty disables uploading. */
  auditUploadEndpoint: string;
  /** Bearer token for the tracker (required for non-loopback endpoints). */
  auditUploadToken: string;
  secOverride: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const flag = (name: string) => argv.includes(name);
  const option = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  // `--audit-upload <url>` overrides; a bare `--audit-upload` falls back to the
  // default Goggles endpoint; otherwise the env var (empty disables uploading).
  // The leading-`--` guard keeps a bare flag from swallowing the next option as
  // its URL (e.g. `--audit-upload --debug`).
  const auditUploadArg = option("--audit-upload", "");
  const auditUploadEndpoint =
    auditUploadArg && !auditUploadArg.startsWith("--")
      ? auditUploadArg
      : flag("--audit-upload")
        ? DEFAULT_GOGGLES_ENDPOINT
        : (process.env["MARMOT_AUDIT_LOG_TRACKER_ENDPOINT"] ?? "");
  return {
    label: option("--name", "default"),
    ephemeral: flag("--ephemeral"),
    logsPath: option("--logs", ""),
    // An upload target needs something to upload, so --audit-upload (like
    // --audit-path) turns recording on.
    audit:
      flag("--audit") ||
      Boolean(option("--audit-path", "")) ||
      Boolean(auditUploadEndpoint),
    auditPath: option("--audit-path", ""),
    auditUploadEndpoint,
    auditUploadToken: option(
      "--audit-token",
      process.env["MARMOT_AUDIT_LOG_TRACKER_TOKEN"] ?? "",
    ),
    debug: flag("--debug") || Boolean(option("--logs", "")),
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

function loadOrCreateDeviceId(path: string, ephemeral: boolean): string {
  if (ephemeral) return randomBytes(16).toString("hex");
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

export async function createController(
  opts: CliOptions,
  onStatus: (line: StatusLine) => void,
): Promise<MarmotController> {
  // The account only needs somewhere to bootstrap *discovery* from: it connects
  // to the defaults to read its own advertised NIP-65 outbox + kind-10050 inbox
  // relays, then publishes everything (KeyPackages, profile, relay lists) to
  // those — never back to the defaults the user never configured (see
  // MarmotController). These bootstrap relays are read-only: they are NOT a
  // publish target, and NOT where invites are watched — that follows the
  // kind-10050 inbox list.
  const bootstrapRelays = relaySet(DEFAULT_RELAYS);

  const dataDir = join(homedir(), ".marmot-opentui", opts.label);
  mkdirSync(dataDir, { recursive: true });

  // A stable per-device identifier, persisted alongside the identity so the
  // same machine reuses it across restarts. Used as the replaceable KeyPackage
  // `d` tag (so two devices under the same account don't clobber each other on
  // relays) and as the audit `engine_id` input. Ephemeral mode generates a
  // fresh one each run since nothing is persisted.
  const deviceId = loadOrCreateDeviceId(
    join(dataDir, "device-id"),
    opts.ephemeral,
  );
  const clientId = `marmot-opentui-${deviceId.slice(0, 8)}`;

  // One SQLite connection holds every key-value store for this account (groups,
  // KeyPackages, invites, messages) as separate tables. Null in ephemeral mode,
  // where each store falls back to memory and nothing touches disk.
  const db = opts.ephemeral ? null : openDatabase(join(dataDir, "state.db"));

  const keyPath = join(dataDir, "identity.key");
  const secretHex = loadOrCreateSecret(keyPath, opts.secOverride);
  const account = PrivateKeyAccount.fromKey(secretHex);
  const pubkey = await account.signer.getPublicKey();

  let audit: NodeJsonlAuditRecorder | undefined;
  let auditContext: AuditContextOptions | undefined;
  let auditLogPath: string | undefined;
  let auditUpload: AuditUploadConfig | undefined;
  if (opts.audit) {
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
        app_version: APP_VERSION,
        upload_trigger: "opentui_cli",
      },
    };
    const emitter = new AuditEmitter({ ...auditContext, sink: audit });
    emitter.emit({ type: "recorder_started", recorder: "marmot-opentui" });
    emitter.emit({ type: "source_context", source: auditContext.source! });

    // Only the non-identifying client labels become upload headers; the account
    // label stays in the JSONL rows (account_ref + the source_context row above).
    if (opts.auditUploadEndpoint) {
      auditUpload = {
        endpoint: opts.auditUploadEndpoint,
        bearerToken: opts.auditUploadToken || undefined,
        source: {
          deviceLabel: opts.label,
          platform: process.platform,
          appVersion: APP_VERSION,
        },
      };
    }
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
    // Closing the SQLite connection on stop() flushes the WAL for the next run.
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
    clientId,
    debug: opts.debug,
    auditLogPath,
    auditUpload,
    statusLog: onStatus,
  });
}
