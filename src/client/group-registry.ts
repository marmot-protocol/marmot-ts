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
import {
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
} from "../core/convergence.js";
import { GroupHistoryTree } from "../engine/history-tree.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import { RetainedHistoryStore } from "../engine/retained-store.js";
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
  /** Dedicated store for the per-group full-fork history tree (optional). */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /**
   * Persisted removed-inactive marker store (D-12) inherited by loaded groups;
   * see {@link MarmotGroupOptions.removedMarkerStore}. Without it, removal
   * realization degrades to in-memory-only and cannot survive a restart.
   */
  removedMarkerStore?: GenericKeyValueStore<boolean>;
  signer: EventSigner;
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by loaded groups. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  cryptoProvider?: CryptoProvider;
  historyFactory?: GroupHistoryFactory<THistory>;
  mediaFactory?: GroupMediaFactory<TMedia>;
  /** Convergence policy applied to loaded groups (rollback horizon, selection). */
  convergencePolicy?: ConvergencePolicy;
  /** Ingestion-pool tuning applied to loaded groups (size + epoch-age bounds). */
  ingestionPool?: IngestionPoolOptions;
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
  readonly rewindStore?: GenericKeyValueStore<Uint8Array>;
  readonly removedMarkerStore?: GenericKeyValueStore<boolean>;
  readonly signer: EventSigner;
  readonly network: NostrNetworkInterface;
  readonly audit?: AuditSink;
  readonly auditContext?: AuditContextOptions;
  readonly cryptoProvider: CryptoProvider;
  readonly historyFactory: GroupHistoryFactory<THistory>;
  readonly mediaFactory: GroupMediaFactory<TMedia>;
  readonly convergencePolicy?: ConvergencePolicy;
  readonly ingestionPool?: IngestionPoolOptions;

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
    this.rewindStore = options.rewindStore;
    this.removedMarkerStore = options.removedMarkerStore;
    this.signer = options.signer;
    this.network = options.network;
    this.audit = options.audit;
    this.auditContext = options.auditContext;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.historyFactory =
      options.historyFactory as GroupHistoryFactory<THistory>;
    this.mediaFactory = options.mediaFactory as GroupMediaFactory<TMedia>;
    this.convergencePolicy = options.convergencePolicy;
    this.ingestionPool = options.ingestionPool;
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
  async build(
    state: ClientState,
    retained?: RetainedHistoryStore,
    historyTree?: GroupHistoryTree,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    return MarmotGroup.fromClientState<THistory, TMedia>(state, {
      store: this.store,
      rewindStore: this.rewindStore,
      removedMarkerStore: this.removedMarkerStore,
      retained,
      historyTree,
      convergencePolicy: this.convergencePolicy,
      ingestionPool: this.ingestionPool,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      audit: this.audit,
      auditContext: this.auditContext,
      history: this.historyFactory,
      media: this.mediaFactory,
    });
  }

  /** Loads a group from the store, hydrated but not cached. */
  async load(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    const idHex = bytesToHex(id);
    log("loading group %s from store", idHex);
    const stateBytes = await this.store.getItem(idHex);

    if (!stateBytes) throw new Error(`Group ${idHex} not found`);

    const state = deserializeClientState(stateBytes);
    const historyTree = await this.#loadHistory(idHex, state);
    // The bounded convergence window is derived from the tree (the single
    // persisted source), never stored separately.
    const retained = historyTree
      ? await this.#retainedFromTree(historyTree, state)
      : undefined;

    const group = await this.build(state, retained, historyTree);

    // Re-evaluate the persisted forks from disk: if this client last followed a
    // losing branch, switch to the canonical one now — without waiting for the
    // network to re-deliver the winner. Only worth a pass when a competing fork
    // is actually retained (more than one tip).
    if (historyTree && historyTree.tips().length > 1) await group.reconverge();

    return group;
  }

  /**
   * Rehydrates the full-fork history tree for a group, or `undefined` to start
   * fresh. Discards a tree that does not contain the loaded tip state as a node
   * (a torn write), so a fresh tree is seeded from the tip instead.
   */
  async #loadHistory(
    idHex: string,
    state: ClientState,
  ): Promise<GroupHistoryTree | undefined> {
    if (!this.rewindStore) return undefined;
    try {
      const tree = await GroupHistoryTree.load(this.rewindStore, idHex);
      if (!tree) return undefined;
      const tipTag = bytesToHex(state.confirmationTag);
      if (!tree.hasNode(tipTag)) {
        log("discarding stale history tree for %s (missing tip node)", idHex);
        return undefined;
      }
      return tree;
    } catch (error) {
      log("failed to rehydrate history tree for %s: %o", idHex, error);
      return undefined;
    }
  }

  /**
   * Rebuilds the bounded convergence window from the tree's canonical path
   * (root → the loaded tip), so fork recovery has the sync access it needs. Only
   * the last `maxRewindCommits` epochs are materialized (the whole path when the
   * horizon is infinite); `record` prunes anything older. Returns `undefined` if
   * the path or any snapshot/commit is missing.
   */
  async #retainedFromTree(
    tree: GroupHistoryTree,
    state: ClientState,
  ): Promise<RetainedHistoryStore | undefined> {
    const tipTag = bytesToHex(state.confirmationTag);
    const fullPath = tree.path(tipTag);
    if (!fullPath || fullPath.length === 0) return undefined;

    const horizon =
      this.convergencePolicy?.maxRewindCommits ??
      DEFAULT_CONVERGENCE_POLICY.maxRewindCommits;
    const keep = Number.isFinite(horizon)
      ? Math.max(1, horizon + 1)
      : fullPath.length;
    const path = fullPath.slice(-keep);

    const states: ClientState[] = [];
    for (const tag of path) {
      const s = await tree.stateAt(tag);
      if (!s) return undefined;
      states.push(s);
    }

    const retained = new RetainedHistoryStore(
      states[0],
      this.convergencePolicy,
    );
    for (let i = 1; i < path.length; i++) {
      const commit = await tree.commitMessageOf(path[i]);
      if (!commit) return undefined;
      retained.record(states[i - 1], commit, states[i]);
    }
    return retained;
  }

  /** Caches a group, attaches lifecycle forwarders, then realizes removal. */
  async track(group: MarmotGroup<THistory, TMedia>): Promise<void> {
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
    await group.realizeRemovalIfNeeded();
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
          .then(async (loaded) => {
            await this.track(loaded);
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
