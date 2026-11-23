/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
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
import { logger } from "../../utils/debug.js";
import { groupTreeStore } from "./database/group-batch.js";
import type { MarmotDatabase, MarmotGroupDatabase } from "./database/types.js";
import {
  MarmotGroup,
  type GroupDisbandedEvent,
} from "../group/marmot-group.js";
import type { NostrNetworkInterface } from "../nostr-interface.js";

const log = logger.extend("GroupRegistry");

/** Options accepted by {@link GroupRegistry}. */
export type GroupRegistryOptions = {
  /** The account and per-group databases. */
  database: MarmotDatabase;
  signer: EventSigner;
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by loaded groups. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  cryptoProvider?: CryptoProvider;
  /** Convergence policy applied to loaded groups (rollback horizon, selection). */
  convergencePolicy?: ConvergencePolicy;
  /** Ingestion-pool tuning applied to loaded groups (size + epoch-age bounds). */
  ingestionPool?: IngestionPoolOptions;
};

/** A new group's opened database and how to finish or undo its creation. */
export type GroupStorageHandle = {
  database: MarmotGroupDatabase;
  dropDatabase: () => Promise<void>;
  /** Clears the creation intent once the first save is durable. */
  complete: () => Promise<void>;
  /** Rolls the creation back (database, row and intent). */
  abort: () => Promise<void>;
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
  readonly database: MarmotDatabase;
  readonly signer: EventSigner;
  readonly network: NostrNetworkInterface;
  readonly audit?: AuditSink;
  readonly auditContext?: AuditContextOptions;
  readonly cryptoProvider: CryptoProvider;
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
  #disposed = false;

  constructor(options: GroupRegistryOptions) {
    super();
    this.database = options.database;
    this.signer = options.signer;
    this.network = options.network;
    this.audit = options.audit;
    this.auditContext = options.auditContext;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.convergencePolicy = options.convergencePolicy;
    this.ingestionPool = options.ingestionPool;
  }

  /** Returns the list of currently loaded (cached) group instances. */
  get loaded(): MarmotGroup[] {
    return Array.from(this.#groups.entries())
      .filter(([id]) => !this.#activatingGroups.has(id))
      .map(([, group]) => group);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Groups manager disposed");
  }

  /** Releases cached and activating groups; pending loads cannot repopulate them. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of this.#groups.keys()) this.untrack(id);
  }

  /** Reads the cached instance for a group id, without loading from the store. */
  peek(groupId: Uint8Array | string): MarmotGroup | undefined {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    return this.#groups.get(id);
  }

  #reconciled: Promise<void> | undefined;

  /**
   * Finishes or undoes operations that span the account and a group database
   * and were interrupted (see `intents`). Runs once, before the first read.
   */
  #reconcile(): Promise<void> {
    this.#reconciled ??= (async () => {
      for (const intent of await this.database.account.intents.all()) {
        const id = intent.groupId;
        if (intent.kind === "destroy") {
          await this.#finishDrop(id, intent.id);
          continue;
        }
        // An interrupted create/join is complete once its first save landed
        // (a disbanded group keeps its tombstone instead of canonical state).
        const database = await this.database.groups.open(id);
        const record = await database.group();
        const saved =
          record.state !== undefined || record.disbandTombstone !== undefined;
        await database.close();
        if (saved)
          await this.database.account.transaction((tx) =>
            tx.intents.delete(intent.id),
          );
        else await this.#finishDrop(id, intent.id);
      }
    })();
    return this.#reconciled;
  }

  /** Drops a group's database, then its row and the given intent together. */
  async #finishDrop(id: string, intentId: string): Promise<void> {
    await this.database.groups.drop(id);
    await this.database.account.transaction(async (tx) => {
      await tx.groups.delete(id);
      await tx.intents.delete(intentId);
    });
  }

  /**
   * Permanently deletes a group: its database, then its account row. A
   * `destroy` intent makes the two steps resumable after a crash. Missing
   * groups are not an error.
   */
  async drop(groupId: Uint8Array | string): Promise<void> {
    await this.#reconcile();
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    const intentId = `destroy:${id}`;
    await this.database.account.transaction((tx) =>
      tx.intents.put({ id: intentId, kind: "destroy", groupId: id }),
    );
    await this.#finishDrop(id, intentId);
  }

  /**
   * Registers a new group and opens its database. The account row and a
   * `create` intent commit together; call `complete()` after the group's first
   * save, or `abort()` if it failed. An interrupted creation is completed or
   * rolled back the next time the registry starts.
   */
  async prepare(
    state: ClientState,
    kind: "create" | "join" = "create",
  ): Promise<GroupStorageHandle> {
    this.#assertActive();
    await this.#reconcile();
    this.#assertActive();
    const id = bytesToHex(state.groupContext.groupId);
    const intentId = `${kind}:${id}`;
    await this.database.account.transaction(async (tx) => {
      await tx.groups.put({ id, status: "active" });
      await tx.intents.put({ id: intentId, kind, groupId: id });
    });
    return {
      database: await this.database.groups.open(id),
      dropDatabase: () => this.drop(id),
      complete: () =>
        this.database.account.transaction((tx) => tx.intents.delete(intentId)),
      abort: () => this.#finishDrop(id, intentId),
    };
  }

  /** Builds a group instance from a {@link ClientState} (not cached). */
  async build(
    state: ClientState,
    database: MarmotGroupDatabase,
    retained?: RetainedHistoryStore,
    historyTree?: GroupHistoryTree,
  ): Promise<MarmotGroup> {
    const id = bytesToHex(state.groupContext.groupId);
    return MarmotGroup.fromClientState(state, {
      database,
      dropDatabase: () => this.drop(id),
      retained,
      historyTree,
      convergencePolicy: this.convergencePolicy,
      ingestionPool: this.ingestionPool,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      audit: this.audit,
      auditContext: this.auditContext,
    });
  }

  /** Loads a group from the store, hydrated but not cached. */
  async load(groupId: Uint8Array | string): Promise<MarmotGroup> {
    this.#assertActive();
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    const idHex = bytesToHex(id);
    log("loading group %s from store", idHex);
    await this.#reconcile();
    if (!(await this.database.account.groups.get(idHex)))
      throw new Error(`Group ${idHex} not found`);
    const database = await this.database.groups.open(idHex);
    const record = await database.group();
    const canonical = record.state !== undefined;
    const stateBytes = record.state ?? record.registryState;

    if (!stateBytes) {
      await database.close();
      throw new Error(`Group ${idHex} not found`);
    }

    const state = deserializeClientState(stateBytes);
    const historyTree = await this.#loadHistory(
      database,
      idHex,
      state,
      canonical,
    );
    // The bounded convergence window is derived from the tree (the single
    // persisted source), never stored separately.
    const retained = historyTree
      ? await this.#retainedFromTree(historyTree, state)
      : undefined;

    const group = await this.build(state, database, retained, historyTree);
    await group.session.hydrateRemovalEvidence();
    return group;
  }

  /**
   * Rehydrates durable history before constructing an admitted session. A
   * committed checkpoint is authority: required loss must never reseed the tip.
   */
  async #loadHistory(
    database: MarmotGroupDatabase,
    idHex: string,
    state: ClientState,
    canonical: boolean,
  ): Promise<GroupHistoryTree | undefined> {
    // The checkpoint commits atomically with the nodes it names. A group with
    // no persisted history has neither; a persisted tip node without its
    // checkpoint means required history was lost. A terminal (disbanded)
    // group may have purged its tree.
    const store = groupTreeStore(database);
    if (!(await store.checkpoint())) {
      if (
        canonical &&
        (await database.treeNodes.get(bytesToHex(state.confirmationTag)))
      )
        throw new Error("GroupHistoryTree: required checkpoint missing");
      return undefined;
    }
    let tree: GroupHistoryTree | undefined;
    try {
      tree = await GroupHistoryTree.load(store, idHex);
    } catch (error) {
      throw new Error(
        `GroupHistoryTree: failed to restore required history: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!tree) throw new Error("GroupHistoryTree: checkpoint disappeared");
    const tipTag = bytesToHex(state.confirmationTag);
    if (!tree.hasNode(tipTag)) {
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
    if (this.#disposed) {
      group.dispose();
      this.#assertActive();
    }
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
      this.#assertActive();
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
      this.#assertActive();
      await group.realizeRemovalIfNeeded();
      this.#assertActive();
      await group.realizeDisbandIfNeeded();
      this.#assertActive();
      if (profileSupported) await group.resumePendingDisband();
      this.#assertActive();
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
    this.#activatingGroups.delete(id);
    this.emit("updated", this.loaded);
  }

  /** Lists the ids of every persisted group (from the account `groups` table). */
  async listIds(): Promise<Uint8Array[]> {
    await this.#reconcile();
    const ids: Uint8Array[] = [];
    for (const row of await this.database.account.groups.all())
      if (await this.has(row.id)) ids.push(hexToBytes(row.id));
    return ids;
  }

  /**
   * Checks if a group exists: it has an account row and its database holds
   * canonical state or a disband tombstone.
   */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    await this.#reconcile();
    if (!(await this.database.account.groups.get(key))) return false;
    const database = await this.database.groups.open(key);
    try {
      const record = await database.group();
      return (
        record.state !== undefined || record.disbandTombstone !== undefined
      );
    } finally {
      await database.close();
    }
  }

  /** Gets a group from cache or loads it from the store, caching the result. */
  async get(groupId: Uint8Array | string): Promise<MarmotGroup> {
    this.#assertActive();
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
