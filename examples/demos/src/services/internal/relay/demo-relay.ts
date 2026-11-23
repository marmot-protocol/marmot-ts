import type {
  NostrNetworkInterface,
  PublishResponse,
} from "@internet-privacy/marmot-ts/client";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { matchFilters, type Filter } from "applesauce-core/helpers/filter";
import type { SyncMessage } from "./relay-protocol.js";
import type { RelayLogEntry } from "./relay-inspector.js";
export type { SyncMessage } from "./relay-protocol.js";

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
 * A tiny in-browser Nostr transport for demo tabs. It ignores
 * relay URLs (all "relays" are this one store) so demos can run several
 * clients side by side with no network access.
 *
 * By default every instance joins a SharedWorker (BroadcastChannel fallback), so all open tabs of
 * the demo app share one relay: publishes in one tab reach subscriptions in
 * the others, and a newly opened tab first copies the relay's stored events.
 * Events are in memory only and disappear when the worker is terminated.
 * The mode-driven transport service owns its lifetime.
 */
export class DemoRelay implements NostrNetworkInterface {
  readonly relays = [DEMO_RELAY_URL];
  readonly events: NostrEvent[] = [];

  /** Short random label identifying this relay instance (usually: this tab). */
  readonly tab = Math.random().toString(16).slice(2, 6);

  #ids = new Set<string>();
  #subs = new Set<{
    id: string;
    filters: Filter[];
    next: (event: NostrEvent) => void;
    complete: () => void;
  }>();
  #channelName: string | false;
  #channel?: BroadcastChannel;
  #worker?: SharedWorker;
  #ready: Promise<void> = Promise.resolve();
  #resolveReady?: () => void;
  #syncTimer?: ReturnType<typeof setTimeout>;
  #disposed = false;

  constructor(options: DemoRelayOptions = {}) {
    this.#channelName = options.channel ?? DEMO_RELAY_CHANNEL;
    this.#connect();
  }

  /** Resolves once events from already-open tabs have been copied in. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Join the shared channel and copy in events other tabs already store. */
  #connect() {
    if (this.#channel || this.#worker || this.#channelName === false) return;
    if (typeof SharedWorker !== "undefined") {
      const worker = new SharedWorker(
        new URL("./demo-relay.worker.ts", import.meta.url),
        { type: "module", name: this.#channelName },
      );
      this.#worker = worker;
      let synced!: () => void;
      this.#ready = new Promise((resolve) => (synced = resolve));
      this.#resolveReady = synced;
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
    this.#resolveReady = synced;
    channel.onmessage = (message: MessageEvent<SyncMessage>) =>
      this.#receive(message.data, synced);
    this.#post({ type: "hello", from: this.tab });
    // Nobody answering just means this is the first tab.
    this.#syncTimer = setTimeout(synced, SYNC_TIMEOUT_MS);
  }

  get transport(): string {
    return this.#worker
      ? "SharedWorker"
      : this.#channel
        ? "BroadcastChannel"
        : "local";
  }

  /** Permanently dispose this connection and its subscriptions. */
  close() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#syncTimer);
    // Wake pending reads so their disposal check can reject instead of hanging.
    this.#resolveReady?.();
    for (const sub of this.#subs) sub.complete();
    this.#subs.clear();
    this.#worker?.port.postMessage({ type: "disconnect" });
    this.#worker?.port.close();
    this.#worker = undefined;
    this.#channel?.close();
    this.#channel = undefined;
  }

  #assertOpen() {
    if (this.#disposed) throw new Error("Transport closed");
  }

  #post(message: SyncMessage) {
    this.#worker?.port.postMessage(message);
    this.#channel?.postMessage(message);
  }

  #receive(message: SyncMessage, synced: () => void) {
    if (this.#disposed) return;
    switch (message.type) {
      case "hello":
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
        this.#ids.clear();
        break;
      case "snapshot":
        if (message.to !== this.tab) break;
        for (const event of message.events) this.#store(event);
        synced();
        break;
      case "event":
        this.#store(message.event);
        break;
    }
  }

  #record(entry: Omit<RelayLogEntry, "id" | "at" | "tab">) {
    const full = { ...entry, at: Date.now() };
    this.#post({ type: "log", from: this.tab, entry: full });
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

  publish: NostrNetworkInterface["publish"] = async (relays, event) => {
    this.#assertOpen();
    this.#record({ op: "publish", event });
    this.#deliver(event);
    const out: Record<string, PublishResponse> = {};
    for (const from of relays) out[from] = { from, ok: true };
    return out;
  };

  request: NostrNetworkInterface["request"] = async (_relays, filters) => {
    this.#assertOpen();
    // Don't answer before other tabs have shared what they already store.
    await this.ready;
    this.#assertOpen();
    const list = Array.isArray(filters) ? filters : [filters];
    const results = this.events.filter((e) => matchFilters(list, e));
    this.#record({
      op: "request",
      filters: list,
      results: results.length,
    });
    return results;
  };

  subscription: NostrNetworkInterface["subscription"] = (_relays, filters) => {
    this.#assertOpen();
    const list = Array.isArray(filters) ? filters : [filters];
    return {
      subscribe: (observer) => {
        this.#assertOpen();
        this.#record({ op: "subscribe", filters: list });
        const sub = {
          id: crypto.randomUUID(),
          filters: list,
          next: (event: NostrEvent) => observer.next?.(event),
          complete: () => observer.complete?.(),
        };
        // Events synced in from other tabs later arrive through `#store`.
        for (const event of this.events)
          if (matchFilters(list, event)) sub.next(event);
        this.#subs.add(sub);
        const subscription = {
          id: sub.id,
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
            this.#record({ op: "unsubscribe", filters: list });
          },
        };
      },
    };
  };

  getUserInboxRelays: NostrNetworkInterface["getUserInboxRelays"] =
    async () => {
      this.#assertOpen();
      return [DEMO_RELAY_URL];
    };
}

export const DEMO_RELAY_URL = "wss://demo.relay.invalid";
