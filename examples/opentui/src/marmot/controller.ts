import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
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
  type UnreadInvite,
  type Unsubscribable,
  type WelcomeRecipient,
} from "@internet-privacy/marmot-ts/client";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  getKeyPackageIdentifier,
  getKeyPackageReference,
} from "@internet-privacy/marmot-ts";
import type { Proposal } from "@internet-privacy/marmot-ts/mls";

import createDebug from "debug";

import type { Directory } from "../helpers/discovery.js";
import type { RelayPool } from "../helpers/relay-pool.js";
import {
  groupIsAdmin,
  groupName,
  hexShort,
  npubShort,
  short,
} from "./format.js";

/** Kind of the chat rumors {@link createChatRumor} produces (Marmot chat message). */
const CHAT_MESSAGE_KIND = 9;

/** How many of the newest messages the live history window holds per group. */
const HISTORY_WINDOW = 50;

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

function keyPackageDetails(pkg: ListedKeyPackage): KeyPackageDetails {
  const capabilities = pkg.publicPackage.leafNode.capabilities;
  const keyPackageExtensions = extensionDetails(pkg.publicPackage.extensions);
  const leafNodeExtensions = extensionDetails(
    pkg.publicPackage.leafNode.extensions,
  );

  return {
    refHex: hex(pkg.keyPackageRef),
    slot: pkg.identifier ?? null,
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

export interface MarmotControllerOptions {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  /** Shared reactive event cache; also exposed to React for `useProfile`. */
  eventStore: EventStore;
  signer: Signer;
  pubkey: string;
  /**
   * Bootstrap/discovery relays — where a returning account reads its own
   * advertised relay lists from on startup. Read-only: never a publish target.
   * For a fresh account these are the relays the user chose, which also seed the
   * operating ({@link MarmotController}'s outbox/inbox) lists.
   */
  relays: string[];
  /**
   * True for a freshly-created account. A fresh account already operates on the
   * relays the user chose (so its outbox/inbox are seeded from {@link relays}); a
   * returning account starts with *unknown* operating relays and discovers them
   * before publishing, so it never publishes to the bootstrap defaults.
   */
  fresh: boolean;
  /** This device's key-package slot (`d` tag / clientId). */
  clientId: string;
  /** When true, error logs include the full stack trace and cause chain. */
  debug: boolean;
  /** Optional sink for status lines when the UI has no on-screen log panel. */
  statusLog?: (line: StatusLine) => void;
  /**
   * Optional teardown hook run on {@link MarmotController.stop}, e.g. to close
   * the SQLite connection before a reset deletes the database file.
   */
  dispose?: () => void;
  /**
   * Set only for a freshly-created account: the display name to publish as the
   * kind 0 profile on first start. Its presence also triggers publishing the
   * account's NIP-65 outbox + kind 10050 inbox relay lists so peers can find it.
   */
  initialProfileName?: string;
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

export interface KeyPackageSummary {
  total: number;
  unused: number;
  slot: string | null;
  newestPublishedAt: number | null;
  /** Event id (hex) of the most recently published KeyPackage, if any. */
  newestPublishedId: string | null;
  current: KeyPackageDetails | null;
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
  slot: string | null;
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
export interface ChatSnapshot {
  me: { pubkey: string; npub: string };
  relays: string[];
  connectedRelayCount: number;
  /** The account's advertised NIP-65 outbox relays (kind 10002). */
  outboxRelays: string[];
  /** The account's advertised inbox relays for welcomes (kind 10050). */
  inboxRelays: string[];
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
  readonly #fresh: boolean;
  readonly #clientId: string;
  readonly #debug: boolean;
  readonly #statusLog?: (line: StatusLine) => void;
  readonly #dispose?: () => void;
  readonly #initialProfileName?: string;

  readonly #groups = new Map<string, MarmotGroup>();
  readonly #bound = new Set<string>();
  /** Per-group rumor union (id → message), the source of the rendered timeline. */
  readonly #messageIndex = new Map<string, Map<string, ChatMessage>>();
  /** The rendered, oldest-first timeline projected from {@link #messageIndex}. */
  readonly #messages = new Map<string, ChatMessage[]>();
  /** Live `history.subscribe()` generators, one per attached group. */
  readonly #historySubs = new Map<string, AsyncGenerator<Rumor[]>>();
  /** Older-message pagination state, one per group id. */
  readonly #pagination = new Map<string, PaginationState>();

  readonly #listeners = new Set<Listener>();

  #status: StatusLine[] = [];
  #activeId: string | null = null;
  #keyPackages: KeyPackageSummary = {
    total: 0,
    unused: 0,
    slot: null,
    newestPublishedAt: null,
    newestPublishedId: null,
    current: null,
  };
  /**
   * Advertised NIP-65 outbox list (kind 10002) — the user's own write relays,
   * where their KeyPackages/profile/relay-lists are published and discovered.
   * Seeded from the chosen relays for a fresh account; empty (unknown) for a
   * returning account until {@link #loadRelayLists} resolves it.
   */
  #outboxRelays: string[];
  /** Advertised inbox list for welcomes (kind 10050); seeded like {@link #outboxRelays}. */
  #inboxRelays: string[];
  #busy = false;
  #statusSeq = 0;

  /** True once a returning account's advertised relay lists have been loaded. */
  #relayListsLoaded = false;
  /** In-flight {@link #loadRelayLists}, so the background load and an on-demand
   * publish share one discovery pass instead of racing two. */
  #relayListsPromise?: Promise<void>;

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
    this.#fresh = options.fresh;
    this.#clientId = options.clientId;
    this.#debug = options.debug;
    this.#statusLog = options.statusLog;
    this.#dispose = options.dispose;
    this.#initialProfileName = options.initialProfileName;
    // A fresh account already operates on the relays the user chose, so seed its
    // advertised lists with them. A returning account starts with *unknown*
    // operating relays — NOT the bootstrap defaults — and adopts its published
    // NIP-65 outbox + kind-10050 inbox once #loadRelayLists resolves them, so we
    // never publish the user's events to a default relay they never configured.
    this.#outboxRelays = this.#fresh ? this.#relays : [];
    this.#inboxRelays = this.#fresh ? this.#relays : [];
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

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#ensureKeyPackage();
    if (this.#watchAbort) return;
    await this.#publishInitialIdentity();
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
    // Returning accounts discover their advertised relays in the background so the
    // invite subscription and future publishes follow the user's own relays, never
    // the bootstrap defaults. (#ensureKeyPackage already awaited this above if it
    // needed to publish a KeyPackage.)
    void this.#ensureRelayListsLoaded().catch((err) => {
      if (!this.#watchAbort) this.logError(err);
    });
  }

  /**
   * For a freshly-created account only: publish the chosen display name (kind 0)
   * and advertise the operating relays as the account's NIP-65 outbox + kind
   * 10050 inbox lists, so peers can discover this new identity and its
   * KeyPackage. A no-op for returning accounts (no `initialProfileName`).
   */
  async #publishInitialIdentity(): Promise<void> {
    const name = this.#initialProfileName;
    if (!name) return;
    await this.saveProfile({ name });
    if (this.#watchAbort) return;
    await this.saveRelayLists(this.#outboxRelays, this.#inboxRelays);
  }

  stop(): void {
    if (this.#watchAbort) return;
    this.#watchAbort = true;
    this.#inviteConnection?.unsubscribe();
    this.#groupsConnection?.unsubscribe();
    for (const gen of this.#historySubs.values()) void gen.return(undefined);
    this.#historySubs.clear();
    this.#pool.close();
    this.#dispose?.();
  }

  // --- actions ---------------------------------------------------------------

  setActive(idStr: string): void {
    if (!this.#groups.has(idStr)) return;
    this.#activeId = idStr;
    this.#publish();
  }

  async createGroup(name: string, relays = this.#outboxRelays): Promise<void> {
    await this.#withBusy(async () => {
      const groupRelays = normalizeRelays(relays);
      if (!groupRelays.length)
        throw new Error("group needs at least one relay");
      const group = await this.#client.groups.create(name, {
        relays: groupRelays,
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
   * opening the selection modal.
   */
  async loadInviteCandidates(input: string): Promise<InviteCandidates | null> {
    if (this.#watchAbort) return null;
    this.#busy = true;
    this.#publish();
    try {
      const group = this.#requireActive();
      const pubkeyHex = normalizeToPubkey(input);
      if (!pubkeyHex) throw new Error(`invalid pubkey or npub: ${input}`);

      // Discover the invitee's NIP-65 (kind 10002) outbox relays — where they
      // publish their KeyPackages. The Directory's address loader also falls
      // back to public NIP-65 indexers, so this works even for peers we've
      // never shared a relay with.
      this.log(`discovering KeyPackages for ${npubShort(pubkeyHex)}…`);
      const discovered = await this.#directory.outboxes(
        pubkeyHex,
        this.#relays,
      );
      this.log(
        discovered.length
          ? `NIP-65 outbox: ${discovered.join(", ")}`
          : `no NIP-65 outbox relays found; using session relays`,
      );
      const searchRelays = relaySet(discovered, this.#relays);
      this.log(`fetching KeyPackages from ${searchRelays.join(", ")}`);
      const kps = await this.#pool.request(searchRelays, {
        kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
        authors: [pubkeyHex],
      });
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
    fields: { name: string; description: string },
  ): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#groups.get(groupId);
      if (!group) throw new Error("group is not loaded");
      if (!groupIsAdmin(group, this.#pubkey)) {
        throw new Error("only group admins can update group info");
      }

      const [proposal] = await Proposals.proposeUpdateMetadata(fields)(
        group.session.proposalContext(),
      );
      if (!proposal) return;
      await this.#client.groups.commit(group.id, {
        extraProposals: [proposal],
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
      await this.#client.groups.commit(group.id, {
        extraProposals: [proposal],
      });
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

  async sendText(text: string): Promise<void> {
    const group = this.#requireActive();
    const pubkey = await group.signer.getPublicKey();
    const rumor = createChatRumor({ pubkey, content: text });
    const intent = createApplicationMessageIntent(rumor);
    // `send` saves the rumor to group.history, which the per-group
    // history.subscribe() loop projects into the timeline — including this
    // self-sent message — so no manual local echo is needed here.
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

  async publishKeyPackage(): Promise<void> {
    await this.#withBusy(async () => {
      const relays = await this.#requirePublishRelays();
      const kp = await this.#client.keyPackages.create({ relays });
      await this.#refreshKeyPackageSummary();
      this.log(
        `published KeyPackage ${hexShort(kp.keyPackageRef)} (slot ${kp.identifier ?? "?"}) to ${relays.join(", ")}`,
      );
    });
  }

  async rotateKeyPackage(): Promise<void> {
    await this.#withBusy(async () => {
      const list = await this.#client.keyPackages.list();
      const current =
        list.find((p) => !p.used && p.identifier === this.#clientId) ??
        list.find((p) => !p.used) ??
        list[0];
      if (!current) throw new Error("no KeyPackage to rotate");
      const relays = await this.#requirePublishRelays();
      const rotated = await this.#client.keyPackages.rotate(
        current.keyPackageRef,
        { relays },
      );
      await this.#refreshKeyPackageSummary();
      this.log(
        `rotated KeyPackage ${hexShort(current.keyPackageRef)} → ${hexShort(rotated.keyPackageRef)}`,
      );
    });
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
      this.#relayListsLoaded = true;
      const inboxChanged =
        relaySet(nextInbox).join(",") !== relaySet(this.#inboxRelays).join(",");
      this.#inboxRelays = nextInbox;
      // Follow the new kind-10050 inbox list with the invite subscription so
      // future Welcomes land where we're actually listening.
      if (inboxChanged) this.#relistenInvites();
      this.log(
        `published relay lists — outbox: ${nextOutbox.join(", ")} · inbox: ${nextInbox.join(", ")}`,
      );
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
   * Discover and adopt a returning account's advertised relay lists exactly
   * once, memoising the in-flight pass so the background load and an on-demand
   * publish (e.g. {@link #ensureKeyPackage}, {@link #requirePublishRelays}) share
   * one discovery rather than racing two. A no-op for fresh accounts, which
   * already operate on the relays the user chose.
   */
  async #ensureRelayListsLoaded(): Promise<void> {
    if (this.#fresh || this.#relayListsLoaded) return;
    if (!this.#relayListsPromise) {
      this.#relayListsPromise = this.#loadRelayLists().then(
        () => {
          this.#relayListsLoaded = true;
        },
        (err) => {
          // Allow a later call to retry after a failed discovery.
          this.#relayListsPromise = undefined;
          throw err;
        },
      );
    }
    await this.#relayListsPromise;
  }

  /**
   * The user's own write relays (NIP-65 outbox) — where their KeyPackages,
   * profile, and relay lists are published. Discovers a returning account's
   * advertised relays first, then refuses to publish at all when none are known
   * rather than silently falling back to the bootstrap defaults the user never
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

  /** Load advertised relay lists in the background and adopt them if present. */
  async #loadRelayLists(): Promise<void> {
    const [outbox, inbox] = await Promise.all([
      this.#directory.outboxes(this.#pubkey, this.#relays),
      this.#directory.welcomeInboxes(this.#pubkey, this.#relays),
    ]);
    if (this.#watchAbort) return;

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

  async #ensureKeyPackage(): Promise<void> {
    const existing = await this.#client.keyPackages.list();
    if (this.#watchAbort) return;
    if (existing.some((pkg) => !pkg.used)) {
      this.#setKeyPackageSummary(existing);
      return;
    }
    // We have no unused KeyPackage to offer, so publish a fresh one — to the
    // user's OWN outbox relays. Discover them first (returning accounts) so this
    // never lands on the bootstrap defaults; if the account has no advertised
    // relays at all, skip rather than publish somewhere the user doesn't know.
    await this.#ensureRelayListsLoaded();
    if (this.#watchAbort) return;
    const relays = relaySet(this.#outboxRelays);
    if (!relays.length) {
      this.log(
        "no outbox relays found — skipping KeyPackage publish; press r to set your relays so others can invite you",
        "warn",
      );
      return;
    }
    await this.#client.keyPackages.create({ relays });
    if (this.#watchAbort) return;
    await this.#refreshKeyPackageSummary();
    this.log(
      `published a fresh KeyPackage to ${relays.join(", ")} so others can invite you`,
    );
  }

  async #refreshKeyPackageSummary(): Promise<void> {
    this.#setKeyPackageSummary(await this.#client.keyPackages.list());
    this.#publish();
  }

  #setKeyPackageSummary(
    packages: Awaited<ReturnType<MarmotClient["keyPackages"]["list"]>>,
  ): void {
    const current =
      packages.find((pkg) => !pkg.used && pkg.identifier === this.#clientId) ??
      packages.find((pkg) => !pkg.used) ??
      packages[0];
    const newestPublished = packages
      .flatMap((pkg) => pkg.published ?? [])
      .reduce<NostrEvent | null>(
        (newest, event) =>
          !newest || event.created_at > newest.created_at ? event : newest,
        null,
      );
    this.#keyPackages = {
      total: packages.length,
      unused: packages.filter((pkg) => !pkg.used).length,
      slot: current?.identifier ?? null,
      newestPublishedAt: newestPublished?.created_at ?? null,
      newestPublishedId: newestPublished?.id ?? null,
      current: current ? keyPackageDetails(current) : null,
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
    if (!history || this.#historySubs.has(id)) return;
    const gen = history.subscribe({
      kinds: [CHAT_MESSAGE_KIND],
      limit: HISTORY_WINDOW,
    });
    this.#historySubs.set(id, gen);
    void this.#consumeHistory(group, gen);
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
    const sorted = [...index.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
    this.#messages.set(id, sorted);
    this.#publish();
  }

  #toChatMessage(group: MarmotGroup, rumor: Rumor): ChatMessage {
    const mine = rumor.pubkey === this.#pubkey;
    return {
      id: rumor.id,
      groupId: group.idStr,
      authorPubkey: rumor.pubkey,
      authorLabel: mine ? "you" : npubShort(rumor.pubkey),
      content: rumor.content,
      createdAt: rumor.created_at,
      mine,
    };
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
      keyPackages: this.#keyPackages,
      clientId: this.#clientId,
      activeGroupId: this.#activeId,
      messages,
      pagination,
      status: this.#status,
      busy: this.#busy,
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
