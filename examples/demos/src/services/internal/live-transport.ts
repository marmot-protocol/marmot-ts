import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import { RelayPool } from "applesauce-relay";
import { Subject, lastValueFrom, takeUntil, toArray } from "rxjs";
import { LIVE_RELAYS, LOOKUP_RELAYS } from "./relays.js";

/** Relay networking only; contacts owns its event cache and discovery. */
export class LiveTransport implements NostrNetworkInterface {
  readonly #closed = new Subject<void>();
  #disposed = false;

  constructor(readonly pool = new RelayPool()) {}

  #assertOpen() {
    if (this.#disposed) throw new Error("Transport closed");
  }

  publish: NostrNetworkInterface["publish"] = async (relays, event) => {
    this.#assertOpen();
    const responses = await this.pool.publish(relays, event);
    this.#assertOpen();
    return Object.fromEntries(
      responses.map((response) => [response.from, response]),
    );
  };

  request: NostrNetworkInterface["request"] = async (relays, filters) => {
    this.#assertOpen();
    const list = Array.isArray(filters) ? filters : [filters];
    const events = await lastValueFrom(
      this.pool.request(relays, list).pipe(takeUntil(this.#closed), toArray()),
    );
    this.#assertOpen();
    return events;
  };

  subscription: NostrNetworkInterface["subscription"] = (relays, filters) => {
    this.#assertOpen();
    return {
      subscribe: (observer) => {
        this.#assertOpen();
        return this.pool
          .subscription(relays, Array.isArray(filters) ? filters : [filters])
          .pipe(takeUntil(this.#closed))
          .subscribe(observer);
      },
    };
  };

  getUserInboxRelays: NostrNetworkInterface["getUserInboxRelays"] = async (
    pubkey,
  ) => {
    const events = await this.request(LOOKUP_RELAYS, {
      kinds: [10050],
      authors: [pubkey],
    });
    const latest = events.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    )[0];
    const relays = latest?.tags
      .filter((tag) => tag[0] === "relay" && /^wss?:\/\//.test(tag[1] ?? ""))
      .map((tag) => tag[1]);
    return relays?.length ? [...new Set(relays)] : [...LIVE_RELAYS];
  };

  close() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closed.next();
    this.#closed.complete();
    this.pool.close();
  }
}
