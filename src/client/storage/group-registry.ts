/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MarmotRumorDatabases } from "./group-history.js";
import { EventSigner } from "applesauce-core";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import { ClientState, CryptoProvider, defaultCryptoProvider } from "ts-mls";
import { deserializeClientState } from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import { RetainedHistoryStore } from "../../engine/retained-store.js";
import {
  disbandRegistryStateKey,
  disbandTombstoneKey,
} from "../../engine/disband-tombstone.js";
import { logger } from "../../utils/debug.js";
import type { MarmotStorage } from "./storage.js";
import { groupKeys } from "./storage-keys.js";
import {
  MarmotGroup,
  type GroupDisbandedEvent,
} from "../group/marmot-group.js";
import type { NostrNetworkInterface } from "../nostr-interface.js";

const log = logger.extend("GroupRegistry");

/** Options accepted by {@link GroupRegistry}. */
export type GroupRegistryOptions = {
  /** Storage scoped to the client's `group/` namespace. */
  storage: MarmotStorage;
  signer: EventSigner;
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by loaded groups. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  cryptoProvider?: CryptoProvider;
  /** Per-group rumor databases for message history (in memory when omitted). */
  rumors?: MarmotRumorDatabases;
  /** Convergence policy applied to loaded groups (rollback horizon, selection). */
  convergencePolicy?: ConvergencePolicy;
  /** Ingestion-pool tuning applied to loaded groups (size + epoch-age bounds). */
  ingestionPool?: IngestionPoolOptions;
};

/** Cache-level events emitted by {@link GroupRegistry}. */
export type GroupRegistryEvents = {
  /** Emitted when the set of loaded (cached) groups changes. */
  updated: (groups: MarmotGroup[]) => void;
  /** Emitted when a group is loaded from the store into the cache. */
  loaded: (group: MarmotGroup) => void;
  /** Emitted when an inbound commit removed the client from a tracked group. */
  removed: (group: MarmotGroup) => void;
  /** Emitted after durable canonical disband notification delivery is recorded. */
  disbanded: (group: MarmotGroup, evidence: GroupDisbandedEvent) => void;
};

/**
 * Owns the in-memory cache of {@link MarmotGroup} instances and the
 * store-backed read/hydrate path: caching, per-group destroy listeners,
 * concurrent-load deduplication, and group construction from a
 * {@link ClientState}. The orchestrating {@link GroupsManager} layers the
 * higher-level lifecycle events (created/imported/joined/destroyed/left) on top.
 */
export class GroupRegistry extends EventEmitter<GroupRegistryEvents> {
  readonly storage: MarmotStorage;
  readonly signer: EventSigner;
  readonly network: NostrNetworkInterface;
  readonly audit?: AuditSink;
  readonly auditContext?: AuditContextOptions;
  readonly cryptoProvider: CryptoProvider;
  readonly rumors?: MarmotRumorDatabases;
  readonly convergencePolicy?: ConvergencePolicy;
  readonly ingestionPool?: IngestionPoolOptions;

  /** In-memory cache of loaded group instances, keyed by hex group id */
  #groups = new Map<string, MarmotGroup>();

  /** Per-group listener handles, so we can detach them when a group is unloaded. */
  #groupListeners = new Map<
    string,
    {
      destroyed: () => void;
      removed: () => void;
      disbanded: (group: MarmotGroup, evidence: GroupDisbandedEvent) => void;
    }
  >();

  /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
  #groupLoadPromises = new Map<string, Promise<MarmotGroup>>();

  /** Group ids provisionally cached while their post-hydration activation runs. */
  #activatingGroups = new Set<string>();

  constructor(options: GroupRegistryOptions) {
    super();
    this.storage = options.storage;
    this.signer = options.signer;
    this.network = options.network;
    this.audit = options.audit;
    this.auditContext = options.auditContext;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.rumors = options.rumors;
    this.convergencePolicy = options.convergencePolicy;
    this.ingestionPool = options.ingestionPool;
  }

  /** Returns the list of currently loaded (cached) group instances. */
  get loaded(): MarmotGroup[] {
    return Array.from(this.#groups.entries())
      .filter(([id]) => !this.#activatingGroups.has(id))
      .map(([, group]) => group);
  }

  /** Reads the cached instance for a group id, without loading from the store. */
  peek(groupId: Uint8Array | string): MarmotGroup | undefined {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    return this.#groups.get(id);
  }

  /** Builds a group instance from a {@link ClientState} (not cached). */
  async build(
    state: ClientState,
    retained?: RetainedHistoryStore,
    historyTree?: GroupHistoryTree,
  ): Promise<MarmotGroup> {
    return MarmotGroup.fromClientState(state, {
      storage: this.storage,
      retained,
      historyTree,
      convergencePolicy: this.convergencePolicy,
      ingestionPool: this.ingestionPool,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      audit: this.audit,
      auditContext: this.auditContext,
      rumors: this.rumors,
    });
  }

  /** Loads a group from the store, hydrated but not cached. */
  async load(groupId: Uint8Array | string): Promise<MarmotGroup> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    const idHex = bytesToHex(id);
    log("loading group %s from store", idHex);
    const stateBytes =
      (await this.storage.get(groupKeys.state(idHex))) ??
      (await this.storage.get(disbandRegistryStateKey(idHex)));

    if (!stateBytes) throw new Error(`Group ${idHex} not found`);

    const state = deserializeClientState(stateBytes);
    const historyTree = await this.#loadHistory(idHex, state);
    // The bounded convergence window is derived from the tree (the single
    // persisted source), never stored separately.
    const retained = historyTree
      ? await this.#retainedFromTree(historyTree, state)
      : undefined;

    const group = await this.build(state, retained, historyTree);
    await group.session.hydrateRemovalEvidence();
    return group;
  }

  /**
   * Rehydrates durable history before constructing an admitted session. A
   * committed checkpoint is authority: required loss must never reseed the tip.
   */
  async #loadHistory(
    idHex: string,
    state: ClientState,
  ): Promise<GroupHistoryTree | undefined> {
    const metadata = await this.storage.get(`${idHex}/tree/meta`);
    if (!metadata) {
      // Absence is optional only when no owned history was ever persisted.
      const owned = (await this.storage.list(`${idHex}/tree/`)).length > 0;
      if (owned)
        throw new Error("GroupHistoryTree: required checkpoint missing");
      return undefined;
    }
    let tree: GroupHistoryTree | undefined;
    try {
      tree = await GroupHistoryTree.load(this.storage, idHex);
    } catch (error) {
      throw new Error(
        `GroupHistoryTree: failed to restore required history: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!tree) throw new Error("GroupHistoryTree: checkpoint disappeared");
    const tipTag = bytesToHex(state.confirmationTag);
    if (!tree.hasNode(tipTag)) {
      if (metadata[0] === 1) {
        log(
          "discarding stale legacy history tree for %s (missing tip node)",
          idHex,
        );
        return undefined;
      }
      throw new Error(
        "GroupHistoryTree: canonical tip missing from checkpoint",
      );
    }
    if (
      bytesToHex(state.groupContext.groupId) !== idHex ||
      tree.epochOf(tipTag) !== Number(state.groupContext.epoch)
    )
      throw new Error(
        "GroupHistoryTree: canonical state disagrees with checkpoint",
      );
    // Complete exact-key materialization, deletion and acknowledgement before
    // build/hydration can trigger callbacks or accept any public group work.
    await tree.resumeRetentionCleanup();
    return tree;
  }

  /**
   * Rebuilds the bounded convergence window from the tree's canonical path
   * (root → the loaded tip), so fork recovery has the sync access it needs.
   * Membership already encodes finite bounds and exact pending-work pins. A
   * second age cutoff here would erase pinned pristine exporters on restart.
   */
  async #retainedFromTree(
    tree: GroupHistoryTree,
    state: ClientState,
  ): Promise<RetainedHistoryStore | undefined> {
    const tipTag = bytesToHex(state.confirmationTag);
    const fullPath = tree.path(tipTag);
    if (!fullPath || fullPath.length === 0) return undefined;

    const path = fullPath;

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
      const ownCommitStamp = await tree.ownCommitStampOf(path[i]);
      retained.record(states[i - 1], commit, states[i], [], ownCommitStamp);
    }
    return retained;
  }

  /** Caches a group, attaches lifecycle forwarders, then activates its state. */
  async track(group: MarmotGroup): Promise<void> {
    const id = bytesToHex(group.id);
    this.#activatingGroups.add(id);
    this.#groups.set(id, group);

    // If a group self-destroys, drop it from the cache so `loaded` stays accurate.
    const destroyed = () => this.untrack(id);
    group.on("destroyed", destroyed);
    // Involuntary removal keeps the tombstone (group stays tracked); forward the
    // signal so the manager can re-emit it to the application.
    const removed = () => this.emit("removed", group);
    group.on("removed", removed);
    const disbanded = (_group: MarmotGroup, evidence: GroupDisbandedEvent) =>
      this.emit("disbanded", group, evidence);
    group.on("disbanded", disbanded);
    const listeners = { destroyed, removed, disbanded };
    this.#groupListeners.set(id, listeners);

    try {
      // Hydration is deliberately side-effect free. Persisted competing tips can
      // change canonical state (including landing on removal), so activate them
      // only after every public lifecycle forwarder is attached.
      await group.session.hydrateLifecycleEvidence();
      // D-11/D-12: a group outside the current account identity proof profile
      // still loads and is fully hydrated above, but activation steps that can
      // trigger outbound work (reconvergence, resumed disband) are skipped for
      // it — nothing is published automatically. `getGroupProfileSupport` is
      // non-throwing (D-11), so classification can never reject this
      // `Promise.all`-batched load or any sibling group's load.
      const profileSupported = group.profileSupport.kind === "supported";
      if (!profileSupported)
        log(
          "group %s is outside the current account identity proof profile (%s); loading without reconvergence or resumed disband",
          id,
          group.profileSupport.kind === "unsupported"
            ? group.profileSupport.proofReason
            : undefined,
        );
      if (
        profileSupported &&
        (group.forkTree.tips().length > 1 ||
          group.session.removalBlocked ||
          group.session.removalEvidence)
      )
        await group.reconverge();
      await group.realizeRemovalIfNeeded();
      await group.realizeDisbandIfNeeded();
      if (profileSupported) await group.resumePendingDisband();
      this.#activatingGroups.delete(id);
      this.emit("updated", this.loaded);
    } catch (error) {
      // Activation is atomic from the registry's perspective. Always detach and
      // dispose this failed instance, but only remove cache entries that still
      // point to it so a stale rejection cannot evict a newer activation.
      group.off("destroyed", destroyed);
      group.off("removed", removed);
      group.off("disbanded", disbanded);
      if (this.#groups.get(id) === group) {
        this.#groups.delete(id);
        this.#activatingGroups.delete(id);
        if (this.#groupListeners.get(id) === listeners)
          this.#groupListeners.delete(id);
      }
      group.dispose();
      throw error;
    }
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
      existing.off("disbanded", listeners.disbanded);
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
    const ids = new Set<string>();
    for (const key of await this.storage.list("")) {
      const match = /^([0-9a-f]+)\/(state|disband\/terminal)$/.exec(key);
      if (match) ids.add(match[1]!);
    }
    return [...ids].map((key) => hexToBytes(key));
  }

  /** Checks if a group exists in the backend. */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    return (
      (await this.storage.get(groupKeys.state(key))) !== undefined ||
      (await this.storage.get(disbandTombstoneKey(key))) !== undefined
    );
  }

  /** Gets a group from cache or loads it from the store, caching the result. */
  async get(groupId: Uint8Array | string): Promise<MarmotGroup> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    const existingLoad = this.#groupLoadPromises.get(id);
    if (existingLoad) return existingLoad;

    let group = this.#groups.get(id);

    if (!group) {
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

    return group;
  }

  /** Loads all groups from the store and returns them. */
  async loadAll(): Promise<MarmotGroup[]> {
    const groupIds = await this.listIds();
    return Promise.all(groupIds.map((groupId) => this.get(groupId)));
  }
}
