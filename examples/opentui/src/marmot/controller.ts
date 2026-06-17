import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  normalizeToPubkey,
  npubEncode,
} from "applesauce-core/helpers/pointers";
import {
  getProfileContent,
  type ProfileContent,
} from "applesauce-core/helpers/profile";
import { relaySet } from "applesauce-core/helpers/relays";

import {
  createApplicationMessageIntent,
  createChatRumor,
  type MarmotClient,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  deserializeApplicationData,
  getNip65Relays,
  getNostrGroupIdHex,
  GROUP_EVENT_KIND,
  NIP65_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";

import type { RelayPool } from "../helpers/relay-pool.js";
import { groupName, hexShort, npubShort, short } from "./format.js";

const GIFT_WRAP_KIND = 1059;

/** Minimal signer shape (applesauce `EventSigner`) the controller needs. */
type Signer = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<NostrEvent> | NostrEvent;
};

export interface ControllerDeps {
  client: MarmotClient;
  pool: RelayPool;
  signer: Signer;
  pubkey: string;
  relays: string[];
  /** This device's key-package slot (`d` tag / clientId). */
  clientId: string;
  /** When true, error logs include the full stack trace and cause chain. */
  debug: boolean;
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

export interface StatusLine {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
  at: number;
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
  /** The user's own kind 0 profile metadata, once loaded (null if none). */
  profile: ProfileContent | null;
  relays: string[];
  clientId: string;
  activeGroupId: string | null;
  /** Messages keyed by group id (hex). */
  messages: Record<string, ChatMessage[]>;
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
  readonly #seenMessages = new Set<string>();
  readonly #messages = new Map<string, ChatMessage[]>();

  readonly #listeners = new Set<Listener>();

  #status: StatusLine[] = [];
  #activeId: string | null = null;
  #profile: ProfileContent | null = null;
  #busy = false;
  #statusSeq = 0;

  #watchAbort = false;
  #inviteSub?: { unsubscribe(): void };

  /** Cached snapshot; replaced (new reference) on every mutation. */
  #snapshot: ChatSnapshot;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
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

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#publishIdentity();
    await this.#ensureKeyPackage();
    await this.#loadProfile();
    await this.#restoreGroups();
    this.#subscribeInvites();
    void this.#watchGroups();
    this.log(`ready — you are ${npubEncode(this.#deps.pubkey)}`);
    this.log(`relays: ${this.#deps.relays.join(", ")}`);
  }

  stop(): void {
    this.#watchAbort = true;
    this.#inviteSub?.unsubscribe();
    for (const sub of this.#groupSubs.values()) sub.unsubscribe();
    this.#deps.pool.close();
  }

  // --- actions ---------------------------------------------------------------

  setActive(idStr: string): void {
    if (!this.#groups.has(idStr)) return;
    this.#activeId = idStr;
    this.#publish();
  }

  async createGroup(name: string): Promise<void> {
    await this.#withBusy(async () => {
      const group = await this.#deps.client.groups.create(name, {
        relays: this.#deps.relays,
      });
      await this.#attachGroup(group, false);
      this.#activeId = group.idStr;
      this.log(`created "${name}" (${short(group.idStr)}) — now active`);
    });
  }

  async invite(input: string): Promise<void> {
    await this.#withBusy(async () => {
      const group = this.#requireActive();
      const pubkeyHex = normalizeToPubkey(input);
      if (!pubkeyHex) throw new Error(`invalid pubkey or npub: ${input}`);

      this.log(`discovering KeyPackage for ${npubShort(pubkeyHex)}…`);
      const lists = await this.#deps.pool.request(this.#deps.relays, {
        kinds: [NIP65_RELAY_LIST_KIND],
        authors: [pubkeyHex],
      });
      const discovered = lists.length
        ? getNip65Relays(this.#newest(lists))
        : [];
      const searchRelays = relaySet(discovered, this.#deps.relays);
      this.log(`fetching KeyPackage from ${searchRelays.length} relay(s)…`);
      const kps = await this.#deps.pool.request(searchRelays, {
        kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
        authors: [pubkeyHex],
      });
      if (!kps.length) {
        throw new Error(`no KeyPackage found for ${npubShort(pubkeyHex)}`);
      }
      await this.#deps.client.groups.invite(group.id, this.#newest(kps));
      this.log(
        `invited ${npubShort(pubkeyHex)} to "${groupName(group)}" — welcome delivered`,
      );
    });
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

  async sendText(text: string): Promise<void> {
    const group = this.#requireActive();
    const pubkey = await group.signer.getPublicKey();
    const rumor = createChatRumor({ pubkey, content: text });
    const intent = createApplicationMessageIntent(rumor);
    await this.#deps.client.groups.send(group.id, intent);
    // Self-echo is skipped on ingest, so append the local copy immediately.
    this.#addMessage(group, rumor.id, pubkey, text, rumor.created_at, true);
  }

  async publishKeyPackage(): Promise<void> {
    await this.#withBusy(async () => {
      const kp = await this.#deps.client.keyPackages.create({
        relays: this.#deps.relays,
      });
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
      this.log(
        `rotated KeyPackage ${hexShort(current.keyPackageRef)} → ${hexShort(rotated.keyPackageRef)}`,
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
      const merged: ProfileContent = { ...(this.#profile ?? {}) };
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
      this.#profile = merged;
      this.log(`published profile (${merged.name || "no name"})`);
    });
  }

  /** Public logging hook so the UI can surface command errors uniformly. */
  log(text: string, level: StatusLine["level"] = "info"): void {
    this.#status = [
      ...this.#status.slice(-200),
      { id: this.#statusSeq++, level, text, at: Date.now() },
    ];
    this.#publish();
  }

  logError(err: unknown): void {
    this.log(formatError(err, this.#deps.debug), "error");
  }

  // --- internals -------------------------------------------------------------

  async #withBusy(fn: () => Promise<void>): Promise<void> {
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

  async #publishIdentity(): Promise<void> {
    const nip65 = createNip65RelayListEvent({
      pubkey: this.#deps.pubkey,
      relays: this.#deps.relays,
    });
    const inbox = createInboxRelayListEvent({
      pubkey: this.#deps.pubkey,
      relays: this.#deps.relays,
    });
    await this.#deps.pool.publish(
      this.#deps.relays,
      await this.#deps.signer.signEvent(nip65),
    );
    await this.#deps.pool.publish(
      this.#deps.relays,
      await this.#deps.signer.signEvent(inbox),
    );
  }

  /** Load the user's existing kind 0 profile from the relays, if any. */
  async #loadProfile(): Promise<void> {
    try {
      const events = await this.#deps.pool.request(this.#deps.relays, {
        kinds: [0],
        authors: [this.#deps.pubkey],
      });
      const latest = events.length ? this.#newest(events) : undefined;
      if (latest) {
        this.#profile = getProfileContent(latest) ?? null;
        this.#publish();
      }
    } catch (err) {
      if (this.#deps.debug) this.logError(err);
    }
  }

  async #ensureKeyPackage(): Promise<void> {
    const existing = await this.#deps.client.keyPackages.list();
    if (existing.some((pkg) => !pkg.used)) return;
    await this.#deps.client.keyPackages.create({ relays: this.#deps.relays });
    this.log("published a fresh KeyPackage so others can invite you");
  }

  async #restoreGroups(): Promise<void> {
    const groups = await this.#deps.client.groups.loadAll();
    for (const group of groups) await this.#attachGroup(group, true);
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
          if (!this.#groups.has(group.idStr)) {
            await this.#attachGroup(group, true);
          }
        }
        for (const id of [...this.#groups.keys()]) {
          if (!live.has(id)) this.#detachGroup(id);
        }
      }
    } catch (err) {
      if (!this.#watchAbort) this.logError(err);
    }
  }

  async #attachGroup(group: MarmotGroup, catchUp: boolean): Promise<void> {
    const id = group.idStr;
    this.#groups.set(id, group);
    if (!this.#messages.has(id)) this.#messages.set(id, []);
    if (!this.#bound.has(id)) {
      group.on("applicationMessage", (bytes: Uint8Array) =>
        this.#onAppMessage(group, bytes),
      );
      this.#bound.add(id);
    }
    const relays = group.relays?.length
      ? relaySet(group.relays)
      : this.#deps.relays;
    const h = getNostrGroupIdHex(group.state);
    if (catchUp) {
      const backlog = await this.#deps.pool.request(relays, {
        kinds: [GROUP_EVENT_KIND],
        "#h": [h],
      });
      await this.#drainIngest(group, backlog);
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
    this.#groups.delete(id);
    this.#publish();
  }

  #subscribeInvites(): void {
    const sub = this.#deps.pool.subscription(this.#deps.relays, {
      kinds: [GIFT_WRAP_KIND],
      "#p": [this.#deps.pubkey],
    });
    this.#inviteSub = sub.subscribe({
      next: (event) => void this.#onGiftWrap(event),
    });
    // Decrypt anything already stored so the invites panel shows it on startup.
    void this.#deps.client.invites.decryptGiftWraps().catch(() => {});
  }

  async #onGiftWrap(event: NostrEvent): Promise<void> {
    if (this.#seenEvents.has(event.id)) return;
    this.#seenEvents.add(event.id);
    try {
      const added = await this.#deps.client.invites.ingestEvent(event);
      if (!added) return;
      // decryptGiftWraps emits "decrypted", which the React watchUnread()
      // generator is listening for, so the invites panel updates itself.
      await this.#deps.client.invites.decryptGiftWraps();
      this.log("📨 new invite received — see the Invites panel");
    } catch (err) {
      this.logError(err);
    }
  }

  async #onGroupEvent(group: MarmotGroup, event: NostrEvent): Promise<void> {
    if (this.#seenEvents.has(event.id)) return;
    this.#seenEvents.add(event.id);
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

  #onAppMessage(group: MarmotGroup, bytes: Uint8Array): void {
    try {
      const rumor = deserializeApplicationData(bytes);
      this.#addMessage(
        group,
        rumor.id,
        rumor.pubkey,
        rumor.content,
        rumor.created_at,
        rumor.pubkey === this.#deps.pubkey,
      );
    } catch (err) {
      this.log("(received an app message that could not be decoded)", "warn");
      if (this.#deps.debug) this.logError(err);
    }
  }

  #addMessage(
    group: MarmotGroup,
    id: string,
    authorPubkey: string,
    content: string,
    createdAt: number,
    mine: boolean,
  ): void {
    if (this.#seenMessages.has(id)) return;
    this.#seenMessages.add(id);
    const message: ChatMessage = {
      id,
      groupId: group.idStr,
      authorPubkey,
      authorLabel: mine ? "you" : npubShort(authorPubkey),
      content,
      createdAt,
      mine,
    };
    const list = this.#messages.get(group.idStr) ?? [];
    this.#messages.set(group.idStr, [...list, message]);
    this.#publish();
  }

  #requireActive(): MarmotGroup {
    if (!this.#activeId)
      throw new Error("no active group — create or join one");
    const group = this.#groups.get(this.#activeId);
    if (!group) throw new Error("active group is not loaded");
    return group;
  }

  #newest(events: NostrEvent[]): NostrEvent {
    return events.slice().sort((a, b) => b.created_at - a.created_at)[0];
  }

  // --- snapshot plumbing -----------------------------------------------------

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): ChatSnapshot {
    const messages: Record<string, ChatMessage[]> = {};
    for (const [id, list] of this.#messages) messages[id] = list;
    return {
      me: { pubkey: this.#deps.pubkey, npub: npubEncode(this.#deps.pubkey) },
      profile: this.#profile,
      relays: this.#deps.relays,
      clientId: this.#deps.clientId,
      activeGroupId: this.#activeId,
      messages,
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
