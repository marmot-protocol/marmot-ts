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
  type WelcomeRecipient,
} from "@internet-privacy/marmot-ts/client";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_ROLE_FANOUT,
  AGENT_TEXT_STREAM_ROLE_RECEIVE,
  AGENT_TEXT_STREAM_ROLE_SEND,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  getCredentialPubkey,
  getKeyPackage,
  getKeyPackageIdentifier,
  getKeyPackageReference,
  getNostrGroupIdHex,
  getWelcomeKeyPackageRefs,
  GROUP_EVENT_KIND,
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

const GIFT_WRAP_KIND = 1059;

/** Kind of the chat rumors {@link createChatRumor} produces (Marmot chat message). */
const CHAT_MESSAGE_KIND = 9;

/** How many of the newest messages the live history window holds per group. */
const HISTORY_WINDOW = 50;

/**
 * Group transport diagnostics (relays + h-tag for sub/publish).
 * Enable with `DEBUG=opentui:group-transport` (opentui enables `*` by default).
 */
const transportLog = createDebug("opentui:group-transport");

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

/**
 * MLS `required_capabilities` GroupContext extension type (code point `0x0003`).
 * A LeafNode added to the group MUST advertise every extension/proposal/credential
 * listed here (capability-negotiation.md "enforce on add").
 */
const REQUIRED_CAPABILITIES_EXTENSION_TYPE = 0x0003;

/**
 * Maps each agent-text-stream-QUIC `required_member_roles` bit to the LeafNode
 * capability (extension type) a KeyPackage must advertise to satisfy it. A group
 * whose policy requires a role rejects any KeyPackage missing the marker
 * (agent-text-stream-quic-v1.md `do_send_invite`).
 */
const ROLE_CAPABILITIES = [
  {
    bit: AGENT_TEXT_STREAM_ROLE_RECEIVE,
    extension: AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
    name: "receive",
  },
  {
    bit: AGENT_TEXT_STREAM_ROLE_SEND,
    extension: AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
    name: "send",
  },
  {
    bit: AGENT_TEXT_STREAM_ROLE_FANOUT,
    extension: AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
    name: "fanout",
  },
] as const;

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

export interface ControllerDeps {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  /** Shared reactive event cache; also exposed to React for `useProfile`. */
  eventStore: EventStore;
  signer: Signer;
  pubkey: string;
  relays: string[];
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

/** Pre-computed group state used to evaluate each {@link InviteCandidate}. */
interface GroupInviteContext {
  cipherSuite: number;
  members: Set<string>;
  required: {
    extensionTypes: number[];
    proposalTypes: number[];
    credentialTypes: number[];
  } | null;
  requiredRoles: number;
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
  readonly #deps: ControllerDeps;

  readonly #groups = new Map<string, MarmotGroup>();
  readonly #groupSubs = new Map<string, { unsubscribe(): void }>();
  readonly #bound = new Set<string>();
  readonly #seenEvents = new Set<string>();
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
    current: null,
  };
  /** Advertised NIP-65 outbox list (kind 10002); seeded with operating relays. */
  #outboxRelays: string[];
  /** Advertised inbox list for welcomes (kind 10050); seeded with operating relays. */
  #inboxRelays: string[];
  #busy = false;
  #statusSeq = 0;

  #watchAbort = false;
  #inviteSub?: { unsubscribe(): void };

  /** Cached snapshot; replaced (new reference) on every mutation. */
  #snapshot: ChatSnapshot;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#outboxRelays = deps.relays;
    this.#inboxRelays = deps.relays;
    this.#snapshot = this.#buildSnapshot();
  }

  // --- React store interface -------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ChatSnapshot => this.#snapshot;

  get client(): MarmotClient {
    return this.#deps.client;
  }

  /** Shared reactive event cache, consumed by the React `useProfile` hook. */
  get eventStore(): EventStore {
    return this.#deps.eventStore;
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#ensureKeyPackage();
    if (this.#watchAbort) return;
    await this.#publishInitialIdentity();
    if (this.#watchAbort) return;
    await this.#restoreGroups();
    if (this.#watchAbort) return;
    this.#subscribeInvites();
    void this.#watchGroups();
    this.log(`ready — you are ${npubEncode(this.#deps.pubkey)}`);
    this.log(`relays: ${this.#deps.relays.join(", ")}`);
    void this.#loadRelayListsInBackground();
  }

  /**
   * For a freshly-created account only: publish the chosen display name (kind 0)
   * and advertise the operating relays as the account's NIP-65 outbox + kind
   * 10050 inbox lists, so peers can discover this new identity and its
   * KeyPackage. A no-op for returning accounts (no `initialProfileName`).
   */
  async #publishInitialIdentity(): Promise<void> {
    const name = this.#deps.initialProfileName;
    if (!name) return;
    await this.saveProfile({ name });
    if (this.#watchAbort) return;
    await this.saveRelayLists(this.#outboxRelays, this.#inboxRelays);
  }

  stop(): void {
    if (this.#watchAbort) return;
    this.#watchAbort = true;
    this.#inviteSub?.unsubscribe();
    for (const sub of this.#groupSubs.values()) sub.unsubscribe();
    for (const gen of this.#historySubs.values()) void gen.return(undefined);
    this.#historySubs.clear();
    this.#deps.pool.close();
    this.#deps.dispose?.();
  }

  // --- actions ---------------------------------------------------------------

  setActive(idStr: string): void {
    if (!this.#groups.has(idStr)) return;
    this.#activeId = idStr;
    this.#publish();
  }

  async createGroup(name: string, relays = this.#deps.relays): Promise<void> {
    await this.#withBusy(async () => {
      const groupRelays = normalizeRelays(relays);
      if (!groupRelays.length)
        throw new Error("group needs at least one relay");
      const group = await this.#deps.client.groups.create(name, {
        relays: groupRelays,
      });
      await this.#attachGroup(group, false);
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
      const discovered = await this.#deps.directory.outboxes(
        pubkeyHex,
        this.#deps.relays,
      );
      this.log(
        discovered.length
          ? `NIP-65 outbox: ${discovered.join(", ")}`
          : `no NIP-65 outbox relays found; using session relays`,
      );
      const searchRelays = relaySet(discovered, this.#deps.relays);
      this.log(`fetching KeyPackages from ${searchRelays.join(", ")}`);
      const kps = await this.#deps.pool.request(searchRelays, {
        kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
        authors: [pubkeyHex],
      });
      if (!kps.length) {
        throw new Error(`no KeyPackage found for ${npubShort(pubkeyHex)}`);
      }

      const context = this.#groupInviteContext(group);
      const candidates = kps
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .map((event) => this.#describeCandidate(context, event));
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
      await this.#deps.client.groups.commit(group.id, {
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

  /** Snapshots the group state needed to evaluate KeyPackage add-eligibility. */
  #groupInviteContext(group: MarmotGroup): GroupInviteContext {
    const info = group.info;
    const requiredExtension = group.state.groupContext.extensions.find(
      (extension) =>
        extension.extensionType === REQUIRED_CAPABILITIES_EXTENSION_TYPE,
    );
    const data = requiredExtension?.extensionData as
      | {
          extensionTypes?: number[];
          proposalTypes?: number[];
          credentialTypes?: number[];
        }
      | undefined;
    const required = data
      ? {
          extensionTypes: data.extensionTypes ?? [],
          proposalTypes: data.proposalTypes ?? [],
          credentialTypes: data.credentialTypes ?? [],
        }
      : null;

    const policy = info.app.components.find(
      (component) => component.id === AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
    )?.decoded as { requiredMemberRoles?: number } | undefined;

    return {
      cipherSuite: group.state.groupContext.cipherSuite,
      members: new Set(info.members.pubkeys),
      required,
      requiredRoles: policy?.requiredMemberRoles ?? 0,
    };
  }

  /** Evaluates one KeyPackage event against the group's add requirements. */
  #describeCandidate(
    context: GroupInviteContext,
    event: NostrEvent,
  ): InviteCandidate {
    const reasons: string[] = [];
    let alreadyMember = false;
    let cipherSuite = "?";
    const deviceId = getKeyPackageIdentifier(event) ?? null;
    const refHex = getKeyPackageReference(event) ?? null;

    try {
      const keyPackage = getKeyPackage(event);
      cipherSuite = codePointHex(keyPackage.cipherSuite);

      const memberPubkey = getCredentialPubkey(keyPackage.leafNode.credential);
      if (context.members.has(memberPubkey)) {
        alreadyMember = true;
        reasons.push("already a member");
      }

      if (keyPackage.cipherSuite !== context.cipherSuite) {
        reasons.push(
          `cipher suite ${codePointHex(keyPackage.cipherSuite)} ≠ group ${codePointHex(context.cipherSuite)}`,
        );
      }

      const capabilities = keyPackage.leafNode.capabilities;
      if (context.required) {
        for (const type of context.required.extensionTypes)
          if (!capabilities.extensions.includes(type))
            reasons.push(`missing extension ${codePointHex(type)}`);
        for (const type of context.required.proposalTypes)
          if (!capabilities.proposals.includes(type))
            reasons.push(`missing proposal ${codePointHex(type)}`);
        for (const type of context.required.credentialTypes)
          if (!capabilities.credentials.includes(type))
            reasons.push(`missing credential ${codePointHex(type)}`);
      }

      for (const role of ROLE_CAPABILITIES) {
        if (
          context.requiredRoles & role.bit &&
          !capabilities.extensions.includes(role.extension)
        ) {
          reasons.push(
            `missing ${role.name} role ${codePointHex(role.extension)}`,
          );
        }
      }
    } catch (err) {
      reasons.push(
        `undecodable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      id: event.id,
      event,
      createdAt: event.created_at,
      deviceId,
      refHex,
      cipherSuite,
      invitable: reasons.length === 0,
      alreadyMember,
      reasons,
    };
  }

  async joinInvite(inviteId: string): Promise<void> {
    await this.#withBusy(async () => {
      const unread = await this.#deps.client.invites.getUnread();
      const rumor = unread.find((entry) => entry.id === inviteId);
      if (!rumor) throw new Error("invite not found (already accepted?)");
      const { group } = await this.#deps.client.joinGroupFromWelcome({
        welcomeRumor: rumor,
      });
      await this.#deps.client.invites.markAsRead(rumor.id);
      await this.#attachGroup(group, true);
      this.#activeId = group.idStr;
      this.log(`joined "${groupName(group)}" — now active`);
    });
  }

  /**
   * Dismiss an invite without joining: drop it from the unread list so it stops
   * showing in the panel. Reuses the library's `markAsRead` primitive — the same
   * call {@link joinInvite} makes after a successful join — minus the join. The
   * dedupe index is preserved, so a dismissed invite won't be re-ingested.
   */
  async dismissInvite(inviteId: string): Promise<void> {
    try {
      await this.#deps.client.invites.markAsRead(inviteId);
      this.log("invite dismissed");
    } catch (err) {
      this.logError(err);
    }
  }

  /**
   * Like the library's `invites.watchUnread()`, but drops invites whose target
   * KeyPackage we no longer hold — accepting one of those would fail with "No
   * matching KeyPackage found" (see {@link joinInvite}). The UI watches this so
   * the panel only ever lists invites the user can actually accept.
   */
  async *watchAcceptableInvites(): AsyncGenerator<UnreadInvite[]> {
    for await (const invites of this.#deps.client.invites.watchUnread()) {
      const held = await Promise.all(
        invites.map((invite) => this.#hasKeyPackageForInvite(invite)),
      );
      yield invites.filter((_, index) => held[index]);
    }
  }

  /** True when we hold the private KeyPackage a Welcome rumor is addressed to. */
  async #hasKeyPackageForInvite(invite: UnreadInvite): Promise<boolean> {
    try {
      for (const ref of getWelcomeKeyPackageRefs(invite)) {
        if (await this.#deps.client.keyPackages.has(ref)) return true;
      }
      return false;
    } catch {
      // An unparseable Welcome can't be joined either; treat it as unacceptable
      // rather than letting it crash the watch generator.
      return false;
    }
  }

  async leave(): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#requireActive();
      this.log(
        "⚠ leave sends a plain MLS Remove; spec peers expect SelfRemove (gap B6) — divergent",
        "warn",
      );
      await this.#deps.client.groups.leave(group.id);
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
      if (!groupIsAdmin(group, this.#deps.pubkey)) {
        throw new Error("only group admins can update group info");
      }

      const [proposal] = await Proposals.proposeUpdateMetadata(fields)(
        group.session.proposalContext(),
      );
      if (!proposal) return;
      await this.#deps.client.groups.commit(group.id, {
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
      if (!groupIsAdmin(group, this.#deps.pubkey)) {
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
      await this.#deps.client.groups.commit(group.id, {
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
      if (!groupIsAdmin(group, this.#deps.pubkey)) {
        throw new Error("only group admins can remove members");
      }
      if (pubkey === this.#deps.pubkey) {
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

      await this.#deps.client.groups.commit(group.id, { extraProposals });
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
    await this.#deps.client.groups.send(group.id, intent);
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
      const kp = await this.#deps.client.keyPackages.create({
        relays: this.#deps.relays,
      });
      await this.#refreshKeyPackageSummary();
      this.log(
        `published KeyPackage ${hexShort(kp.keyPackageRef)} (slot ${kp.identifier ?? "?"})`,
      );
    });
  }

  async rotateKeyPackage(): Promise<void> {
    await this.#withBusy(async () => {
      const list = await this.#deps.client.keyPackages.list();
      const current =
        list.find((p) => !p.used && p.identifier === this.#deps.clientId) ??
        list.find((p) => !p.used) ??
        list[0];
      if (!current) throw new Error("no KeyPackage to rotate");
      const rotated = await this.#deps.client.keyPackages.rotate(
        current.keyPackageRef,
        { relays: this.#deps.relays },
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
      await this.#publishOutboxList(nextOutbox);
      await this.#publishInboxList(nextInbox);
      this.#outboxRelays = nextOutbox;
      const inboxChanged =
        relaySet(nextInbox).join(",") !== relaySet(this.#inboxRelays).join(",");
      this.#inboxRelays = nextInbox;
      // Follow the new kind-10050 inbox list with the invite subscription so
      // future Welcomes land where we're actually listening.
      if (inboxChanged) this.#subscribeInvites();
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
      // Merge over the latest kind 0 already in the shared store so values this
      // UI doesn't expose (banner, lud16, …) survive a save.
      const existing = this.#deps.eventStore.getReplaceable(
        0,
        this.#deps.pubkey,
      );
      const merged: ProfileContent = {
        ...(existing ? getProfileContent(existing) : {}),
      };
      for (const [key, value] of Object.entries(fields)) {
        const text = typeof value === "string" ? value.trim() : value;
        if (text === "" || text == null) delete (merged as any)[key];
        else (merged as any)[key] = text;
      }
      const event = await this.#deps.signer.signEvent({
        kind: 0,
        content: JSON.stringify(merged),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      await this.#deps.pool.publish(this.#deps.relays, event);
      // Feed the new event into the store so `useProfile` updates immediately.
      this.#deps.eventStore.add(event);
      this.log(`published profile (${merged.name || "no name"})`);
    });
  }

  /** Public logging hook so the UI can surface command errors uniformly. */
  log(text: string, level: StatusLine["level"] = "info"): void {
    const line = { id: this.#statusSeq++, level, text, at: Date.now() };
    this.#status = [...this.#status.slice(-200), line];
    this.#deps.statusLog?.(line);
    this.#publish();
  }

  logError(err: unknown): void {
    this.log(formatError(err, this.#deps.debug), "error");
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

  async #loadRelayListsInBackground(): Promise<void> {
    try {
      await this.#loadRelayLists();
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  /** Load advertised relay lists in the background and adopt them if present. */
  async #loadRelayLists(): Promise<void> {
    const [outbox, inbox] = await Promise.all([
      this.#deps.directory.outboxes(this.#deps.pubkey, this.#deps.relays),
      this.#deps.directory.welcomeInboxes(this.#deps.pubkey, this.#deps.relays),
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
      this.#subscribeInvites();
    }
    this.#publish();
  }

  /** Sign and publish the NIP-65 outbox list (kind 10002) to the operating relays. */
  async #publishOutboxList(relays: string[]): Promise<void> {
    const event = await this.#deps.signer.signEvent(
      createNip65RelayListEvent({ pubkey: this.#deps.pubkey, relays }),
    );
    await this.#deps.pool.publish(this.#deps.relays, event);
    this.#deps.eventStore.add(event);
  }

  /** Sign and publish the inbox list (kind 10050) to the operating relays. */
  async #publishInboxList(relays: string[]): Promise<void> {
    const event = await this.#deps.signer.signEvent(
      createInboxRelayListEvent({ pubkey: this.#deps.pubkey, relays }),
    );
    await this.#deps.pool.publish(this.#deps.relays, event);
    this.#deps.eventStore.add(event);
  }

  async #ensureKeyPackage(): Promise<void> {
    const existing = await this.#deps.client.keyPackages.list();
    if (this.#watchAbort) return;
    if (existing.some((pkg) => !pkg.used)) {
      this.#setKeyPackageSummary(existing);
      return;
    }
    await this.#deps.client.keyPackages.create({ relays: this.#deps.relays });
    if (this.#watchAbort) return;
    await this.#refreshKeyPackageSummary();
    this.log("published a fresh KeyPackage so others can invite you");
  }

  async #refreshKeyPackageSummary(): Promise<void> {
    this.#setKeyPackageSummary(await this.#deps.client.keyPackages.list());
    this.#publish();
  }

  #setKeyPackageSummary(
    packages: Awaited<ReturnType<MarmotClient["keyPackages"]["list"]>>,
  ): void {
    const current =
      packages.find(
        (pkg) => !pkg.used && pkg.identifier === this.#deps.clientId,
      ) ??
      packages.find((pkg) => !pkg.used) ??
      packages[0];
    const newestPublishedAt = Math.max(
      0,
      ...packages.flatMap((pkg) =>
        (pkg.published ?? []).map((event) => event.created_at),
      ),
    );
    this.#keyPackages = {
      total: packages.length,
      unused: packages.filter((pkg) => !pkg.used).length,
      slot: current?.identifier ?? null,
      newestPublishedAt: newestPublishedAt || null,
      current: current ? keyPackageDetails(current) : null,
    };
  }

  async #restoreGroups(): Promise<void> {
    const groups = await this.#deps.client.groups.loadAll();
    if (this.#watchAbort) return;
    for (const group of groups) {
      if (this.#watchAbort) return;
      await this.#attachGroup(group, true);
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
      for await (const groups of this.#deps.client.groups.watch()) {
        if (this.#watchAbort) break;
        const live = new Set(groups.map((g) => g.idStr));
        for (const group of groups) {
          if (this.#watchAbort) break;
          if (!this.#groups.has(group.idStr)) {
            await this.#attachGroup(group, true);
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

  async #attachGroup(group: MarmotGroup, catchUp: boolean): Promise<void> {
    if (this.#watchAbort) return;
    const id = group.idStr;
    this.#groups.set(id, group);
    if (!this.#messages.has(id)) this.#messages.set(id, []);
    if (!this.#bound.has(id)) {
      group.on("stateChanged", () => this.#publish());
      this.#bound.add(id);
    }
    // Project the group's persisted + live rumor history into the timeline.
    // This replaces the old `applicationMessage` echo: both self-sent (via
    // `send`) and ingested messages are saved to group.history, and the
    // subscription below delivers them. The first yield is the persisted
    // backlog from disk, so reopening a group shows its history instantly.
    this.#startHistory(group);
    const relays = group.relays?.length
      ? relaySet(group.relays)
      : this.#deps.relays;
    const h = getNostrGroupIdHex(group.state);
    transportLog(
      "attach group=%s h=%s epoch=%s catchUp=%s relays(%s)=%o group.relays=%o",
      id,
      h,
      String(group.state.groupContext.epoch),
      catchUp,
      group.relays?.length ? "group" : "fallback",
      relays,
      group.relays,
    );
    if (catchUp) {
      const backlog = await this.#deps.pool.request(relays, {
        kinds: [GROUP_EVENT_KIND],
        "#h": [h],
      });
      if (this.#watchAbort) return;
      await this.#drainIngest(group, backlog);
      if (this.#watchAbort) return;
    }
    const sub = this.#deps.pool.subscription(relays, {
      kinds: [GROUP_EVENT_KIND],
      "#h": [h],
    });
    this.#groupSubs.get(id)?.unsubscribe();
    this.#groupSubs.set(
      id,
      sub.subscribe({ next: (event) => void this.#onGroupEvent(group, event) }),
    );
    this.#publish();
  }

  #detachGroup(id: string): void {
    this.#groupSubs.get(id)?.unsubscribe();
    this.#groupSubs.delete(id);
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
   * (Re)subscribe for gift-wrapped invites (kind 1059) on our *advertised
   * kind-10050 inbox relays* — that's exactly where inviters deliver the Welcome
   * (see `NostrWelcomeDelivery.deliver` → `getUserInboxRelays`). `#inboxRelays`
   * is seeded with the bootstrap relays and updated to the published 10050 list
   * once `#loadRelayLists` resolves it; this is idempotent (tears down any prior
   * subscription first) so it can be re-run whenever that list changes.
   * Subscribing anywhere else (e.g. the bootstrap/session relays) is the bug
   * that made invites silently never arrive.
   */
  #subscribeInvites(): void {
    if (this.#watchAbort) return;
    const relays = relaySet(this.#inboxRelays);
    inviteLog(
      "subscribe gift-wraps kind=%d p=%s relays=%o",
      GIFT_WRAP_KIND,
      this.#deps.pubkey.slice(0, 8),
      relays,
    );
    const sub = this.#deps.pool.subscription(relays, {
      kinds: [GIFT_WRAP_KIND],
      "#p": [this.#deps.pubkey],
    });
    this.#inviteSub?.unsubscribe();
    this.#inviteSub = sub.subscribe({
      next: (event) => void this.#onGiftWrap(event),
    });
    // Decrypt anything already stored so the invites panel shows it on startup.
    void this.#deps.client.invites
      .getReceived()
      .then((received) => {
        if (received.length)
          inviteLog("decrypting %d stored gift-wrap(s)", received.length);
        return this.#deps.client.invites.decryptGiftWraps();
      })
      .catch((err) => inviteLog("startup decrypt failed: %O", err));
  }

  async #onGiftWrap(event: NostrEvent): Promise<void> {
    if (this.#seenEvents.has(event.id)) {
      inviteLog("gift-wrap %s already seen this session — skip", event.id);
      return;
    }
    this.#seenEvents.add(event.id);
    inviteLog(
      "gift-wrap inbound id=%s author=%s created_at=%d",
      event.id,
      event.pubkey.slice(0, 8),
      event.created_at,
    );
    try {
      const added = await this.#deps.client.invites.ingestEvent(event);
      if (!added) {
        inviteLog("gift-wrap %s already ingested (dedup) — skip", event.id);
        return;
      }
      inviteLog("gift-wrap %s ingested — decrypting", event.id);
      // decryptGiftWraps emits "decrypted", which the React watchUnread()
      // generator is listening for, so the invites panel updates itself.
      const decrypted = await this.#deps.client.invites.decryptGiftWraps();
      inviteLog(
        "gift-wrap %s decrypt produced %d unread invite(s)",
        event.id,
        decrypted.length,
      );
      this.log("📨 new invite received — see the Invites panel");
    } catch (err) {
      inviteLog("gift-wrap %s failed: %O", event.id, err);
      this.logError(err);
    }
  }

  async #onGroupEvent(group: MarmotGroup, event: NostrEvent): Promise<void> {
    if (this.#seenEvents.has(event.id)) return;
    this.#seenEvents.add(event.id);
    transportLog(
      "inbound kind-445 group=%s eventId=%s author=%s localEpoch=%s",
      group.idStr,
      event.id,
      event.pubkey.slice(0, 8),
      String(group.state.groupContext.epoch),
    );
    await this.#drainIngest(group, [event]);
  }

  /** Drive the {@link MarmotGroup.ingest} async generator over relay events. */
  async #drainIngest(group: MarmotGroup, events: NostrEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      for await (const result of group.ingest(events)) {
        // Application messages surface via the "applicationMessage" event;
        // surface anything unreadable as a status line for the demo.
        if (result.kind === "unreadable") {
          this.log("(dropped an unreadable group event)", "warn");
        }
      }
    } catch (err) {
      this.logError(err);
    }
  }

  /**
   * Start projecting a group's rumor history into the timeline. `subscribe`
   * yields the newest {@link HISTORY_WINDOW} messages from disk immediately, then
   * re-yields the (growing) timeline on every saved rumor — both self-sent and
   * ingested. Older messages beyond the window are loaded on demand by
   * {@link loadOlder}. Idempotent per group.
   *
   * Note: relay backfill is the existing `#attachGroup(catchUp)` path — ingesting
   * a kind-445 event saves its rumor to history, which this subscription
   * delivers. Backfill can only decrypt epochs still retained by the engine's
   * bounded rewind horizon; messages from pruned epochs surface as `unreadable`
   * in {@link #drainIngest} and cannot be recovered.
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
    const mine = rumor.pubkey === this.#deps.pubkey;
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
      me: { pubkey: this.#deps.pubkey, npub: npubEncode(this.#deps.pubkey) },
      relays: this.#deps.relays,
      connectedRelayCount: this.#deps.pool.relayCount,
      outboxRelays: this.#outboxRelays,
      inboxRelays: this.#inboxRelays,
      keyPackages: this.#keyPackages,
      clientId: this.#deps.clientId,
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
