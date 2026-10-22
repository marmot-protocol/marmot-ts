import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash, type NostrEvent } from "applesauce-core/helpers/event";
import { normalizeRelayUrl } from "applesauce-core/helpers";
import {
  normalizeToPubkey,
  npubEncode,
} from "applesauce-core/helpers/pointers";
import {
  getProfileContent,
  type ProfileContent,
} from "applesauce-core/helpers/profile";
import { relaySet } from "applesauce-core/helpers/relays";
import type { EventStore } from "applesauce-core/event-store";

import {
  createApplicationMessageIntent,
  createChatRumor,
  type GroupRumorHistory,
  type ListedKeyPackage,
  type MarmotClient,
  type MarmotGroup,
  Proposals,
  PublicationUncertainError,
  type UnreadInvite,
  type Unsubscribable,
  type WelcomeRecipient,
  prepareMediaMessage,
  downloadMediaAttachment,
  createBlossomMediaTransport,
} from "@internet-privacy/marmot-ts/client";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  getKeyPackageIdentifier,
  getKeyPackageReference,
} from "@internet-privacy/marmot-ts";
import {
  encryptedMediaBlossomDefault,
  getMediaAttachments,
  type EncryptedMediaPolicyV2,
  type MediaAttachment,
} from "@internet-privacy/marmot-ts/core";
import type { Proposal } from "@internet-privacy/marmot-ts/mls";
import {
  uploadAuditLogFile,
  type AuditLogUploadResult,
} from "@internet-privacy/marmot-ts/extra/audit/node";

import createDebug from "debug";

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { guessMediaType } from "./mime.js";
import { LOOKUP_RELAYS, type Directory } from "../helpers/discovery.js";
import type { RelayPool } from "../helpers/relay-pool.js";
import {
  groupIsAdmin,
  groupName,
  hexShort,
  npubShort,
  short,
} from "./format.js";
import {
  deriveRelayListStatus,
  describeRelayListGap,
  relayListsComplete,
  type RelayListStatus,
} from "./relay-lists.js";

/** Kind of the chat rumors {@link createChatRumor} produces (Marmot chat message). */
const CHAT_MESSAGE_KIND = 9;

/** Kind of NIP-25 reaction rumors (an emoji reaction to a chat message). */
const REACTION_KIND = 7;

/** How many of the newest reaction rumors the live window holds per group. */
const REACTION_WINDOW = 500;

/** How many of the newest messages the live history window holds per group. */
const HISTORY_WINDOW = 50;

/**
 * Fallback Blossom endpoint(s) used for attachment upload/fetch when the group
 * carries no `marmot.group.encrypted-media.v1` (`0x8008`) policy. Must be an
 * `https` host — receivers reject `http`/loopback blob locators on host-safety
 * grounds (`features/encrypted-media.md`). Admins can override the list per
 * group from the group-info modal.
 */
const DEFAULT_BLOSSOM_SERVERS = ["https://blossom.primal.net"];

/**
 * Invite ingester diagnostics — gift-wrap subscription setup, every kind-1059
 * seen (id/author/relay), ingest dedupe result, and decrypt outcome.
 * Enable with `DEBUG=opentui:invite` (opentui enables `*` by default). Pair with
 * `DEBUG=marmot-ts:*` to also see the library's `InviteManager` decrypt logs.
 */
const inviteLog = createDebug("opentui:invite");

/** Minimal signer shape (applesauce `EventSigner`) the controller needs. */
type Signer = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<NostrEvent> | NostrEvent;
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Formats a byte count as a short human-readable size (e.g. "1.4 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function codePointHex(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function normalizeRelays(relays: string[]): string[] {
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

function extensionDetails(
  extensions: { extensionType: number; extensionData: unknown }[],
): KeyPackageExtensionDetails[] {
  return extensions.map((extension) => ({
    type: codePointHex(extension.extensionType),
    dataHex:
      extension.extensionData instanceof Uint8Array
        ? hex(extension.extensionData)
        : JSON.stringify(extension.extensionData),
  }));
}

function requiredCapabilitiesDetails(
  extensions: { extensionType: number; extensionData: any }[],
): RequiredCapabilitiesDetails | null {
  const required = extensions.find(
    (extension) => extension.extensionType === 3,
  );
  if (!required) return null;
  return {
    extensionTypes: (required.extensionData.extensionTypes ?? []).map(
      codePointHex,
    ),
    proposalTypes: (required.extensionData.proposalTypes ?? []).map(
      codePointHex,
    ),
    credentialTypes: (required.extensionData.credentialTypes ?? []).map(
      codePointHex,
    ),
  };
}

function latestPublished(pkg: ListedKeyPackage): NostrEvent | null {
  return (pkg.published ?? []).reduce<NostrEvent | null>(
    (newest, event) =>
      !newest || event.created_at > newest.created_at ? event : newest,
    null,
  );
}

function publishedAt(pkg: ListedKeyPackage): number {
  return latestPublished(pkg)?.created_at ?? 0;
}

function keyPackageDetails(pkg: ListedKeyPackage): KeyPackageDetails {
  const capabilities = pkg.publicPackage.leafNode.capabilities;
  const keyPackageExtensions = extensionDetails(pkg.publicPackage.extensions);
  const leafNodeExtensions = extensionDetails(
    pkg.publicPackage.leafNode.extensions,
  );

  return {
    refHex: hex(pkg.keyPackageRef),
    used: pkg.used === true,
    publishedCount: pkg.published?.length ?? 0,
    cipherSuite: codePointHex(pkg.publicPackage.cipherSuite),
    initKeyHex: hex(pkg.publicPackage.initKey),
    signatureHex: hex(pkg.publicPackage.signature),
    capabilities: {
      versions: capabilities.versions.map(codePointHex),
      ciphersuites: capabilities.ciphersuites.map(codePointHex),
      extensions: capabilities.extensions.map(codePointHex),
      proposals: capabilities.proposals.map(codePointHex),
      credentials: capabilities.credentials.map(codePointHex),
    },
    keyPackageExtensions,
    leafNodeExtensions,
    requiredCapabilities:
      requiredCapabilitiesDetails(pkg.publicPackage.extensions as any[]) ??
      requiredCapabilitiesDetails(
        pkg.publicPackage.leafNode.extensions as any[],
      ),
  };
}

/**
 * Where (and how) to upload this device's audit JSONL. Set when the user passes
 * `--audit-upload`; absent leaves {@link MarmotController.uploadAuditLog} a no-op.
 * Account identity is NOT sent here — it lives in the JSONL rows; only the
 * non-identifying client labels travel as `X-Goggles-*` headers.
 */
export interface AuditUploadConfig {
  /** Goggles tracker endpoint (https, or loopback http for local testing). */
  endpoint: string;
  /** Bearer token; required for non-loopback endpoints. */
  bearerToken?: string;
  /** Non-identifying client labels sent as `X-Goggles-*` headers. */
  source?: { deviceLabel?: string; platform?: string; appVersion?: string };
}

export interface MarmotControllerOptions {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  /** Shared reactive event cache; also exposed to React for `useProfile`. */
  eventStore: EventStore;
  signer: Signer;
  pubkey: string;
  /**
   * Bootstrap/discovery relays — where the account reads its own advertised
   * relay lists from on startup. Read-only: never a publish target. The account
   * starts with *unknown* operating relays and discovers them before publishing,
   * so it never publishes to the bootstrap defaults.
   */
  relays: string[];
  /** This device's key-package slot (`d` tag / clientId). */
  clientId: string;
  /** When true, error logs include the full stack trace and cause chain. */
  debug: boolean;
  /** Audit JSONL output path when forensic recording is enabled. */
  auditLogPath?: string;
  /** Goggles upload target for the audit JSONL; absent disables uploading. */
  auditUpload?: AuditUploadConfig;
  /** Optional sink for status lines when the UI has no on-screen log panel. */
  statusLog?: (line: StatusLine) => void;
  /**
   * Optional teardown hook run on {@link MarmotController.stop}, e.g. to close
   * the SQLite connection and flush its WAL.
   */
  dispose?: () => void;
}

/** A single decrypted chat message rendered in the timeline. */
export interface ChatMessage {
  id: string;
  groupId: string;
  authorPubkey: string;
  /** A short, human label for the author ("you" or a truncated npub). */
  authorLabel: string;
  content: string;
  createdAt: number;
  /** True when this client authored the message (local echo). */
  mine: boolean;
  /**
   * The rumor id of the message this one replies to, parsed from the NIP-C7
   * `q` tag. Undefined for top-level messages.
   */
  replyToId?: string;
  /** The pubkey of the replied-to author, from the `q` tag (index 3). */
  replyToPubkey?: string;
  /**
   * Emoji reactions to this message, aggregated per emoji (NIP-25 kind 7
   * rumors). Empty/undefined when nobody has reacted.
   */
  reactions?: ReactionSummary[];
  /**
   * Encrypted-media attachments carried on this message as `imeta` tags. The
   * stable display fields are parsed from the tag; the live `status`/`data`
   * fetch state is overlaid during timeline projection. Undefined when the
   * message has no attachments.
   */
  attachments?: ChatAttachment[];
}

/** Fetch/decrypt lifecycle of a single attachment blob. */
export type AttachmentStatus = "pending" | "fetching" | "ready" | "error";

/** A single encrypted-media attachment as rendered in the timeline. */
export interface ChatAttachment {
  /** `ciphertextSha256` — the stable blob id and cache key. */
  id: string;
  /** Display filename from the `imeta` tag. */
  filename: string;
  /** Canonical media (MIME) type from the `imeta` tag. */
  mediaType: string;
  /** Optional `<width>x<height>` render hint. */
  dim?: string;
  /** Where this blob is in its fetch+decrypt lifecycle. */
  status: AttachmentStatus;
  /** Decrypted plaintext bytes, present once `status` is `"ready"`. */
  data?: Uint8Array;
  /** Plaintext size in bytes, once known. */
  size?: number;
  /** Human-readable failure reason when `status` is `"error"`. */
  error?: string;
}

/** Internal per-blob fetch record, keyed by `ciphertextSha256`. */
interface MediaFetchRecord {
  /** The parsed attachment reference (locators + hashes + metadata). */
  attachment: MediaAttachment;
  status: AttachmentStatus;
  data?: Uint8Array;
  error?: string;
}

/** One emoji's worth of reactions on a message, aggregated across reactors. */
export interface ReactionSummary {
  /** The reaction emoji (the kind 7 rumor `content`). */
  emoji: string;
  /** Number of distinct members who reacted with this emoji. */
  count: number;
  /** True when this client is one of the reactors. */
  mine: boolean;
}

/** A single decoded reaction rumor, indexed by its own rumor id. */
interface ReactionRecord {
  /** The id of the message this reaction targets (the `e` tag). */
  targetId: string;
  /** The reaction emoji (rumor `content`). */
  emoji: string;
  /** The reactor's pubkey. */
  pubkey: string;
}

/** Per-group state for loading older (off-window) messages on demand. */
export interface PaginationState {
  /** True while an older page is being loaded. */
  loadingOlder: boolean;
  /** True once the oldest stored message has been reached. */
  exhausted: boolean;
}

export interface StatusLine {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
  at: number;
}

/**
 * This client's single KeyPackage (the one in its `clientId` slot) plus the
 * KeyPackages the account's other devices have published to its outbox relays.
 */
export interface KeyPackageSummary {
  /** This client's KeyPackage, or null before one has been published. */
  current: KeyPackageDetails | null;
  /** When this client's KeyPackage was last published (seconds), if known. */
  publishedAt: number | null;
  /** Event id (hex) of this client's latest published KeyPackage, if any. */
  publishedId: string | null;
  /** The newest KeyPackage per other-device slot, newest first. */
  otherDevices: DeviceKeyPackage[];
  /** True while the other devices' KeyPackages are being fetched. */
  otherDevicesLoading: boolean;
}

/** Another device's published KeyPackage (kind 30443) for this account. */
export interface DeviceKeyPackage {
  /** The device's addressable slot (`d` tag). */
  slot: string;
  eventId: string;
  createdAt: number;
  /** The KeyPackageRef (`i` tag) hex, if present. */
  refHex: string | null;
}

export interface KeyPackageExtensionDetails {
  type: string;
  dataHex: string;
}

export interface RequiredCapabilitiesDetails {
  extensionTypes: string[];
  proposalTypes: string[];
  credentialTypes: string[];
}

export interface KeyPackageDetails {
  refHex: string;
  used: boolean;
  publishedCount: number;
  cipherSuite: string;
  initKeyHex: string;
  signatureHex: string;
  capabilities: {
    versions: string[];
    ciphersuites: string[];
    extensions: string[];
    proposals: string[];
    credentials: string[];
  };
  keyPackageExtensions: KeyPackageExtensionDetails[];
  leafNodeExtensions: KeyPackageExtensionDetails[];
  requiredCapabilities: RequiredCapabilitiesDetails | null;
}

/**
 * One of an invitee's published KeyPackage events (kind 30443), annotated with
 * whether it can be added to the active group. One invitee can publish several
 * (one per device/slot); the invite UI lists them so an admin can choose which
 * device(s) to add.
 */
export interface InviteCandidate {
  /** The KeyPackage event id (stable selection key). */
  id: string;
  /** The raw KeyPackage event, handed back to {@link MarmotController.inviteKeyPackages}. */
  event: NostrEvent;
  /** Event `created_at` (seconds); the list is sorted newest-first. */
  createdAt: number;
  /** The addressable slot (`d` tag) identifying the publishing device, if any. */
  deviceId: string | null;
  /** The KeyPackageRef (`i` tag) hex, if present. */
  refHex: string | null;
  /** The KeyPackage's MLS cipher suite, hex. */
  cipherSuite: string;
  /** True when the KeyPackage satisfies every group add requirement. */
  invitable: boolean;
  /** True when this KeyPackage's account is already a group member. */
  alreadyMember: boolean;
  /** Human-readable reasons the KeyPackage is not invitable (empty when it is). */
  reasons: string[];
}

/** The invitee's KeyPackages resolved against a specific group. */
export interface InviteCandidates {
  pubkey: string;
  npub: string;
  /** The group these candidates were evaluated against (hex id). */
  groupId: string;
  groupName: string;
  candidates: InviteCandidate[];
}

/**
 * An unread invite annotated with whether we can actually act on it. `joinable`
 * is true iff we still hold the target KeyPackage the Welcome is addressed to;
 * non-joinable invites are hidden by default but can be revealed in the panel
 * (e.g. to confirm an invite arrived even if its KeyPackage has since rotated).
 */
export interface InviteEntry {
  invite: UnreadInvite;
  joinable: boolean;
}

/** Decrypted group metadata previewed from a Welcome before joining. */
export interface InvitePreviewGroup {
  name: string;
  description: string;
  adminPubkeys: string[];
  relays: string[];
}

/**
 * Everything we can surface about an invite *before* committing to join it —
 * see {@link MarmotController.previewInvite}. Rumor-level fields decode without
 * key material; `group` requires decrypting the Welcome with our matching
 * KeyPackage and is null when we don't hold it or the decode fails.
 */
export interface InvitePreview {
  /** Group relay URLs from the Welcome's `relays` tag. */
  relays: string[];
  /** Kind-30443 KeyPackage event id this Welcome consumed, if tagged. */
  keyPackageEventId?: string;
  /** MLS cipher suite id from the Welcome struct. */
  cipherSuite?: number;
  /** Number of recipients the Welcome targets. */
  recipientCount?: number;
  /** Group epoch from the previewed GroupInfo. */
  epoch?: bigint;
  /** Decrypted group metadata, or null when unavailable. */
  group: InvitePreviewGroup | null;
}

/**
 * Immutable snapshot consumed by React via `useSyncExternalStore`. The group
 * and invite lists are intentionally NOT here: the React layer reads those
 * straight from the library's `groups.watch()` / `invites.watchUnread()` async
 * generators. This snapshot carries only what those generators cannot express —
 * the decrypted message timeline, status log, active selection, and busy flag.
 */
/** Lifecycle state of the most recent audit-log upload attempt. */
export type AuditUploadState = "uploading" | "success" | "failed";

/** Audit-log upload status surfaced to the UI (see {@link MarmotController}). */
export interface AuditStatus {
  /** True when forensic recording *and* an upload endpoint are configured. */
  enabled: boolean;
  /** Upload endpoint, or null when uploading isn't configured. */
  endpoint: string | null;
  /** State of the latest attempt; null when none has run yet. */
  state: AuditUploadState | null;
  /** Unix seconds of the last state transition; null when none yet. */
  updatedAt: number | null;
  /** Bytes sent by the last successful upload. */
  bytesSent: number | null;
  /** HTTP status of the last successful upload. */
  httpStatus: number | null;
  /** Error message from the last failed upload. */
  error: string | null;
}

export interface ChatSnapshot {
  me: { pubkey: string; npub: string };
  relays: string[];
  connectedRelayCount: number;
  /** The account's advertised NIP-65 outbox relays (kind 10002). */
  outboxRelays: string[];
  /** The account's advertised inbox relays for welcomes (kind 10050). */
  inboxRelays: string[];
  /** Discovery state of the account's 10002/10050 relay lists. */
  relayListStatus: RelayListStatus;
  /**
   * Increments each time the controller needs the user to set up relay
   * lists; the UI opens the relay editor when this increases. 0 means it has
   * never been requested.
   */
  relaySetupRequest: number;
  keyPackages: KeyPackageSummary;
  clientId: string;
  activeGroupId: string | null;
  /** Messages keyed by group id (hex). */
  messages: Record<string, ChatMessage[]>;
  /** Older-message pagination state keyed by group id (hex). */
  pagination: Record<string, PaginationState>;
  status: StatusLine[];
  /** True while a long-running action (invite/join/create) is in flight. */
  busy: boolean;
  /** Audit-log upload status (enabled flag + latest attempt). */
  audit: AuditStatus;
}

type Listener = () => void;

/**
 * Headless driver for the marmot-ts chat lifecycle. It owns every imperative
 * side effect — publishing identity, restoring groups, subscribing to relays,
 * and draining the {@link MarmotGroup.ingest} async generator — and exposes the
 * decrypted timeline as an immutable {@link ChatSnapshot} that React subscribes
 * to via `useSyncExternalStore`.
 *
 * The React layer consumes the library's own async generators
 * (`client.groups.watch()`, `client.invites.watchUnread()`) directly for the
 * group and invite lists; this controller is the imperative counterpart those
 * generators cannot express (relay I/O, per-group ingest, local echo).
 */
export class MarmotController {
  readonly #client: MarmotClient;
  readonly #pool: RelayPool;
  readonly #directory: Directory;
  readonly #eventStore: EventStore;
  readonly #signer: Signer;
  readonly #pubkey: string;
  readonly #relays: string[];
  readonly #clientId: string;
  readonly #debug: boolean;
  readonly #auditLogPath?: string;
  readonly #auditUpload?: AuditUploadConfig;
  /** Latest audit-upload attempt; mirrored into the snapshot. */
  #auditState: AuditUploadState | null = null;
  #auditUpdatedAt: number | null = null;
  #auditBytesSent: number | null = null;
  #auditHttpStatus: number | null = null;
  #auditError: string | null = null;
  readonly #statusLog?: (line: StatusLine) => void;
  readonly #dispose?: () => void;

  readonly #groups = new Map<string, MarmotGroup>();
  readonly #bound = new Set<string>();
  /** Per-group rumor union (id → message), the source of the rendered timeline. */
  readonly #messageIndex = new Map<string, Map<string, ChatMessage>>();
  /** The rendered, oldest-first timeline projected from {@link #messageIndex}. */
  readonly #messages = new Map<string, ChatMessage[]>();
  /** Live `history.subscribe()` generators, one per attached group. */
  readonly #historySubs = new Map<string, AsyncGenerator<Rumor[]>>();
  /** Per-group reaction union (reaction rumor id → record). */
  readonly #reactionIndex = new Map<string, Map<string, ReactionRecord>>();
  /** Live reaction `history.subscribe()` generators, one per attached group. */
  readonly #reactionSubs = new Map<string, AsyncGenerator<Rumor[]>>();
  /**
   * Per-group attachment-blob fetch state (`ciphertextSha256` → record). Media
   * references arrive on the kind-9 message itself, so no extra subscription is
   * needed; this index holds the async fetch+decrypt state overlaid onto each
   * message during projection, the way {@link #reactionIndex} holds reactions.
   */
  readonly #mediaIndex = new Map<string, Map<string, MediaFetchRecord>>();
  /** Lazily-built fallback media policy (see {@link DEFAULT_BLOSSOM_SERVERS}). */
  #defaultMediaPolicyCache?: EncryptedMediaPolicyV2;
  /** Older-message pagination state, one per group id. */
  readonly #pagination = new Map<string, PaginationState>();

  readonly #listeners = new Set<Listener>();

  #status: StatusLine[] = [];
  #activeId: string | null = null;
  #keyPackages: KeyPackageSummary = {
    current: null,
    publishedAt: null,
    publishedId: null,
    otherDevices: [],
    otherDevicesLoading: false,
  };
  /**
   * Advertised NIP-65 outbox list (kind 10002) — the user's own write relays,
   * where their KeyPackages/profile/relay-lists are published and discovered.
   * Empty (unknown) until {@link #loadRelayLists} resolves it.
   */
  #outboxRelays: string[] = [];
  /** Advertised inbox list for welcomes (kind 10050); resolved like {@link #outboxRelays}. */
  #inboxRelays: string[] = [];
  #busy = false;
  #statusSeq = 0;

  /** True once a discovery pass has settled (successfully or not) at least once. */
  #relayListsAttempted = false;
  /**
   * True once the user has saved relay lists this session (R2/R3) — a stale
   * background discovery pass must not overwrite them afterwards.
   */
  #relayListsAuthoritative = false;
  /** In-flight {@link #loadRelayLists}, so the background load and an on-demand
   * publish share one discovery pass instead of racing two. */
  #relayListsPromise?: Promise<void>;
  /** Counter mirrored onto {@link ChatSnapshot.relaySetupRequest}. */
  #relaySetupRequest = 0;

  #watchAbort = false;
  /** Library-owned inbound transport: group subscriptions (connectAll). */
  #groupsConnection?: Unsubscribable;
  /** Library-owned inbound transport: gift-wrap invite listener. */
  #inviteConnection?: Unsubscribable;

  /** Cached snapshot; replaced (new reference) on every mutation. */
  #snapshot: ChatSnapshot;

  constructor(options: MarmotControllerOptions) {
    this.#client = options.client;
    this.#pool = options.pool;
    this.#directory = options.directory;
    this.#eventStore = options.eventStore;
    this.#signer = options.signer;
    this.#pubkey = options.pubkey;
    this.#relays = options.relays;
    this.#clientId = options.clientId;
    this.#debug = options.debug;
    this.#auditLogPath = options.auditLogPath;
    this.#auditUpload = options.auditUpload;
    this.#statusLog = options.statusLog;
    this.#dispose = options.dispose;
    // The account starts with *unknown* operating relays — NOT the bootstrap
    // defaults — and adopts its published NIP-65 outbox + kind-10050 inbox once
    // #loadRelayLists resolves them, so we never publish the user's events to a
    // default relay they never configured.
    this.#snapshot = this.#buildSnapshot();
  }

  // --- React store interface -------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ChatSnapshot => this.#snapshot;

  get client(): MarmotClient {
    return this.#client;
  }

  /** Shared reactive event cache, consumed by the React `useProfile` hook. */
  get eventStore(): EventStore {
    return this.#eventStore;
  }

  /** True when an audit log is being recorded *and* an upload target is set. */
  get canUploadAudit(): boolean {
    return Boolean(this.#auditLogPath && this.#auditUpload);
  }

  /**
   * Upload this device's audit JSONL to the configured Goggles tracker. A no-op
   * (returns null) when auditing or an upload endpoint isn't configured. The
   * {@link NodeJsonlAuditRecorder} appends synchronously, so the on-disk file is
   * always current — no flush/close is needed before reading it here, which is
   * why this is safe to call repeatedly while the app runs and again on quit.
   * Best-effort: any failure is logged and swallowed.
   */
  async uploadAuditLog(): Promise<AuditLogUploadResult | null> {
    if (!this.#auditLogPath || !this.#auditUpload) return null;
    this.#setAuditState("uploading");
    try {
      this.log(`uploading audit log to ${this.#auditUpload.endpoint}…`);
      const result = await uploadAuditLogFile(
        this.#auditLogPath,
        this.#auditUpload.endpoint,
        {
          bearerToken: this.#auditUpload.bearerToken,
          source: this.#auditUpload.source,
        },
      );
      this.log(
        `uploaded audit log — ${result.bytesSent} bytes, HTTP ${result.status}`,
      );
      this.#setAuditState("success", {
        bytesSent: result.bytesSent,
        httpStatus: result.status,
      });
      return result;
    } catch (err) {
      this.logError(err);
      this.#setAuditState("failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Record an audit-upload transition and re-publish the snapshot. */
  #setAuditState(
    state: AuditUploadState,
    extra: { bytesSent?: number; httpStatus?: number; error?: string } = {},
  ): void {
    this.#auditState = state;
    this.#auditUpdatedAt = Math.floor(Date.now() / 1000);
    this.#auditError = state === "failed" ? (extra.error ?? null) : null;
    if (extra.bytesSent !== undefined) this.#auditBytesSent = extra.bytesSent;
    if (extra.httpStatus !== undefined)
      this.#auditHttpStatus = extra.httpStatus;
    this.#publish();
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#ensureKeyPackage();
    if (this.#watchAbort) return;
    await this.#restoreGroups();
    if (this.#watchAbort) return;
    // The library owns inbound transport now: connectAll subscribes every group
    // to its kind-445 events (backfill + live, draining ingest), and invites
    // listen() subscribes for gift-wraps on our inbox relays. #watchGroups stays
    // for app-side bookkeeping (stateChanged → snapshot, history projection).
    this.#client.groups.on("unreadable", () =>
      this.log("(dropped an unreadable group event)", "warn"),
    );
    this.#groupsConnection = this.#client.groups.connectAll({
      fallbackRelays: this.#relays,
    });
    this.#relistenInvites();
    void this.#watchGroups();
    this.log(`ready — you are ${npubEncode(this.#pubkey)}`);
    this.log(`bootstrap relays: ${this.#relays.join(", ")}`);
    if (this.#auditLogPath) this.log(`audit log: ${this.#auditLogPath}`);
    // Discover the account's advertised relays in the background so the invite
    // subscription and future publishes follow the user's own relays, never the
    // bootstrap defaults. (#ensureKeyPackage already awaited this above if it
    // needed to publish a KeyPackage.)
    void this.#ensureRelayListsLoaded().catch((err) => {
      if (!this.#watchAbort) this.logError(err);
    });
  }

  stop(): void {
    if (this.#watchAbort) return;
    this.#watchAbort = true;
    this.#inviteConnection?.unsubscribe();
    this.#groupsConnection?.unsubscribe();
    for (const gen of this.#historySubs.values()) void gen.return(undefined);
    this.#historySubs.clear();
    for (const gen of this.#reactionSubs.values()) void gen.return(undefined);
    this.#reactionSubs.clear();
    // Tear down the EventStore before the pool: dispose() drops the attached
    // event loader (its batching timers + in-flight warm relay requests) and
    // the model keep-warm timers, then pool.close() shuts the relay sockets and
    // their keepAlive/liveness timers. Together these let the process exit on
    // its own — no residual-timer unref workaround needed.
    this.#eventStore.dispose();
    this.#pool.close();
    this.#dispose?.();
  }

  // --- actions ---------------------------------------------------------------

  setActive(idStr: string): void {
    if (!this.#groups.has(idStr)) return;
    this.#activeId = idStr;
    this.#publish();
  }

  async createGroup(name: string, relays: string[]): Promise<void> {
    await this.#withBusy(async () => {
      const groupRelays = normalizeRelays(relays);
      if (!groupRelays.length)
        throw new Error(
          "group needs at least one relay — enter relays manually, or press r to set up your relay lists",
        );
      const group = await this.#client.groups.create(name, {
        relays: groupRelays,
        encryptedMedia: this.#defaultMediaPolicy(),
      });
      this.#attachGroup(group);
      this.#activeId = group.idStr;
      this.log(
        `created "${name}" (${short(group.idStr)}) on ${groupRelays.join(", ")} — now active`,
      );
    });
  }

  /**
   * Resolves an invitee's published KeyPackages and annotates each with whether
   * it can be added to the active group. The invite UI lists the result (newest
   * first) so an admin can choose which device(s) to invite; nothing is sent
   * here. Returns `null` (and logs) on any failure so the caller can simply skip
   * opening the selection modal. `onProgress` receives a short description of
   * each lookup step so the invite modal can show what it is waiting on.
   */
  async loadInviteCandidates(
    input: string,
    onProgress?: (step: string) => void,
  ): Promise<InviteCandidates | null> {
    if (this.#watchAbort) return null;
    this.#busy = true;
    this.#publish();
    try {
      const group = this.#requireActive();
      let pubkeyHex = normalizeToPubkey(input);
      let nip05Relays: string[] = [];
      if (!pubkeyHex) {
        if (!input.includes("@")) {
          throw new Error(
            `invalid pubkey, npub, or NIP-05 identifier: ${input}`,
          );
        }
        onProgress?.(`resolving ${input}…`);
        const identity = await this.#directory.resolveNip05(input);
        pubkeyHex = identity.pubkey;
        nip05Relays = normalizeRelays(identity.relays);
        this.log(`resolved ${input} to ${npubShort(pubkeyHex)}`);
      }

      // Discover the invitee's NIP-65 (kind 10002) outbox relays — where they
      // publish their KeyPackages. Hints include LOOKUP_RELAYS alongside the
      // NIP-05/session relays (mirroring #loadRelayLists): the applesauce
      // address loader queries pointer hints before its extras→lookup
      // fallback chain, so hinting the well-known indexers lets an invitee
      // whose relay list lives only there resolve inside Directory's 10s
      // window instead of timing out and falling back to NIP-05/session
      // relays.
      this.log(`discovering KeyPackages for ${npubShort(pubkeyHex)}…`);
      onProgress?.(`finding outbox/inbox relays for ${npubShort(pubkeyHex)}…`);
      // The 10050 inbox lookup runs alongside the outbox one so the Welcome
      // delivery that follows a successful invite finds it already cached.
      const lookupHints = relaySet(nip05Relays, this.#relays, LOOKUP_RELAYS);
      const [discovered] = await Promise.all([
        this.#directory.outboxes(pubkeyHex, lookupHints),
        this.#directory
          .welcomeInboxes(pubkeyHex, lookupHints)
          .catch(() => [] as string[]),
      ]);
      this.log(
        discovered.length
          ? `NIP-65 outbox: ${discovered.join(", ")}`
          : `no NIP-65 outbox relays found; using NIP-05/session relays`,
      );
      const searchRelays = relaySet(nip05Relays, discovered, this.#relays);
      this.log(`fetching KeyPackages from ${searchRelays.join(", ")}`);
      onProgress?.(
        `fetching KeyPackages from ${searchRelays.length} relay(s)…`,
      );
      // KeyPackages are public: decline authentication for this lookup.
      // Other operations on the same connection can authenticate independently;
      // an auth refusal here fails only this relay's request.
      const kps = await this.#pool.request(
        searchRelays,
        {
          kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
          authors: [pubkeyHex],
        },
        { waitForAuth: false },
      );
      if (!kps.length) {
        throw new Error(`no KeyPackage found for ${npubShort(pubkeyHex)}`);
      }

      const candidates = kps
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .map((event) => this.#describeCandidate(group, event));
      const invitable = candidates.filter((c) => c.invitable).length;
      this.log(
        `found ${candidates.length} KeyPackage(s) for ${npubShort(pubkeyHex)} — ${invitable} invitable to "${groupName(group)}"`,
      );
      return {
        pubkey: pubkeyHex,
        npub: npubEncode(pubkeyHex),
        groupId: group.idStr,
        groupName: groupName(group),
        candidates,
      };
    } catch (err) {
      this.logError(err);
      return null;
    } finally {
      this.#busy = false;
      this.#publish();
    }
  }

  /**
   * Adds the selected KeyPackages to the group in a single commit and delivers a
   * Welcome to each. Multiple KeyPackages (e.g. several of the invitee's devices)
   * become individual Add proposals in one epoch advance.
   */
  async inviteKeyPackages(
    groupId: string,
    events: NostrEvent[],
  ): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#groups.get(groupId);
      if (!group) throw new Error("group is not loaded");
      if (!events.length) throw new Error("no key packages selected");

      const recipients: WelcomeRecipient[] = events.map((event) => ({
        pubkey: event.pubkey,
        keyPackageEventId: event.id,
        keyPackageEvent: event,
      }));
      await this.#client.groups.commit(group.id, {
        extraProposals: events.map((event) =>
          Proposals.proposeInviteUser(event),
        ),
        welcomeRecipients: recipients,
      });
      this.log(
        `invited ${events.length} key package(s) to "${groupName(group)}" — welcome(s) delivered`,
      );
    });
  }

  /**
   * Evaluates one KeyPackage event against the group's add requirements, using
   * the library's {@link MarmotGroup.evaluateKeyPackage} eligibility engine and
   * layering on the display-only fields (device slot, ref, hex cipher suite).
   */
  #describeCandidate(group: MarmotGroup, event: NostrEvent): InviteCandidate {
    const eligibility = group.evaluateKeyPackage(event);
    return {
      id: event.id,
      event,
      createdAt: event.created_at,
      deviceId: getKeyPackageIdentifier(event) ?? null,
      refHex: getKeyPackageReference(event) ?? null,
      cipherSuite:
        eligibility.cipherSuite < 0
          ? "?"
          : codePointHex(eligibility.cipherSuite),
      invitable: eligibility.eligible,
      alreadyMember: eligibility.alreadyMember,
      reasons: eligibility.reasons,
    };
  }

  async joinInvite(inviteId: string): Promise<void> {
    await this.#withBusy(async () => {
      const unread = await this.#client.invites.getUnread();
      const rumor = unread.find((entry) => entry.id === inviteId);
      if (!rumor) throw new Error("invite not found (already accepted?)");
      const { group } = await this.#client.joinGroupFromWelcome({
        welcomeRumor: rumor,
      });
      await this.#client.invites.markAsRead(rumor.id);
      this.#attachGroup(group);
      this.#activeId = group.idStr;
      this.log(`joined "${groupName(group)}" — now active`);
    });
  }

  /**
   * Decode everything we can show about an invite *before* committing to join.
   * The rumor-level fields (relays, KeyPackage event id, cipher suite, recipient
   * count) decode synchronously; the `group` block requires decrypting the
   * Welcome with our matching KeyPackage via {@link MarmotClient.readInviteGroupInfo}
   * and is null when we don't hold it. Never throws — a malformed Welcome or a
   * failed preview just yields the fields it could read.
   */
  async previewInvite(invite: UnreadInvite): Promise<InvitePreview> {
    return this.#client.previewWelcome(invite);
  }

  /**
   * Dismiss an invite without joining: drop it from the unread list so it stops
   * showing in the panel. Reuses the library's `markAsRead` primitive — the same
   * call {@link joinInvite} makes after a successful join — minus the join. The
   * dedupe index is preserved, so a dismissed invite won't be re-ingested.
   */
  async dismissInvite(inviteId: string): Promise<void> {
    try {
      await this.#client.invites.markAsRead(inviteId);
      this.log("invite dismissed");
    } catch (err) {
      this.logError(err);
    }
  }

  /**
   * Like the library's `invites.watchUnread()`, but annotates each invite with
   * whether its target KeyPackage we still hold — accepting one we don't would
   * fail with "No matching KeyPackage found" (see {@link joinInvite}). The UI
   * defaults to showing only `joinable` entries, but can reveal the rest so the
   * user can confirm an invite arrived even after its KeyPackage rotated away.
   */
  async *watchInvites(): AsyncGenerator<InviteEntry[]> {
    yield* this.#client.watchInvites();
  }

  async leave(): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#requireActive();
      this.log(
        "⚠ leave sends a plain MLS Remove; spec peers expect SelfRemove (gap B6) — divergent",
        "warn",
      );
      await this.#client.groups.leave(group.id);
      this.#detachGroup(group.idStr);
      if (this.#activeId === group.idStr) {
        this.#activeId = [...this.#groups.keys()][0] ?? null;
      }
      this.log("left group");
    });
  }

  async updateGroupInfo(
    groupId: string,
    fields: {
      name: string;
      description: string;
      /**
       * Replacement Blossom blob endpoints for the group's
       * `marmot.group.encrypted-media.v1` policy. Empty leaves the existing
       * policy untouched (the component may be required and can't be dropped).
       */
      blossomServers?: string[];
    },
  ): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#groups.get(groupId);
      if (!group) throw new Error("group is not loaded");
      if (!groupIsAdmin(group, this.#pubkey)) {
        throw new Error("only group admins can update group info");
      }

      const metadata: Proposals.UpdateGroupMetadata = {
        name: fields.name,
        description: fields.description,
      };
      if (fields.blossomServers && fields.blossomServers.length > 0) {
        // Re-encode the whole media policy with the new endpoints; the codec
        // validates + normalizes each URL (https, safe host) and throws on a
        // bad entry, which #withBusy surfaces to the status log.
        metadata.encryptedMedia = encryptedMediaBlossomDefault(
          fields.blossomServers,
        );
      }

      // proposeUpdateMetadata emits one proposal per changed component (group
      // profile, and encrypted-media when servers changed) — commit them all.
      const proposals = await Proposals.proposeUpdateMetadata(metadata)(
        group.session.proposalContext(),
      );
      if (!proposals.length) return;
      await this.#client.groups.commit(group.id, {
        extraProposals: proposals,
      });
      this.log(`updated group info for "${fields.name}"`);
    });
  }

  /**
   * Promotes or demotes a member in the group's admin set. The next set is
   * computed from the current view so callers only express intent (`makeAdmin`),
   * and the change rides the same `app_data_update` commit path as
   * {@link updateGroupInfo}. Admins only; refuses to demote the last admin.
   */
  async setMemberAdmin(
    groupId: string,
    pubkey: string,
    makeAdmin: boolean,
  ): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#groups.get(groupId);
      if (!group) throw new Error("group is not loaded");
      if (!groupIsAdmin(group, this.#pubkey)) {
        throw new Error("only group admins can change admins");
      }
      const current = group.groupData?.adminPubkeys ?? [];
      if (makeAdmin === current.includes(pubkey)) return; // already in/out
      const next = makeAdmin
        ? [...current, pubkey]
        : current.filter((key) => key !== pubkey);
      if (next.length === 0) {
        throw new Error("cannot demote the last admin");
      }

      const [proposal] = await Proposals.proposeUpdateMetadata({
        adminPubkeys: next,
      })(group.session.proposalContext());
      if (!proposal) return;
      try {
        await this.#client.groups.commit(group.id, {
          extraProposals: [proposal],
        });
      } catch (error) {
        if (!(error instanceof PublicationUncertainError)) throw error;
        this.log(
          "commit acknowledgement lost; retrying the original signed commit",
        );
        await group.retryPendingPublication();
      }
      if (group.lifecycle === "PendingPublish")
        await group.retryPendingPublication();
      if (
        makeAdmin !== (group.groupData?.adminPubkeys.includes(pubkey) ?? false)
      ) {
        throw new Error(
          "Admin commit has not been applied locally; retry pending publication before changing roles again",
        );
      }
      this.log(
        `${makeAdmin ? "promoted" : "demoted"} ${npubShort(pubkey)} ${makeAdmin ? "to" : "from"} admin`,
      );
    });
  }

  /**
   * Removes a member — every device/leaf they hold — from the group in a single
   * commit. If they were an admin, the admin set is updated in the same commit so
   * the policy component never names a non-member. Admins only; use
   * {@link leave} to remove yourself.
   */
  async removeMember(groupId: string, pubkey: string): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#groups.get(groupId);
      if (!group) throw new Error("group is not loaded");
      if (!groupIsAdmin(group, this.#pubkey)) {
        throw new Error("only group admins can remove members");
      }
      if (pubkey === this.#pubkey) {
        throw new Error("use leave to remove yourself");
      }

      const context = group.session.proposalContext();
      const extraProposals: Proposal[] =
        await Proposals.proposeRemoveUser(pubkey)(context);
      if (!extraProposals.length) return;

      const current = group.groupData?.adminPubkeys ?? [];
      if (current.includes(pubkey)) {
        const [metadata] = await Proposals.proposeUpdateMetadata({
          adminPubkeys: current.filter((key) => key !== pubkey),
        })(context);
        if (metadata) extraProposals.push(metadata);
      }

      await this.#client.groups.commit(group.id, { extraProposals });
      this.log(`removed ${npubShort(pubkey)} from "${groupName(group)}"`);
    });
  }

  /**
   * Send a chat message to the active group. When `replyTo` is provided, the
   * outgoing kind 9 rumor carries a NIP-C7 `q` tag quoting that message:
   * `["q", <id>, <relay-url>, <pubkey>]`. The relay-url is empty because the
   * rumor travels over MLS rather than a relay.
   */
  async sendText(text: string, replyTo?: ChatMessage): Promise<void> {
    const group = this.#requireActive();
    const pubkey = await group.signer.getPublicKey();
    const tags = replyTo
      ? [["q", replyTo.id, "", replyTo.authorPubkey]]
      : undefined;
    const rumor = createChatRumor({ pubkey, content: text, tags });
    const intent = createApplicationMessageIntent(rumor);
    // `send` saves the rumor to group.history, which the per-group
    // history.subscribe() loop projects into the timeline — including this
    // self-sent message — so no manual local echo is needed here.
    await this.#client.groups.send(group.id, intent);
  }

  /**
   * Send a file to the active group as an encrypted-media attachment.
   *
   * The library derives a per-file key from the group's MLS exporter, encrypts
   * with ChaCha20-Poly1305, and hands back the ciphertext plus a populated
   * {@link MediaAttachment} (no locators). We upload the ciphertext to the
   * group's Blossom endpoint, attach the resulting `blossom-v1` locator, and
   * carry the attachment as an `imeta` tag on an otherwise-normal kind-9 rumor.
   * The plaintext is seeded into the media cache so our own send renders
   * instantly without a round-trip (`features/encrypted-media.md`).
   */
  async sendFile(path: string, replyTo?: ChatMessage): Promise<void> {
    const group = this.#requireActive();
    const filename = basename(path);
    const fileBytes = new Uint8Array(await readFile(path));
    const mediaType = guessMediaType(filename);

    const tags: string[][] = replyTo
      ? [["q", replyTo.id, "", replyTo.authorPubkey]]
      : [];
    const prepared = await prepareMediaMessage(
      group,
      [
        {
          blob: new Blob([fileBytes], { type: mediaType }),
          metadata: { filename, type: mediaType },
        },
      ],
      {
        transport: createBlossomMediaTransport({ signer: group.signer }),
        tags,
      },
    );
    await this.#client.groups.send(group.id, prepared.intent);
    this.log(`sent ${filename}`);
  }

  /**
   * Writes a message's downloaded attachments to disk (one file per ready
   * attachment) in `destDir` (default: the process working directory). Skips
   * attachments still downloading or failed. Returns the paths written; throws
   * when the message has no ready attachment to save.
   */
  async saveMessageAttachments(
    message: ChatMessage,
    destDir?: string,
  ): Promise<string[]> {
    const ready = (message.attachments ?? []).filter(
      (a): a is ChatAttachment & { data: Uint8Array } =>
        a.status === "ready" && a.data !== undefined,
    );
    if (ready.length === 0) {
      throw new Error("no downloaded attachment on this message to save");
    }
    const dir = destDir ?? process.cwd();
    const written: string[] = [];
    for (const attachment of ready) {
      const target = join(dir, basename(attachment.filename));
      await writeFile(target, attachment.data);
      this.log(`saved ${attachment.filename} → ${target}`);
      written.push(target);
    }
    return written;
  }

  /**
   * React to a chat message with an emoji. Sends a NIP-25 kind 7 rumor that
   * targets the message with an `e` tag (`["e", <id>, "", <author>]`), names the
   * author with a `p` tag, records the reacted-to kind with a `k` tag, and
   * carries the emoji as its `content`. Like {@link sendText}, the rumor is saved
   * to `group.history`, where the reaction subscription projects it back onto the
   * message — so the reactor sees their own reaction with no manual echo.
   */
  async sendReaction(target: ChatMessage, emoji: string): Promise<void> {
    const group = this.#requireActive();
    const pubkey = await group.signer.getPublicKey();
    const rumor: Rumor = {
      id: "",
      kind: REACTION_KIND,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: emoji,
      tags: [
        ["e", target.id, "", target.authorPubkey],
        ["p", target.authorPubkey],
        ["k", String(CHAT_MESSAGE_KIND)],
      ],
    };
    rumor.id = getEventHash(rumor);
    const intent = createApplicationMessageIntent(rumor);
    await this.#client.groups.send(group.id, intent);
  }

  /**
   * Load the next older page of messages for a group from local history (the
   * live subscription only holds the newest {@link HISTORY_WINDOW}). Older pages
   * are merged into the timeline via {@link #upsertMessages}. Guards against
   * concurrent loads and stops once the oldest stored message is reached.
   */
  async loadOlder(groupId: string): Promise<void> {
    const group = this.#groups.get(groupId);
    if (!group) return;
    const history = group.history as unknown as GroupRumorHistory | undefined;
    if (!history) return;
    const state = this.#paginationState(groupId);
    if (state.loadingOlder || state.exhausted) return;

    const oldest = this.#messages.get(groupId)?.[0]?.createdAt;
    state.loadingOlder = true;
    this.#publish();
    try {
      const loader = history.createPaginatedLoader({
        kinds: [CHAT_MESSAGE_KIND],
        until: oldest !== undefined ? oldest - 1 : undefined,
        limit: HISTORY_WINDOW,
      });
      const known = this.#messageIndex.get(groupId)?.size ?? 0;
      const { value } = await loader.next();
      void loader.return?.(undefined);
      const page = (value ?? []) as Rumor[];
      if (page.length) this.#upsertMessages(group, page);
      const grew = (this.#messageIndex.get(groupId)?.size ?? 0) > known;
      // Reached the top when the page was short or contributed nothing new.
      if (page.length < HISTORY_WINDOW || !grew) state.exhausted = true;
    } catch (err) {
      this.logError(err);
    } finally {
      state.loadingOlder = false;
      this.#publish();
    }
  }

  #paginationState(id: string): PaginationState {
    let state = this.#pagination.get(id);
    if (!state) {
      state = { loadingOlder: false, exhausted: false };
      this.#pagination.set(id, state);
    }
    return state;
  }

  /**
   * Replaces this client's KeyPackage with a fresh one in the same `clientId`
   * slot (relays supersede the old event), or publishes the first one when
   * this client has none yet. Other devices' KeyPackages are never touched.
   */
  async rotateKeyPackage(): Promise<void> {
    await this.#withBusy(async () => {
      const relays = await this.#requireKeyPackageRelays();
      if (!relays) return;
      const current = this.#currentKeyPackage(
        await this.#client.keyPackages.list(),
      );
      const next = current
        ? await this.#client.keyPackages.rotate(current.keyPackageRef, {
            relays,
            d: this.#clientId,
          })
        : await this.#client.keyPackages.create({
            relays,
            identifier: this.#clientId,
          });
      await this.#dropStaleKeyPackages(next.keyPackageRef);
      await this.#refreshKeyPackageSummary();
      this.log(
        current
          ? `rotated KeyPackage ${hexShort(current.keyPackageRef)} → ${hexShort(next.keyPackageRef)}`
          : `published KeyPackage ${hexShort(next.keyPackageRef)} to ${relays.join(", ")}`,
      );
    });
  }

  /**
   * Fetches the KeyPackages this account's other devices (any slot other than
   * this client's) have published to its outbox relays, keeping the newest
   * event per slot. Failures are logged and leave the previous list in place.
   */
  async refreshOtherDeviceKeyPackages(): Promise<void> {
    if (this.#watchAbort || this.#keyPackages.otherDevicesLoading) return;
    this.#keyPackages = { ...this.#keyPackages, otherDevicesLoading: true };
    this.#publish();
    try {
      await this.#ensureRelayListsLoaded();
      const relays = relaySet(this.#outboxRelays, this.#relays);
      // KeyPackages are public: decline authentication for this lookup.
      const events = await this.#pool.request(
        relays,
        { kinds: [ADDRESSABLE_KEY_PACKAGE_KIND], authors: [this.#pubkey] },
        { waitForAuth: false },
      );
      const newest = new Map<string, NostrEvent>();
      for (const event of events) {
        const slot = getKeyPackageIdentifier(event);
        if (!slot || slot === this.#clientId) continue;
        const seen = newest.get(slot);
        if (!seen || event.created_at > seen.created_at)
          newest.set(slot, event);
      }
      const otherDevices = [...newest.entries()]
        .map(([slot, event]) => ({
          slot,
          eventId: event.id,
          createdAt: event.created_at,
          refHex: getKeyPackageReference(event) ?? null,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      this.#keyPackages = { ...this.#keyPackages, otherDevices };
    } catch (err) {
      this.logError(err);
    } finally {
      this.#keyPackages = { ...this.#keyPackages, otherDevicesLoading: false };
      this.#publish();
    }
  }

  /**
   * Republish the account's advertised relay lists. `outbox` becomes the NIP-65
   * (kind 10002) list used for KeyPackage discovery; `inbox` becomes the kind
   * 10050 list used for welcome delivery. Each list is normalised and
   * de-duplicated (`relaySet`); invalid URLs are dropped by the event builders.
   */
  async saveRelayLists(outbox: string[], inbox: string[]): Promise<void> {
    await this.#withBusy(async () => {
      const nextOutbox = normalizeRelays(outbox);
      const nextInbox = normalizeRelays(inbox);
      if (!nextOutbox.length) {
        throw new Error("outbox (NIP-65) list needs at least one valid relay");
      }
      if (!nextInbox.length) {
        throw new Error(
          "inbox (kind 10050) list needs at least one valid relay",
        );
      }
      // Announce both lists to the union of the new and previously-known outbox
      // relays so old and new readers pick up the change — but never the
      // bootstrap defaults. (nextOutbox is non-empty, validated above, so this is
      // always non-empty and won't trip the pool's empty-list fallback.)
      const announce = relaySet(nextOutbox, this.#outboxRelays);
      await this.#publishOutboxList(nextOutbox, announce);
      await this.#publishInboxList(nextInbox, announce);
      this.#outboxRelays = nextOutbox;
      // These lists are now authoritative — a returning account that had not yet
      // discovered its relays must not overwrite them with a later background load.
      this.#relayListsAuthoritative = true;
      const inboxChanged =
        relaySet(nextInbox).join(",") !== relaySet(this.#inboxRelays).join(",");
      this.#inboxRelays = nextInbox;
      // Follow the new kind-10050 inbox list with the invite subscription so
      // future Welcomes land where we're actually listening.
      if (inboxChanged) this.#relistenInvites();
      this.log(
        `published relay lists — outbox: ${nextOutbox.join(", ")} · inbox: ${nextInbox.join(", ")}`,
      );
      // Both lists are now known — publish a fresh KeyPackage to the newly
      // saved outbox if we don't already have an unused one (R3). Idempotent;
      // does not use #withBusy, so this is safe to call from inside one.
      await this.#ensureKeyPackage();
    });
  }

  /**
   * Publish the user's kind 0 profile (NIP-01 metadata). The supplied fields
   * are merged over the loaded profile so values this UI doesn't expose (banner,
   * lud16, …) are preserved; empty fields are removed.
   */
  async saveProfile(fields: ProfileContent): Promise<void> {
    await this.#withBusy(async () => {
      // Publish to the user's own write relays, never the bootstrap defaults.
      const relays = await this.#requirePublishRelays();
      // Merge over the latest kind 0 already in the shared store so values this
      // UI doesn't expose (banner, lud16, …) survive a save.
      const existing = this.#eventStore.getReplaceable(0, this.#pubkey);
      const merged: ProfileContent = {
        ...(existing ? getProfileContent(existing) : {}),
      };
      for (const [key, value] of Object.entries(fields)) {
        const text = typeof value === "string" ? value.trim() : value;
        if (text === "" || text == null) delete (merged as any)[key];
        else (merged as any)[key] = text;
      }
      const event = await this.#signer.signEvent({
        kind: 0,
        content: JSON.stringify(merged),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      await this.#pool.publish(relays, event);
      // Feed the new event into the store so `useProfile` updates immediately.
      this.#eventStore.add(event);
      this.log(`published profile (${merged.name || "no name"})`);
    });
  }

  /**
   * Re-attempt relay-list discovery in the background (R2) — fired by the
   * new-group prompt when the outbox is still empty, so its choices can
   * update once discovery resolves. Unlike the action methods above, this
   * does not use {@link #withBusy}: it's a best-effort background retry, not
   * a user-initiated action the UI should block on.
   */
  async refreshRelayLists(): Promise<void> {
    try {
      await this.#ensureRelayListsLoaded();
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  /** Public logging hook so the UI can surface command errors uniformly. */
  log(text: string, level: StatusLine["level"] = "info"): void {
    const line = { id: this.#statusSeq++, level, text, at: Date.now() };
    this.#status = [...this.#status.slice(-200), line];
    this.#statusLog?.(line);
    this.#publish();
  }

  logError(err: unknown): void {
    this.log(formatError(err, this.#debug), "error");
  }

  // --- internals -------------------------------------------------------------

  async #withBusy(fn: () => Promise<void>): Promise<void> {
    if (this.#watchAbort) return;
    this.#busy = true;
    this.#publish();
    try {
      await fn();
    } catch (err) {
      this.logError(err);
    } finally {
      this.#busy = false;
      this.#publish();
    }
  }

  /**
   * Discover the account's advertised relay lists, memoised only while both
   * are known (R2) — an empty or partial result is never treated as final, so
   * the next caller that needs relays (KeyPackage publish/rotate, the startup
   * KeyPackage path, profile save, the new-group prompt) runs discovery again.
   * The background load and any on-demand caller (e.g.
   * {@link #requireKeyPackageRelays}, {@link #requirePublishRelays}) share one
   * in-flight pass rather than racing two.
   */
  async #ensureRelayListsLoaded(): Promise<void> {
    if (relayListsComplete(this.#outboxRelays, this.#inboxRelays)) return;
    if (!this.#relayListsPromise) {
      // Publish immediately so the snapshot reflects "loading" for the
      // duration of this pass, even before it settles.
      this.#relayListsPromise = this.#loadRelayLists().finally(() => {
        this.#relayListsPromise = undefined;
        this.#relayListsAttempted = true;
        this.#publish();
      });
      this.#publish();
    }
    await this.#relayListsPromise;
  }

  /**
   * The user's own write relays (NIP-65 outbox) — where their profile is
   * published. Discovers a returning account's advertised relays first (R2:
   * an incomplete prior pass is never memoised, so this re-attempts discovery
   * automatically), then refuses to publish at all when none are known rather
   * than silently falling back to the bootstrap defaults the user never
   * configured.
   */
  async #requirePublishRelays(): Promise<string[]> {
    await this.#ensureRelayListsLoaded();
    const relays = relaySet(this.#outboxRelays);
    if (!relays.length) {
      throw new Error(
        "no outbox relays configured — press r to set your relays before publishing",
      );
    }
    return relays;
  }

  /**
   * Signal the UI that the user needs to set up their relay lists (R3): logs
   * `reason` as a warning, increments {@link #relaySetupRequest} so
   * `App.tsx` opens the relay editor once no other modal is in the way, and
   * republishes the snapshot. A no-op while shutting down.
   */
  #requestRelaySetup(reason: string): void {
    if (this.#watchAbort) return;
    this.log(`${reason} — opening the relay editor`, "warn");
    this.#relaySetupRequest++;
    this.#publish();
  }

  /**
   * Resolves the relays a KeyPackage should be published to, requiring both
   * the 10002 outbox and 10050 inbox lists to be known first (R3) — a missing
   * inbox list means a Welcome sent to this KeyPackage could never reach the
   * account. Returns null (after requesting relay setup) when either list is
   * still missing, so callers route the user into the relay editor instead of
   * publishing to bootstrap relays or throwing an opaque error.
   */
  async #requireKeyPackageRelays(): Promise<string[] | null> {
    await this.#ensureRelayListsLoaded();
    if (this.#watchAbort) return null;
    if (!relayListsComplete(this.#outboxRelays, this.#inboxRelays)) {
      const status = deriveRelayListStatus({
        outbox: this.#outboxRelays,
        inbox: this.#inboxRelays,
        inFlight: false,
        attempted: true,
      });
      const gap = describeRelayListGap(status) ?? "relay lists are incomplete";
      this.#requestRelaySetup(
        `${gap} — set up your relay lists before publishing a KeyPackage`,
      );
      return null;
    }
    return relaySet(this.#outboxRelays);
  }

  /**
   * Discover advertised relay lists and adopt them if present. Queries
   * {@link LOOKUP_RELAYS} alongside the bootstrap relays as hints — the
   * applesauce address loader queries pointer hints before its
   * extras→lookup fallback chain, so an account whose lists live only on a
   * well-known indexer (whitenoise, purplepag.es, …) resolves inside
   * {@link Directory}'s 10s `$first` window instead of falling through to
   * bootstrap relays that may be dead or flapping.
   */
  async #loadRelayLists(): Promise<void> {
    this.log("looking up your relay lists (kind 10002 / 10050)…");
    const hints = relaySet(this.#relays, LOOKUP_RELAYS);
    const [outbox, inbox] = await Promise.all([
      this.#directory.outboxes(this.#pubkey, hints),
      this.#directory.welcomeInboxes(this.#pubkey, hints),
    ]);
    // A saved list is authoritative for this session — never overwrite it
    // with a (possibly stale) discovery result that was already in flight.
    if (this.#watchAbort || this.#relayListsAuthoritative) return;

    if (outbox.length) {
      this.#outboxRelays = outbox;
    }
    // Did the discovered kind-10050 inbox list differ from what the current
    // gift-wrap subscription is watching? Compare against the prior value before
    // adopting the new one.
    const before = relaySet(this.#inboxRelays).join(",");
    if (inbox.length) this.#inboxRelays = inbox;
    const inboxChanged = relaySet(this.#inboxRelays).join(",") !== before;
    if (outbox.length || inbox.length)
      this.log("loaded your advertised relay lists");
    // Move the invite subscription onto the published inbox relays. Without this
    // the subscription stays on the bootstrap defaults and any Welcome delivered
    // to a 10050 relay we didn't bootstrap from would be silently missed.
    if (inboxChanged) {
      inviteLog(
        "advertised inbox relays changed — re-subscribing (inbox=%o)",
        this.#inboxRelays,
      );
      this.#relistenInvites();
    }
    // Surface a found-outbox/missing-10050 (or missing-outbox) state (R3) —
    // this pass has settled, so evaluate the gap against the adopted fields.
    const gap = describeRelayListGap(
      deriveRelayListStatus({
        outbox: this.#outboxRelays,
        inbox: this.#inboxRelays,
        inFlight: false,
        attempted: true,
      }),
    );
    if (gap) this.log(`${gap} — press r to set up your relay lists`, "warn");
    this.#publish();
  }

  /**
   * Sign the NIP-65 outbox list (kind 10002) declaring `relays`, and publish it
   * to `targets` — the user's own write relays, never the bootstrap defaults.
   */
  async #publishOutboxList(relays: string[], targets: string[]): Promise<void> {
    const event = await this.#signer.signEvent(
      createNip65RelayListEvent({ pubkey: this.#pubkey, relays }),
    );
    await this.#pool.publish(targets, event);
    this.#eventStore.add(event);
  }

  /**
   * Sign the inbox list (kind 10050) declaring `relays`, and publish it to
   * `targets` — the user's own write relays, never the bootstrap defaults.
   */
  async #publishInboxList(relays: string[], targets: string[]): Promise<void> {
    const event = await this.#signer.signEvent(
      createInboxRelayListEvent({ pubkey: this.#pubkey, relays }),
    );
    await this.#pool.publish(targets, event);
    this.#eventStore.add(event);
  }

  /**
   * Makes sure this client's slot holds an unused, current KeyPackage so others
   * can invite it: keeps a usable one, rotates a consumed or non-current one,
   * or publishes the first one. Idempotent; safe to call on every startup.
   */
  async #ensureKeyPackage(): Promise<void> {
    const existing = await this.#client.keyPackages.list();
    if (this.#watchAbort) return;
    const current = this.#currentKeyPackage(existing);
    if (current && !current.used && !current.nonCurrent) {
      this.#setKeyPackageSummary(existing);
      return;
    }
    // This client has no usable KeyPackage to offer, so publish a fresh one —
    // to the user's OWN outbox relays, and only once both relay lists are
    // known (R3); #requireKeyPackageRelays has already logged + signalled
    // setup when they aren't.
    const relays = await this.#requireKeyPackageRelays();
    if (this.#watchAbort || !relays) return;
    const next = current
      ? await this.#client.keyPackages.rotate(current.keyPackageRef, {
          relays,
          d: this.#clientId,
        })
      : await this.#client.keyPackages.create({
          relays,
          identifier: this.#clientId,
        });
    if (this.#watchAbort) return;
    await this.#dropStaleKeyPackages(next.keyPackageRef);
    await this.#refreshKeyPackageSummary();
    this.log(
      `published a fresh KeyPackage to ${relays.join(", ")} so others can invite you`,
    );
  }

  /** This client's KeyPackage: the newest-published entry in its slot. */
  #currentKeyPackage(packages: ListedKeyPackage[]): ListedKeyPackage | null {
    let current: ListedKeyPackage | null = null;
    for (const pkg of packages) {
      if (pkg.identifier !== this.#clientId) continue;
      if (!current || publishedAt(pkg) > publishedAt(current)) current = pkg;
    }
    return current;
  }

  /**
   * Removes local private material for older KeyPackages in this client's
   * slot. Their relay events are already superseded by the newer one in the
   * same `d` slot, so this is local-only.
   */
  async #dropStaleKeyPackages(keepRef: Uint8Array): Promise<void> {
    const keep = hex(keepRef);
    for (const pkg of await this.#client.keyPackages.list()) {
      if (pkg.identifier !== this.#clientId) continue;
      if (hex(pkg.keyPackageRef) === keep) continue;
      await this.#client.keyPackages.remove(pkg.keyPackageRef);
    }
  }

  async #refreshKeyPackageSummary(): Promise<void> {
    this.#setKeyPackageSummary(await this.#client.keyPackages.list());
    this.#publish();
  }

  #setKeyPackageSummary(packages: ListedKeyPackage[]): void {
    const current = this.#currentKeyPackage(packages);
    const latest = current ? latestPublished(current) : null;
    this.#keyPackages = {
      ...this.#keyPackages,
      current: current ? keyPackageDetails(current) : null,
      publishedAt: latest?.created_at ?? null,
      publishedId: latest?.id ?? null,
    };
  }

  async #restoreGroups(): Promise<void> {
    const groups = await this.#client.groups.loadAll();
    if (this.#watchAbort) return;
    for (const group of groups) {
      if (this.#watchAbort) return;
      this.#attachGroup(group);
    }
    if (this.#watchAbort) return;
    if (groups.length && !this.#activeId) this.#activeId = groups[0].idStr;
    if (groups.length) this.log(`restored ${groups.length} group(s)`);
  }

  /**
   * Consume the library's `groups.watch()` async generator to keep relay
   * subscriptions in lockstep with the loaded group set (create/join/leave).
   * The React layer consumes the same generator independently for display.
   */
  async #watchGroups(): Promise<void> {
    try {
      for await (const groups of this.#client.groups.watch()) {
        if (this.#watchAbort) break;
        const live = new Set(groups.map((g) => g.idStr));
        for (const group of groups) {
          if (this.#watchAbort) break;
          if (!this.#groups.has(group.idStr)) {
            this.#attachGroup(group);
          }
        }
        if (this.#watchAbort) break;
        for (const id of [...this.#groups.keys()]) {
          if (!live.has(id)) this.#detachGroup(id);
        }
      }
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  /**
   * App-side bookkeeping when a group enters the loaded set: track it, bind
   * `stateChanged` to the snapshot, and start projecting its rumor history into
   * the timeline. Inbound relay transport (backfill + live kind-445 ingest) is
   * owned by the library's `groups.connectAll()` (installed in {@link start});
   * this no longer touches the network.
   */
  #attachGroup(group: MarmotGroup): void {
    if (this.#watchAbort) return;
    const id = group.idStr;
    this.#groups.set(id, group);
    // Re-publish an ACK-uncertain commit byte-for-byte after restart. The
    // hydrated session stays PendingPublish until the relay really accepts it.
    void group.retryPendingPublication().catch((error) => this.logError(error));
    if (!this.#messages.has(id)) this.#messages.set(id, []);
    if (!this.#bound.has(id)) {
      group.on("stateChanged", () => this.#publish());
      this.#bound.add(id);
    }
    // Project the group's persisted + live rumor history into the timeline: both
    // self-sent (via `send`) and ingested messages are saved to group.history.
    // The first yield is the persisted backlog from disk, so reopening a group
    // shows its history instantly.
    this.#startHistory(group);
    this.#publish();
  }

  #detachGroup(id: string): void {
    const history = this.#historySubs.get(id);
    if (history) {
      this.#historySubs.delete(id);
      void history.return(undefined);
    }
    const reactions = this.#reactionSubs.get(id);
    if (reactions) {
      this.#reactionSubs.delete(id);
      void reactions.return(undefined);
    }
    this.#reactionIndex.delete(id);
    this.#mediaIndex.delete(id);
    this.#pagination.delete(id);
    this.#groups.delete(id);
    this.#publish();
  }

  /**
   * (Re)start the library's gift-wrap invite listener on our *advertised
   * kind-10050 inbox relays* — where inviters deliver Welcomes
   * (`NostrWelcomeDelivery.deliver` → `getUserInboxRelays`). `#inboxRelays` is
   * seeded with the bootstrap relays and updated to the published 10050 list once
   * `#loadRelayLists` resolves it; this tears down any prior listener first, so it
   * can be re-run whenever that list changes. `invites.listen` owns the kind-1059
   * subscribe + ingest + decrypt loop (it also decrypts already-stored gift wraps
   * on start); the invites panel updates itself via `watchInvites`.
   */
  #relistenInvites(): void {
    if (this.#watchAbort) return;
    const relays = relaySet(this.#inboxRelays);
    inviteLog(
      "listen gift-wraps p=%s relays=%o",
      this.#pubkey.slice(0, 8),
      relays,
    );
    this.#inviteConnection?.unsubscribe();
    this.#inviteConnection = undefined;
    void this.#client.invites
      .listen(relays)
      .then((handle) => {
        if (this.#watchAbort) handle.unsubscribe();
        else this.#inviteConnection = handle;
      })
      .catch((err) => inviteLog("invite listen failed: %O", err));
  }

  /**
   * Start projecting a group's rumor history into the timeline. `subscribe`
   * yields the newest {@link HISTORY_WINDOW} messages from disk immediately, then
   * re-yields the (growing) timeline on every saved rumor — both self-sent and
   * ingested. Older messages beyond the window are loaded on demand by
   * {@link loadOlder}. Idempotent per group.
   *
   * Note: relay backfill is owned by the library's `groups.connectAll()` —
   * ingesting a kind-445 event saves its rumor to history, which this
   * subscription delivers. Backfill can only decrypt epochs still retained by the
   * engine's bounded rewind horizon; messages from pruned epochs surface via the
   * `groups.on("unreadable")` event and cannot be recovered.
   */
  #startHistory(group: MarmotGroup): void {
    const id = group.idStr;
    const history = group.history as unknown as GroupRumorHistory | undefined;
    if (!history) return;
    // Messages and reactions are projected from two independent subscriptions so
    // the message window stays a clean count of chat messages — folding reactions
    // into the same `limit` would let a burst of reactions push messages out.
    if (!this.#historySubs.has(id)) {
      const gen = history.subscribe({
        kinds: [CHAT_MESSAGE_KIND],
        limit: HISTORY_WINDOW,
      });
      this.#historySubs.set(id, gen);
      void this.#consumeHistory(group, gen);
    }
    if (!this.#reactionSubs.has(id)) {
      const gen = history.subscribe({
        kinds: [REACTION_KIND],
        limit: REACTION_WINDOW,
      });
      this.#reactionSubs.set(id, gen);
      void this.#consumeReactions(group, gen);
    }
  }

  async #consumeHistory(
    group: MarmotGroup,
    gen: AsyncGenerator<Rumor[]>,
  ): Promise<void> {
    const id = group.idStr;
    try {
      for await (const rumors of gen) {
        // Stop if the controller is shutting down or this group was detached
        // and re-attached with a newer generator.
        if (this.#watchAbort || this.#historySubs.get(id) !== gen) break;
        // An empty yield means the history was purged; clear the union too.
        this.#upsertMessages(group, rumors, rumors.length === 0);
      }
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  async #consumeReactions(
    group: MarmotGroup,
    gen: AsyncGenerator<Rumor[]>,
  ): Promise<void> {
    const id = group.idStr;
    try {
      for await (const rumors of gen) {
        if (this.#watchAbort || this.#reactionSubs.get(id) !== gen) break;
        // An empty yield means the history was purged; clear the union too.
        this.#upsertReactions(group, rumors, rumors.length === 0);
      }
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  /**
   * Merge `rumors` into the group's message union and re-project the rendered,
   * oldest-first timeline. Used by both the live history subscription and
   * {@link loadOlder} pagination; keying by rumor id makes re-delivery (e.g.
   * relay backfill) idempotent.
   */
  #upsertMessages(group: MarmotGroup, rumors: Rumor[], clear = false): void {
    const id = group.idStr;
    let index = this.#messageIndex.get(id);
    if (!index) {
      index = new Map<string, ChatMessage>();
      this.#messageIndex.set(id, index);
    }
    if (clear) index.clear();
    for (const rumor of rumors)
      index.set(rumor.id, this.#toChatMessage(group, rumor));
    this.#projectTimeline(group);
  }

  /**
   * Merge reaction `rumors` into the group's reaction union and re-project the
   * timeline so the new counts appear under their target messages. Keying by the
   * reaction rumor id makes re-delivery idempotent, just like {@link #upsertMessages}.
   */
  #upsertReactions(group: MarmotGroup, rumors: Rumor[], clear = false): void {
    const id = group.idStr;
    let index = this.#reactionIndex.get(id);
    if (!index) {
      index = new Map<string, ReactionRecord>();
      this.#reactionIndex.set(id, index);
    }
    if (clear) index.clear();
    for (const rumor of rumors) {
      const target = rumor.tags.find((tag) => tag[0] === "e" && tag[1])?.[1];
      const emoji = rumor.content.trim();
      if (!target || !emoji) continue;
      index.set(rumor.id, { targetId: target, emoji, pubkey: rumor.pubkey });
    }
    this.#projectTimeline(group);
  }

  /**
   * Re-project the rendered, oldest-first timeline for a group from its message
   * and reaction unions, attaching each message's aggregated reactions. Called by
   * both {@link #upsertMessages} and {@link #upsertReactions}.
   */
  #projectTimeline(group: MarmotGroup): void {
    const id = group.idStr;
    const messages = this.#messageIndex.get(id);
    if (!messages) return;
    const byTarget = this.#aggregateReactions(this.#reactionIndex.get(id));
    const sorted = [...messages.values()]
      .map((message) => ({
        ...message,
        reactions: byTarget.get(message.id),
        attachments: message.attachments?.map((a) =>
          this.#refreshAttachment(group, a),
        ),
      }))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    this.#messages.set(id, sorted);
    this.#publish();
  }

  /**
   * Aggregate a group's reaction records into per-message, per-emoji summaries.
   * Reactors are de-duplicated per emoji (a member reacting twice with the same
   * emoji counts once), and summaries are sorted by count then emoji.
   */
  #aggregateReactions(
    index: Map<string, ReactionRecord> | undefined,
  ): Map<string, ReactionSummary[]> {
    const out = new Map<string, ReactionSummary[]>();
    if (!index) return out;
    // targetId → emoji → set of reactor pubkeys.
    const byTarget = new Map<string, Map<string, Set<string>>>();
    for (const { targetId, emoji, pubkey } of index.values()) {
      let emojis = byTarget.get(targetId);
      if (!emojis) byTarget.set(targetId, (emojis = new Map()));
      let reactors = emojis.get(emoji);
      if (!reactors) emojis.set(emoji, (reactors = new Set()));
      reactors.add(pubkey);
    }
    for (const [targetId, emojis] of byTarget) {
      const summaries = [...emojis.entries()]
        .map(([emoji, reactors]) => ({
          emoji,
          count: reactors.size,
          mine: reactors.has(this.#pubkey),
        }))
        .sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : 1));
      out.set(targetId, summaries);
    }
    return out;
  }

  #toChatMessage(group: MarmotGroup, rumor: Rumor): ChatMessage {
    const mine = rumor.pubkey === this.#pubkey;
    // NIP-C7: a reply is a kind 9 that quotes its parent with a `q` tag,
    // shaped ["q", <event-id>, <relay-url>, <pubkey>].
    const q = rumor.tags.find((tag) => tag[0] === "q" && tag[1]);
    // Encrypted-media attachments ride on the message as `imeta` tags. Register
    // each blob (kicking off its fetch+decrypt) and build a display skeleton;
    // the live status is refreshed in #projectTimeline as the fetch progresses.
    const refs = getMediaAttachments(rumor.tags);
    const attachments = refs.length
      ? refs.map((att) => {
          const sourceParent = rumor.id;
          this.#registerMedia(group, att, sourceParent);
          return this.#toChatAttachment(group, att, sourceParent);
        })
      : undefined;
    return {
      id: rumor.id,
      groupId: group.idStr,
      authorPubkey: rumor.pubkey,
      authorLabel: mine ? "you" : npubShort(rumor.pubkey),
      content: rumor.content,
      createdAt: rumor.created_at,
      mine,
      replyToId: q?.[1],
      replyToPubkey: q?.[3] || undefined,
      attachments,
    };
  }

  /** Builds the display skeleton for an attachment, overlaying current fetch state. */
  #toChatAttachment(
    group: MarmotGroup,
    att: MediaAttachment,
    sourceParent?: string,
  ): ChatAttachment {
    const id = this.#mediaKey(att, sourceParent);
    const rec = this.#mediaIndex.get(group.idStr)?.get(id);
    return {
      id,
      filename: att.filename,
      mediaType: att.mediaType,
      dim: att.dim,
      status: rec?.status ?? "pending",
      data: rec?.data,
      size: rec?.data?.length,
      error: rec?.error,
    };
  }

  /** Refreshes an already-built attachment's live fetch state from the media index. */
  #refreshAttachment(
    group: MarmotGroup,
    attachment: ChatAttachment,
  ): ChatAttachment {
    const rec = this.#mediaIndex.get(group.idStr)?.get(attachment.id);
    if (!rec) return attachment;
    return {
      ...attachment,
      status: rec.status,
      data: rec.data,
      size: rec.data?.length,
      error: rec.error,
    };
  }

  /**
   * Records an attachment reference and, on first sighting, kicks off its
   * fetch+decrypt. Keyed by `ciphertextSha256`, so a blob referenced by several
   * messages is fetched once and shared.
   */
  #mediaKey(att: MediaAttachment, sourceParent?: string): string {
    return JSON.stringify([
      sourceParent,
      att.version,
      att.ciphertextSha256,
      att.plaintextSha256,
      att.nonce,
      att.mediaType,
      att.filename,
    ]);
  }

  #registerMedia(
    group: MarmotGroup,
    att: MediaAttachment,
    sourceParent?: string,
  ): void {
    const gid = group.idStr;
    let index = this.#mediaIndex.get(gid);
    if (!index) this.#mediaIndex.set(gid, (index = new Map()));
    const key = this.#mediaKey(att, sourceParent);
    if (index.has(key)) return;
    index.set(key, { attachment: att, status: "pending" });
    void this.#fetchMedia(group, att, key, sourceParent);
  }

  async #fetchMedia(
    group: MarmotGroup,
    att: MediaAttachment,
    key: string,
    sourceParent?: string,
  ): Promise<void> {
    const rec = this.#mediaIndex.get(group.idStr)?.get(key);
    if (!rec) return;
    rec.status = "fetching";
    this.#projectTimeline(group);
    try {
      const authenticatedSource =
        sourceParent && (await group.session.mediaSourceForRumor(sourceParent));
      if (!authenticatedSource)
        throw new Error("Attachment source material is no longer available");
      const stored = await downloadMediaAttachment(
        group,
        att,
        authenticatedSource,
        {
          transport: createBlossomMediaTransport({ signer: group.signer }),
        },
      );
      rec.data = stored.data;
      rec.status = "ready";
    } catch (err) {
      rec.status = "error";
      rec.error = err instanceof Error ? err.message : String(err);
      this.logError(err);
    }
    this.#projectTimeline(group);
  }

  /** Lazily builds (and caches) the fallback Blossom media policy. */
  #defaultMediaPolicy(): EncryptedMediaPolicyV2 {
    return (this.#defaultMediaPolicyCache ??= encryptedMediaBlossomDefault(
      DEFAULT_BLOSSOM_SERVERS,
    ));
  }

  #requireActive(): MarmotGroup {
    if (!this.#activeId)
      throw new Error("no active group — create or join one");
    const group = this.#groups.get(this.#activeId);
    if (!group) throw new Error("active group is not loaded");
    return group;
  }

  // --- snapshot plumbing -----------------------------------------------------

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): ChatSnapshot {
    const messages: Record<string, ChatMessage[]> = {};
    for (const [id, list] of this.#messages) messages[id] = list;
    const pagination: Record<string, PaginationState> = {};
    for (const [id, state] of this.#pagination) pagination[id] = { ...state };
    return {
      me: { pubkey: this.#pubkey, npub: npubEncode(this.#pubkey) },
      relays: this.#relays,
      connectedRelayCount: this.#pool.relayCount,
      outboxRelays: this.#outboxRelays,
      inboxRelays: this.#inboxRelays,
      relayListStatus: deriveRelayListStatus({
        outbox: this.#outboxRelays,
        inbox: this.#inboxRelays,
        inFlight: this.#relayListsPromise !== undefined,
        attempted: this.#relayListsAttempted,
      }),
      relaySetupRequest: this.#relaySetupRequest,
      keyPackages: this.#keyPackages,
      clientId: this.#clientId,
      activeGroupId: this.#activeId,
      messages,
      pagination,
      status: this.#status,
      busy: this.#busy,
      audit: {
        enabled: this.canUploadAudit,
        endpoint: this.#auditUpload?.endpoint ?? null,
        state: this.#auditState,
        updatedAt: this.#auditUpdatedAt,
        bytesSent: this.#auditBytesSent,
        httpStatus: this.#auditHttpStatus,
        error: this.#auditError,
      },
    };
  }
}

/**
 * Render an error for the log. In debug mode this includes the full stack
 * trace and walks the `cause` chain; otherwise just the one-line message.
 */
export function formatError(err: unknown, debug: boolean): string {
  if (!(err instanceof Error)) return String(err);
  if (!debug) return err.message;

  let out = err.stack ?? `${err.name}: ${err.message}`;
  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause) {
    const rendered =
      cause instanceof Error
        ? (cause.stack ?? `${cause.name}: ${cause.message}`)
        : String(cause);
    out += `\ncaused by: ${rendered}`;
    cause =
      cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  return out;
}
