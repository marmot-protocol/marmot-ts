import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { matchFilters, type Filter } from "applesauce-core/helpers/filter";
import {
  PRESENCE_TTL_MS,
  type SyncMessage,
  type TabIdentity,
} from "./relay-protocol.js";
export type { SyncMessage, TabIdentity } from "./relay-protocol.js";

/** One entry in the relay's traffic log, used by `<RelayLog>`. */
export type RelayLogEntry = {
  id: number;
  at: number;
  /** Which demo actor performed the operation. */
  actor: string;
  /** The tab that performed it, when it was not this one. */
  tab?: string;
  op: "publish" | "request" | "subscribe" | "unsubscribe";
  /** Present for publishes. */
  event?: NostrEvent;
  /** Present for requests and subscriptions. */
  filters?: Filter[];
  /** Number of events returned by a request. */
  results?: number;
};

export type DemoRelayOptions = {
  /**
   * SharedWorker name (or BroadcastChannel fallback) shared with tabs of the same origin, or
   * `false` to keep this relay private to its instance. Relays on the same
   * channel (in any tab) behave as one relay.
   */
  channel?: string | false;
};

export const DEMO_RELAY_CHANNEL = "marmot-demo-relay";

/** How long a new relay waits for other tabs to send their stored events. */
const SYNC_TIMEOUT_MS = 150;

/**
 * A tiny in-browser Nostr relay shared by every actor in a demo. It ignores
 * relay URLs (all "relays" are this one store) so demos can run several
 * clients side by side with no network access.
 *
 * By default every instance joins a SharedWorker (BroadcastChannel fallback), so all open tabs of
 * the demo app share one relay: publishes in one tab reach subscriptions in
 * the others, and a newly opened tab first copies the relay's stored events.
 * Events are in memory only and disappear when the worker is terminated.
 * The mode-driven transport service owns its lifetime.
 *
 * Set `paused` to hold this tab's publishes in `queue` and release them with
 * `flush()`, which lets demos show what happens while traffic is delayed.
 */
export class DemoRelay {
  readonly relays = [DEMO_RELAY_URL];
  readonly events: NostrEvent[] = [];
  readonly log: RelayLogEntry[] = [];
  readonly queue: NostrEvent[] = [];
  paused = false;

  /** Short random label identifying this relay instance (usually: this tab). */
  readonly tab = Math.random().toString(16).slice(2, 6);

  #nextId = 1;
  #ids = new Set<string>();
  #subs = new Set<{
    id: string;
    actor: string;
    filters: Filter[];
    next: (event: NostrEvent) => void;
  }>();
  #listeners = new Set<() => void>();
  #version = 0;
  #channelName: string | false;
  #channel?: BroadcastChannel;
  #worker?: SharedWorker;
  #ready: Promise<void> = Promise.resolve();
  #identity?: string;
  #peers = new Map<string, TabIdentity>();
  #heartbeat?: ReturnType<typeof setInterval>;
  #disposed = false;

  get peers(): TabIdentity[] {
    return [...this.#peers.values()].filter(
      (peer) =>
        peer.from !== this.tab && Date.now() - peer.at < PRESENCE_TTL_MS,
    );
  }

  setIdentity(pubkey?: string) {
    this.#identity = pubkey;
    this.#announce();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (pubkey) this.#heartbeat = setInterval(() => this.#announce(), 20_000);
  }

  #announce() {
    this.#post({
      type: "presence",
      from: this.tab,
      pubkey: this.#identity,
      at: Date.now(),
    });
    for (const [id, peer] of this.#peers)
      if (Date.now() - peer.at >= PRESENCE_TTL_MS) this.#peers.delete(id);
    this.#changed();
  }

  constructor(options: DemoRelayOptions = {}) {
    this.#channelName = options.channel ?? DEMO_RELAY_CHANNEL;
    this.open();
  }

  /** Resolves once events from already-open tabs have been copied in. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * Join the shared channel and copy in events other tabs already store.
   * Called by the constructor; only needed again after `close()`.
   */
  open() {
    this.#disposed = false;
    if (this.#channel || this.#worker || this.#channelName === false) return;
    if (typeof SharedWorker !== "undefined") {
      const worker = new SharedWorker(
        new URL("./demo-relay.worker.ts", import.meta.url),
        { type: "module", name: this.#channelName },
      );
      this.#worker = worker;
      let synced!: () => void;
      this.#ready = new Promise((resolve) => (synced = resolve));
      worker.port.onmessage = (message: MessageEvent<SyncMessage>) =>
        this.#receive(message.data, synced);
      worker.port.start();
      this.#post({ type: "hello", from: this.tab });
      return;
    }
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(this.#channelName);
    this.#channel = channel;
    let synced!: () => void;
    this.#ready = new Promise((resolve) => (synced = resolve));
    channel.onmessage = (message: MessageEvent<SyncMessage>) =>
      this.#receive(message.data, synced);
    this.#post({ type: "hello", from: this.tab });
    // Nobody answering just means this is the first tab.
    setTimeout(synced, SYNC_TIMEOUT_MS);
  }

  /** Whether this relay is shared with other tabs. */
  get shared(): boolean {
    return this.#worker !== undefined || this.#channel !== undefined;
  }

  get transport(): string {
    return this.#worker
      ? "SharedWorker"
      : this.#channel
        ? "BroadcastChannel"
        : "local";
  }

  /** Monotonic change counter, for `useSyncExternalStore`. */
  get version(): number {
    return this.#version;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Leave the shared channel; stored events stay. Reopen with `open()`. */
  close() {
    if (this.#disposed) return;
    this.setIdentity(undefined);
    this.#disposed = true;
    this.#subs.clear();
    this.#peers.clear();
    this.#worker?.port.postMessage({ type: "disconnect" });
    this.#worker?.port.close();
    this.#worker = undefined;
    this.#channel?.close();
    this.#channel = undefined;
    this.#listeners.clear();
  }

  #assertOpen() {
    if (this.#disposed) throw new Error("Transport closed");
  }

  #changed() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  #post(message: SyncMessage) {
    this.#worker?.port.postMessage(message);
    this.#channel?.postMessage(message);
  }

  #receive(message: SyncMessage, synced: () => void) {
    if (this.#disposed) return;
    switch (message.type) {
      case "hello":
        if (this.#identity) this.#announce();
        // Any open tab may answer; duplicates are ignored on arrival.
        if (this.events.length > 0)
          this.#post({
            type: "snapshot",
            to: message.from,
            events: this.events,
          });
        break;
      case "reset":
        this.events.length = 0;
        this.log.length = 0;
        this.queue.length = 0;
        this.#ids.clear();
        this.#changed();
        break;
      case "snapshot":
        if (message.to !== this.tab) break;
        for (const event of message.events) this.#store(event);
        this.#changed();
        synced();
        break;
      case "event":
        if (this.#store(message.event)) this.#changed();
        break;
      case "presence":
        if (message.pubkey)
          this.#peers.set(message.from, {
            from: message.from,
            pubkey: message.pubkey,
            at: message.at,
          });
        else this.#peers.delete(message.from);
        this.#changed();
        break;
      case "peers":
        this.#peers = new Map(message.peers.map((peer) => [peer.from, peer]));
        this.#changed();
        break;
      case "log":
        this.log.push({
          ...message.entry,
          id: this.#nextId++,
          tab: message.from,
        });
        this.#changed();
        break;
    }
  }

  #record(entry: Omit<RelayLogEntry, "id" | "at" | "tab">) {
    const full = { ...entry, at: Date.now() };
    this.log.push({ ...full, id: this.#nextId++ });
    this.#post({ type: "log", from: this.tab, entry: full });
    this.#changed();
  }

  /** Store an event and notify local subscriptions. False if already known. */
  #store(event: NostrEvent): boolean {
    if (this.#ids.has(event.id)) return false;
    this.#ids.add(event.id);
    this.events.push(event);
    for (const sub of this.#subs)
      if (matchFilters(sub.filters, event)) sub.next(event);
    return true;
  }

  /** Store a locally published event and share it with other tabs. */
  #deliver(event: NostrEvent) {
    if (this.#store(event)) this.#post({ type: "event", event });
  }

  /** Release every held publish in order. */
  flush() {
    this.#assertOpen();
    for (const event of this.queue.splice(0)) this.#deliver(event);
    this.#changed();
  }

  /** Build the `NostrNetworkInterface` one actor hands to its `MarmotClient`. */
  network(actor: string): NostrNetworkInterface {
    this.#assertOpen();
    return {
      publish: async (relays, event) => {
        this.#assertOpen();
        this.#record({ actor, op: "publish", event });
        if (this.paused) this.queue.push(event);
        else this.#deliver(event);
        this.#changed();
        const out: Record<string, PublishResponse> = {};
        for (const from of relays) out[from] = { from, ok: true };
        return out;
      },

      request: async (_relays, filters) => {
        this.#assertOpen();
        // Don't answer before other tabs have shared what they already store.
        await this.ready;
        this.#assertOpen();
        const list = Array.isArray(filters) ? filters : [filters];
        const results = this.events.filter((e) => matchFilters(list, e));
        this.#record({
          actor,
          op: "request",
          filters: list,
          results: results.length,
        });
        return results;
      },

      subscription: (_relays, filters): Subscribable<NostrEvent> => {
        this.#assertOpen();
        const list = Array.isArray(filters) ? filters : [filters];
        return {
          subscribe: (observer) => {
            this.#assertOpen();
            this.#record({ actor, op: "subscribe", filters: list });
            const sub = {
              id: crypto.randomUUID(),
              actor,
              filters: list,
              next: (event: NostrEvent) => observer.next?.(event),
            };
            // Events synced in from other tabs later arrive through `#store`.
            for (const event of this.events)
              if (matchFilters(list, event)) sub.next(event);
            this.#subs.add(sub);
            const subscription = {
              id: sub.id,
              actor,
              filters: list,
              tab: this.tab,
              at: Date.now(),
            };
            this.#post({ type: "subscription", subscription, active: true });
            return {
              unsubscribe: () => {
                if (!this.#subs.delete(sub)) return;
                this.#post({
                  type: "subscription",
                  subscription,
                  active: false,
                });
                this.#record({ actor, op: "unsubscribe", filters: list });
              },
            };
          },
        };
      },

      // Every actor's inbox is the single demo relay.
      getUserInboxRelays: async () => {
        this.#assertOpen();
        return [DEMO_RELAY_URL];
      },
    };
  }
}

export const DEMO_RELAY_URL = "wss://demo.relay.invalid";
