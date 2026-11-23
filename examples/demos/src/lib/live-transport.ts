import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import { EventStore } from "applesauce-core";
import { castUser } from "applesauce-common/casts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { RelayPool } from "applesauce-relay";
import { Subject, lastValueFrom, merge, takeUntil, tap, toArray } from "rxjs";
import type { RelayLogEntry } from "../services/relay/demo-relay.js";
import type { DemoTransport } from "./transport.js";

export const LIVE_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
export const LOOKUP_RELAYS = ["wss://purplepag.es", ...LIVE_RELAYS];

export class LiveTransport implements DemoTransport {
  readonly relays = [...LIVE_RELAYS];
  readonly transport = "Live network";
  readonly shared = false;
  readonly tab = "";
  readonly ready = Promise.resolve();
  readonly log: RelayLogEntry[] = [];
  readonly #closed = new Subject<void>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  #disposed = false;

  constructor(
    readonly store: EventStore,
    readonly pool = new RelayPool(),
  ) {
    merge(store.insert$, store.update$, store.remove$)
      .pipe(takeUntil(this.#closed))
      .subscribe(() => {
        this.#version++;
        for (const listener of this.#listeners) listener();
      });
  }

  get events(): NostrEvent[] {
    return [...this.store.getByFilters({})];
  }
  get version() {
    return this.#version;
  }

  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #record(entry: Omit<RelayLogEntry, "id" | "at">) {
    this.log.push({ ...entry, id: ++this.#version, at: Date.now() });
    for (const listener of this.#listeners) listener();
  }

  #assertOpen() {
    if (this.#disposed) throw new Error("Transport closed");
  }

  network(actor: string): NostrNetworkInterface {
    return {
      publish: async (relays, event) => {
        this.#assertOpen();
        this.#record({ actor, op: "publish", event });
        const responses = await this.pool.publish(relays, event);
        if (!this.#disposed && responses.some((response) => response.ok))
          this.store.add(event);
        return Object.fromEntries(
          responses.map((response) => [response.from, response]),
        );
      },
      request: async (relays, filters) => {
        this.#assertOpen();
        const list = Array.isArray(filters) ? filters : [filters];
        const events = await lastValueFrom(
          this.pool.request(relays, list).pipe(
            takeUntil(this.#closed),
            tap((event) => this.store.add(event)),
            toArray(),
          ),
        );
        this.#assertOpen();
        this.#record({
          actor,
          op: "request",
          filters: list,
          results: events.length,
        });
        return events;
      },
      subscription: (relays, filters) => ({
        subscribe: (observer) => {
          this.#assertOpen();
          const list = Array.isArray(filters) ? filters : [filters];
          this.#record({ actor, op: "subscribe", filters: list });
          const sub = this.pool
            .subscription(relays, list)
            .pipe(
              takeUntil(this.#closed),
              tap((event) => {
                this.store.add(event);
              }),
            )
            .subscribe(observer);
          return {
            unsubscribe: () => {
              sub.unsubscribe();
              this.#record({ actor, op: "unsubscribe", filters: list });
            },
          };
        },
      }),
      getUserInboxRelays: async (pubkey) => {
        const network = this.network(actor);
        await network.request(LOOKUP_RELAYS, {
          kinds: [10050],
          authors: [pubkey],
        });
        return await castUser(pubkey, this.store).directMessageRelays$.$first(
          1000,
          this.relays,
        );
      },
    };
  }

  close() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closed.next();
    this.#closed.complete();
    this.pool.close();
    this.#listeners.clear();
  }
}
