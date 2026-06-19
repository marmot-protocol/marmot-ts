/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import { ClientState, CryptoProvider, defaultCryptoProvider } from "ts-mls";
import {
  deserializeClientState,
  SerializedClientState,
} from "../core/client-state.js";
import { logger } from "../utils/debug.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";

const log = logger.extend("GroupRegistry");

/** Options accepted by {@link GroupRegistry}. */
export type GroupRegistryOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  store: GenericKeyValueStore<SerializedClientState>;
  signer: EventSigner;
  network: NostrNetworkInterface;
  cryptoProvider?: CryptoProvider;
  historyFactory?: GroupHistoryFactory<THistory>;
  mediaFactory?: GroupMediaFactory<TMedia>;
};

/** Cache-level events emitted by {@link GroupRegistry}. */
export type GroupRegistryEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the set of loaded (cached) groups changes. */
  updated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
  /** Emitted when a group is loaded from the store into the cache. */
  loaded: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when an inbound commit removed the client from a tracked group. */
  removed: (group: MarmotGroup<THistory, TMedia>) => void;
};

/**
 * Owns the in-memory cache of {@link MarmotGroup} instances and the
 * store-backed read/hydrate path: caching, per-group destroy listeners,
 * concurrent-load deduplication, and group construction from a
 * {@link ClientState}. The orchestrating {@link GroupsManager} layers the
 * higher-level lifecycle events (created/imported/joined/destroyed/left) on top.
 */
export class GroupRegistry<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> extends EventEmitter<GroupRegistryEvents<THistory, TMedia>> {
  readonly store: GenericKeyValueStore<SerializedClientState>;
  readonly signer: EventSigner;
  readonly network: NostrNetworkInterface;
  readonly cryptoProvider: CryptoProvider;
  readonly historyFactory: GroupHistoryFactory<THistory>;
  readonly mediaFactory: GroupMediaFactory<TMedia>;

  /** In-memory cache of loaded group instances, keyed by hex group id */
  #groups = new Map<string, MarmotGroup<THistory, TMedia>>();

  /** Per-group listener handles, so we can detach them when a group is unloaded. */
  #groupListeners = new Map<
    string,
    { destroyed: () => void; removed: () => void }
  >();

  /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
  #groupLoadPromises = new Map<
    string,
    Promise<MarmotGroup<THistory, TMedia>>
  >();

  constructor(options: GroupRegistryOptions<THistory, TMedia>) {
    super();
    this.store = options.store;
    this.signer = options.signer;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.historyFactory =
      options.historyFactory as GroupHistoryFactory<THistory>;
    this.mediaFactory = options.mediaFactory as GroupMediaFactory<TMedia>;
  }

  /** Returns the list of currently loaded (cached) group instances. */
  get loaded(): MarmotGroup<THistory, TMedia>[] {
    return Array.from(this.#groups.values());
  }

  /** Reads the cached instance for a group id, without loading from the store. */
  peek(
    groupId: Uint8Array | string,
  ): MarmotGroup<THistory, TMedia> | undefined {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    return this.#groups.get(id);
  }

  /** Builds a group instance from a {@link ClientState} (not cached). */
  async build(state: ClientState): Promise<MarmotGroup<THistory, TMedia>> {
    return MarmotGroup.fromClientState<THistory, TMedia>(state, {
      store: this.store,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });
  }

  /** Loads a group from the store, hydrated but not cached. */
  async load(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    log("loading group %s from store", bytesToHex(id));
    const stateBytes = await this.store.getItem(bytesToHex(id));

    if (!stateBytes) throw new Error(`Group ${bytesToHex(id)} not found`);

    return this.build(deserializeClientState(stateBytes));
  }

  /** Caches a group instance and subscribes to its destroy event. */
  track(group: MarmotGroup<THistory, TMedia>): void {
    const id = bytesToHex(group.id);
    this.#groups.set(id, group);

    // If a group self-destroys, drop it from the cache so `loaded` stays accurate.
    const destroyed = () => this.untrack(id);
    group.on("destroyed", destroyed);
    // Involuntary removal keeps the tombstone (group stays tracked); forward the
    // signal so the manager can re-emit it to the application.
    const removed = () => this.emit("removed", group);
    group.on("removed", removed);
    this.#groupListeners.set(id, { destroyed, removed });

    this.emit("updated", this.loaded);
  }

  /** Removes a group instance from the cache and detaches its listeners. */
  untrack(groupId: Uint8Array | string): void {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);

    const existing = this.#groups.get(id);
    if (!existing) return;

    const listeners = this.#groupListeners.get(id);
    if (listeners) {
      existing.off("destroyed", listeners.destroyed);
      existing.off("removed", listeners.removed);
      this.#groupListeners.delete(id);
    }

    // Release the settle-check timer + any queued outbound so an unloaded
    // instance leaves nothing pending (B5).
    existing.dispose();

    this.#groups.delete(id);
    this.emit("updated", this.loaded);
  }

  /** Lists all persisted group IDs, decoded from their hex storage keys. */
  async listIds(): Promise<Uint8Array[]> {
    const keys = await this.store.keys();
    return keys.map((key) => hexToBytes(key));
  }

  /** Checks if a group exists in the backend. */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    const item = await this.store.getItem(key);
    return item !== null;
  }

  /** Gets a group from cache or loads it from the store, caching the result. */
  async get(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    let group = this.#groups.get(id);

    if (!group) {
      const existingLoad = this.#groupLoadPromises.get(id);
      if (existingLoad) {
        group = await existingLoad;
      } else {
        const loadPromise = this.load(groupId)
          .then((loaded) => {
            this.track(loaded);
            this.emit("loaded", loaded);
            return loaded;
          })
          .finally(() => {
            this.#groupLoadPromises.delete(id);
          });

        this.#groupLoadPromises.set(id, loadPromise);
        group = await loadPromise;
      }
    }

    return group;
  }

  /** Loads all groups from the store and returns them. */
  async loadAll(): Promise<MarmotGroup<THistory, TMedia>[]> {
    const groupIds = await this.listIds();
    return Promise.all(groupIds.map((groupId) => this.get(groupId)));
  }
}
