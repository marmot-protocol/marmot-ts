import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { RelayPool as AsRelayPool } from "applesauce-relay/pool";
import type {
  AuthSigner,
  RelayAuthHandler,
  RelayRequestOptions,
} from "applesauce-relay/types";

import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";

import { createRelayAuthHandler } from "./relay-auth.js";
import type { Directory } from "./discovery.js";

function resolveRelays(relays: string[], fallback: string[]): string[] {
  return relays.length ? relays : fallback;
}

export interface RelayPoolOptions {
  /**
   * When set, relays that refuse a REQ/EVENT with `auth-required` are
   * answered with a NIP-42 AUTH signed by this signer (see relay-auth.ts).
   */
  authSigner?: AuthSigner;
}

/**
 * Thin adapter over `applesauce-relay`'s {@link AsRelayPool} that implements
 * marmot-ts's {@link NostrNetworkInterface} for the TUI demo. The pool is shared
 * with the {@link Directory} so relay-list/profile discovery reuses the same
 * connections, and `getUserInboxRelays` delegates to the Directory's loader.
 * When constructed with an `authSigner` it also answers NIP-42 AUTH challenges
 * for relays that demand auth (see relay-auth.ts).
 */
export class RelayPool implements NostrNetworkInterface {
  /** Relays used when a call passes an empty relay list. Mutable: startup may
   * adopt the user's published NIP-65 relays after construction. */
  defaultRelays: string[];

  readonly #pool: AsRelayPool;
  readonly #directory: Directory;
  #onAuthRequired?: RelayAuthHandler;
  #closed = false;

  constructor(
    pool: AsRelayPool,
    defaultRelays: string[],
    directory: Directory,
    options: RelayPoolOptions = {},
  ) {
    this.#pool = pool;
    this.defaultRelays = defaultRelays;
    this.#directory = directory;
    if (options.authSigner) {
      this.#onAuthRequired = createRelayAuthHandler(options.authSigner);
    }
  }

  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    if (this.#closed) return {};
    const targets = resolveRelays(relays, this.defaultRelays);
    const results: Record<string, PublishResponse> = {};
    // Start every permitted target before releasing the first ACK. Outstanding
    // attempts continue independently and cannot undo a successful publication.
    return new Promise((resolve) => {
      const targetsLeft = new Set(targets);
      if (!targetsLeft.size) resolve({});
      for (const url of targetsLeft) {
        void Promise.resolve()
          .then(() =>
            this.#pool.relay(url).publish(event, {
              onAuthRequired: this.#onAuthRequired,
            }),
          )
          .then(
            (response) => finish(url, response),
            (error: unknown) =>
              finish(url, {
                from: url,
                ok: false,
                uncertain: true,
                message: error instanceof Error ? error.message : String(error),
              }),
          );
      }
      function finish(url: string, response: PublishResponse): void {
        results[url] = response;
        targetsLeft.delete(url);
        if (response.ok || !targetsLeft.size) resolve({ ...results });
      }
    });
  }

  async request(
    relays: string[],
    filters: Filter | Filter[],
    /**
     * Set `waitForAuth: false` for public lookups that should fail rather
     * than authenticate when a relay refuses them. Authentication in v7 is
     * scoped to each operation; unrelated public requests remain independent.
     */
    options?: Pick<RelayRequestOptions, "waitForAuth">,
  ): Promise<NostrEvent[]> {
    if (this.#closed) return [];
    const targets = resolveRelays(relays, this.defaultRelays);
    const collected: NostrEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      this.#pool
        .request(targets, filters, {
          onAuthRequired: this.#onAuthRequired,
          ...options,
        })
        .subscribe({
          next: (event) => collected.push(event),
          error: reject,
          complete: () => resolve(),
        });
    });
    return collected;
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    if (this.#closed) {
      return {
        subscribe: (observer) => {
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
      };
    }
    const targets = resolveRelays(relays, this.defaultRelays);
    return this.#pool.subscription(targets, filters, {
      onAuthRequired: this.#onAuthRequired,
    });
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    if (this.#closed) return this.defaultRelays;
    const relays = await this.#directory.welcomeInboxes(
      pubkey,
      this.defaultRelays,
    );
    return relays.length ? relays : this.defaultRelays;
  }

  get relayCount(): number {
    return this.#pool.relays.size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#directory.close();
    this.#pool.close();
  }
}
