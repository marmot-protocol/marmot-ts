/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  type ClientState,
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsMessage,
} from "ts-mls";

import { BinaryReader, BinaryWriter } from "../core/binary.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../core/client-state.js";
import { commitDigest } from "../core/convergence.js";
import {
  emptyTreeWrite,
  type HistoryTreeStore,
  type HistoryTreeWrite,
} from "./history-tree-store.js";
import {
  decodeOwnCommitRecord,
  encodeOwnCommitRecord,
  type OwnCommitConvergenceStamp,
} from "./own-commit-stamp.js";
import {
  projectHistoricalReceivers,
  retainedTopology,
  type HistoryRetentionOptions,
  type HistoryRetentionPlan,
} from "./retention.js";

function retentionPlanIdentity(plan: HistoryRetentionPlan): string {
  return bytesToHex(
    commitDigest(
      new TextEncoder().encode(
        JSON.stringify({
          revision: plan.revision,
          canonicalTipTag: plan.canonicalTipTag,
          rootTag: plan.logicalRootTag,
          tipEpoch: plan.tipEpoch,
          floorEpoch: plan.floorEpoch,
          appFloorEpoch: plan.appFloorEpoch,
          retainedTags: plan.retainedTags,
          excludedTags: plan.excludedTags,
          receivers: [...plan.receiverEpochs],
          snapshots: [...plan.snapshots].map(([tag, bytes]) => [
            tag,
            bytesToHex(bytes),
          ]),
        }),
      ),
    ),
  );
}

interface TreeCheckpoint {
  version: 2;
  rootTag: string;
  members: string[];
  garbage: string[];
  receivers: Record<string, number[] | null>;
  /** Atomic authority for rewrites until their ordinary state keys are durable. */
  projections: Record<string, string>;
  boundary?: {
    parentTag: string;
    epoch: number;
    digest: string;
    senderLeafIndex?: number;
  };
}

/** Wire-format version byte for a persisted node-edge record. */
const HISTORY_TREE_VERSION = 1;
/** Wire-format version byte for a persisted node record (edge + heavy). */
const NODE_RECORD_VERSION = 1;

/** Default number of heavy snapshots kept rehydrated in memory at once. */
const DEFAULT_SNAPSHOT_CACHE = 128;

/** One persisted node: light edge record plus heavy material. */
interface NodeRecord {
  edge: Uint8Array;
  snapshot: Uint8Array;
  commit?: Uint8Array;
}

function encodeNodeRecord(record: NodeRecord): Uint8Array {
  const w = new BinaryWriter()
    .uint8(NODE_RECORD_VERSION)
    .opaque(record.edge)
    .opaque(record.snapshot);
  if (record.commit) w.uint8(1).opaque(record.commit);
  else w.uint8(0);
  return w.build();
}

function decodeNodeRecord(bytes: Uint8Array): NodeRecord {
  const r = new BinaryReader(bytes);
  const version = r.uint8();
  if (version !== NODE_RECORD_VERSION)
    throw new Error(`GroupHistoryTree: unknown node record version ${version}`);
  const edge = r.opaque();
  const snapshot = r.opaque();
  const commit = r.uint8() ? r.opaque() : undefined;
  r.end();
  return { edge, snapshot, commit };
}

/**
 * Protocol-level metadata for one edge — the commit that produced a node from
 * its parent. The decrypted commit bytes themselves are retained separately
 * (see {@link GroupHistoryTree.commitBytesOf}) so the tree is self-contained and
 * replayable without the transport's event store.
 */
export interface HistoryEdge {
  /** SHA-256 (32 bytes) of the commit MLS message bytes — the edge identity. */
  commitDigest: Uint8Array;
  /** The committer's MLS leaf index, when the caller knows it. */
  senderLeafIndex?: number;
}

/**
 * An edge plus its child's pre-serialized snapshot, captured at the moment the
 * child state is produced (see {@link GroupHistoryTree.recordEdge}). Fork
 * recovery emits these so loser branches are retained with pristine snapshots.
 */
export interface EdgeSnapshot {
  /** Parent node tag (must already be in the tree). */
  parentTag: string;
  /** Child node tag (hex of the child state's confirmation tag). */
  childTag: string;
  /** The child state's MLS epoch. */
  childEpoch: number;
  /** Serialized commit `MlsMessage` that produced the child. */
  commitBytes: Uint8Array;
  /** SHA-256 of `commitBytes`. */
  commitDigest: Uint8Array;
  /** Serialized child `ClientState`, captured before any secret zeroing. */
  childSnapshot: Uint8Array;
  /** The committer's MLS leaf index, when known. */
  senderLeafIndex?: number;
}

/**
 * A node in the group history tree: one MLS group state. The node id is the hex
 * of the state's MLS `confirmationTag`, which is unique per state (it is a MAC
 * over the confirmed transcript hash, so two same-epoch forks have distinct
 * tags). Every non-root node has exactly one parent — the state its commit was
 * applied to — so the structure is a tree rooted at the welcome/creation state;
 * more than one child marks a fork.
 */
export interface HistoryNode {
  /** Node id: hex of the MLS confirmation tag. */
  tag: string;
  /** The MLS epoch this state sits at. */
  epoch: number;
  /** Parent node tag, or `undefined` for the root. */
  parentTag?: string;
  /** Child node tags. More than one means a fork was observed at this node. */
  childTags: string[];
  /** Producing commit evidence; a logical boundary retains its original edge. */
  edge?: HistoryEdge;
}

/** Internal mutable node record (children mutated as the tree grows). */
interface MutableNode {
  tag: string;
  epoch: number;
  parentTag?: string;
  childTags: string[];
  edge?: HistoryEdge;
}

/** In-memory heavy material for a node (snapshot, and commit for non-root). */
interface HeavyEntry {
  snapshot: Uint8Array;
  commit?: Uint8Array;
}

/**
 * The retained group history tree (Marmot v2 full-fork history). Holds every
 * retained group state — the canonical branch and eligible forks — as a tree
 * of {@link ClientState} snapshots linked by commit edges. Settled retention
 * publishes authoritative membership before removing obsolete physical keys.
 *
 * The **light index** (per-node epoch/parent/edge metadata) is always resident.
 * **Heavy material** (serialized snapshots + commit bytes) is kept in a bounded
 * in-memory LRU and otherwise fetched from the bound storage on demand,
 * so memory stays bounded even as the tree grows without limit. Newly recorded
 * nodes are pinned in memory until {@link flush} persists them.
 *
 * Snapshots are stored as bytes, never as live `ClientState` objects: ts-mls
 * zeroes a parent state's consumed secrets in place when a commit is processed
 * from it, so a retained live object could be corrupted out from under a
 * sibling-branch replay. Re-deriving a state ({@link stateAt}) decodes a fresh,
 * independent object every call.
 */
export class GroupHistoryTree {
  /** The resident light index — node metadata, always in memory. */
  readonly #nodes = new Map<string, MutableNode>();
  /** Bounded LRU of heavy material; dirty (unflushed) entries are never evicted. */
  readonly #heavy = new Map<string, HeavyEntry>();
  /** Tags whose light + heavy material has not yet been flushed to the store. */
  readonly #dirty = new Map<string, number>();
  #revision = 0;
  #publishedRetention:
    | {
        plan: WeakRef<HistoryRetentionPlan>;
        revision: number;
        identity: string;
      }
    | undefined;
  #checkpoint: TreeCheckpoint | undefined;
  #retentionActive = false;
  #flushing: Promise<void> | undefined;
  /** Max heavy entries kept resident (excluding pinned dirty entries). */
  readonly #cacheMax: number;
  /** The root node tag, or `undefined` while the tree is empty. */
  #rootTag: string | undefined;
  /** Hex group id, derived from the root state; the persistence key prefix. */
  #gid: string | undefined;
  /** Whether the root pointer (meta) needs flushing. */
  #rootDirty = false;
  /** Backing store for heavy material, once bound. */
  #store: HistoryTreeStore | undefined;

  /** Seeds an empty tree, optionally with a root {@link ClientState}. */
  constructor(root?: ClientState, options?: { snapshotCacheSize?: number }) {
    this.#cacheMax = options?.snapshotCacheSize ?? DEFAULT_SNAPSHOT_CACHE;
    if (root) this.setRoot(root);
  }

  /** Logical retained root tag, or `undefined` if empty. */
  get rootTag(): string | undefined {
    return this.#rootTag;
  }

  /** Number of nodes (states) retained in the tree. */
  get size(): number {
    return this.#nodes.size;
  }

  /** Oldest epoch still named by the tree, or `undefined` when it is empty. */
  oldestEpoch(): number | undefined {
    let oldest: number | undefined;
    for (const node of this.#nodes.values())
      if (oldest === undefined || node.epoch < oldest) oldest = node.epoch;
    return oldest;
  }

  /** Whether unflushed changes are pending. */
  get isDirty(): boolean {
    return this.#dirty.size > 0 || this.#rootDirty;
  }

  /**
   * Sets the root from a {@link ClientState}. The root carries no commit edge.
   * Throws if a different root is already set (a tree has exactly one root).
   */
  setRoot(state: ClientState): string {
    this.#assertMutable();
    const tag = bytesToHex(state.confirmationTag);
    if (this.#rootTag !== undefined && this.#rootTag !== tag) {
      throw new Error("GroupHistoryTree: root already set to a different node");
    }
    if (!this.#nodes.has(tag)) {
      this.#nodes.set(tag, {
        tag,
        epoch: Number(state.groupContext.epoch),
        childTags: [],
      });
      this.#markDirty(tag);
      this.#putHeavy(tag, { snapshot: serializeClientState(state) });
    }
    this.#rootTag = tag;
    this.#gid = bytesToHex(state.groupContext.groupId);
    this.#rootDirty = true;
    return tag;
  }

  /** Whether a node with `tag` exists. */
  hasNode(tag: string): boolean {
    return this.#nodes.has(tag);
  }

  /** Returns a read-only view of a node, or `undefined` if absent. */
  node(tag: string): HistoryNode | undefined {
    const n = this.#nodes.get(tag);
    if (!n) return undefined;
    return {
      tag: n.tag,
      epoch: n.epoch,
      parentTag: n.parentTag,
      childTags: [...n.childTags],
      edge: n.edge,
    };
  }

  /** All node tags, in insertion order. */
  tags(): string[] {
    return [...this.#nodes.keys()];
  }

  /** The epoch of a node, or `undefined` if absent. */
  epochOf(tag: string): number | undefined {
    return this.#nodes.get(tag)?.epoch;
  }

  /** The parent tag of a node, or `undefined` for the root / absent node. */
  parentOf(tag: string): string | undefined {
    return this.#nodes.get(tag)?.parentTag;
  }

  /** Child tags of a node (empty for a tip or an absent node). */
  childrenOf(tag: string): string[] {
    const n = this.#nodes.get(tag);
    return n ? [...n.childTags] : [];
  }

  /** Whether a node is a tip (exists and has no children). */
  isTip(tag: string): boolean {
    const n = this.#nodes.get(tag);
    return n !== undefined && n.childTags.length === 0;
  }

  /** All tip tags (leaf states) — the candidate branches for convergence. */
  tips(): string[] {
    const out: string[] = [];
    for (const n of this.#nodes.values())
      if (n.childTags.length === 0) out.push(n.tag);
    return out;
  }

  /** All node tags sitting at `epoch`. */
  nodesAtEpoch(epoch: number): string[] {
    const out: string[] = [];
    for (const n of this.#nodes.values())
      if (n.epoch === epoch) out.push(n.tag);
    return out;
  }

  /**
   * The path from the root to `tag` (inclusive of both), or `undefined` if the
   * node is absent or its chain to the root is broken.
   */
  path(tag: string): string[] | undefined {
    const out: string[] = [];
    let cursor: string | undefined = tag;
    const seen = new Set<string>();
    while (cursor !== undefined) {
      if (seen.has(cursor)) return undefined; // cycle guard (should never happen)
      seen.add(cursor);
      const n = this.#nodes.get(cursor);
      if (!n) return undefined;
      out.push(cursor);
      cursor = n.parentTag;
    }
    out.reverse();
    return out;
  }

  /** Ancestor tags of a node, nearest-first (excludes the node itself). */
  ancestors(tag: string): string[] {
    const full = this.path(tag);
    if (!full) return [];
    // path is root..tag; drop the node itself and reverse to nearest-first.
    return full.slice(0, -1).reverse();
  }

  /**
   * The lowest common ancestor of two nodes (the fork point), or `undefined` if
   * they share no ancestor (e.g. live in different trees).
   */
  lowestCommonAncestor(a: string, b: string): string | undefined {
    const pathA = this.path(a);
    if (!pathA) return undefined;
    const ancestorsA = new Set(pathA);
    let cursor: string | undefined = b;
    while (cursor !== undefined) {
      if (ancestorsA.has(cursor)) return cursor;
      cursor = this.#nodes.get(cursor)?.parentTag;
    }
    return undefined;
  }

  /**
   * The serialized `ClientState` snapshot bytes for a node, or `undefined` if
   * absent. Served from the in-memory cache, else fetched from the store.
   */
  async snapshotOf(tag: string): Promise<Uint8Array | undefined> {
    if (!this.#nodes.has(tag)) return undefined;
    const cached = this.#heavy.get(tag);
    if (cached) {
      this.#touch(tag);
      return cached.snapshot;
    }
    if (!this.#store || !this.#gid) return undefined;
    const projection = this.#checkpoint?.projections[tag];
    if (projection !== undefined) {
      const bytes = hexToBytes(projection);
      this.#putHeavy(tag, { snapshot: bytes });
      return bytes;
    }
    const record = await this.#readNode(tag);
    if (!record) return undefined;
    this.#putHeavy(tag, { snapshot: record.snapshot });
    return record.snapshot;
  }

  /**
   * Rehydrates a node's state into a fresh, independent {@link ClientState}, or
   * `undefined` if no snapshot is retained. Each call decodes a new object, so
   * callers may mutate/advance it without affecting the tree.
   */
  async stateAt(tag: string): Promise<ClientState | undefined> {
    const bytes = await this.snapshotOf(tag);
    return bytes ? deserializeClientState(bytes) : undefined;
  }

  /** The serialized commit bytes that produced a node, or `undefined`. */
  async commitBytesOf(childTag: string): Promise<Uint8Array | undefined> {
    const node = this.#nodes.get(childTag);
    if (!node || !node.edge) return undefined;
    const cached = this.#heavy.get(childTag);
    if (cached?.commit) {
      this.#touch(childTag);
      return decodeOwnCommitRecord(cached.commit).wireBytes;
    }
    if (!this.#store || !this.#gid) return undefined;
    // Fetched on demand (rare — for replay/debug); not cached, to avoid
    // displacing a hot snapshot or polluting the LRU with commit-only entries.
    const record = (await this.#readNode(childTag))?.commit;
    return record ? decodeOwnCommitRecord(record).wireBytes : undefined;
  }

  /** Confirmation-time evidence for a locally-authored commit, if stamped. */
  async ownCommitStampOf(
    childTag: string,
  ): Promise<OwnCommitConvergenceStamp | undefined> {
    const node = this.#nodes.get(childTag);
    if (!node || !node.edge) return undefined;
    const cached = this.#heavy.get(childTag)?.commit;
    const record = cached ?? (await this.#readNode(childTag))?.commit;
    if (!record) return undefined;
    const decoded = decodeOwnCommitRecord(record);
    return decoded.kind === "stamped" ? decoded.stamp : undefined;
  }

  /** Decodes the commit `MlsMessage` that produced a node, or `undefined`. */
  async commitMessageOf(childTag: string): Promise<MlsMessage | undefined> {
    const bytes = await this.commitBytesOf(childTag);
    if (!bytes) return undefined;
    const message = decode(mlsMessageDecoder, bytes);
    if (!message)
      throw new Error("GroupHistoryTree: failed to decode commit message");
    return message;
  }

  /**
   * Records a commit applied from a retained parent node to its resulting child
   * state, adding (or linking) the child node. Idempotent on the child tag: a
   * duplicate commit re-links without overwriting. Throws if the parent is not
   * already in the tree.
   *
   * @returns the child node tag.
   */
  recordCommit(
    parentTag: string,
    commitMessage: MlsMessage,
    childState: ClientState,
    senderLeafIndex?: number,
    ownCommitStamp?: OwnCommitConvergenceStamp,
  ): string {
    this.#assertMutable();
    const parent = this.#nodes.get(parentTag);
    if (!parent)
      throw new Error(
        `GroupHistoryTree: parent ${parentTag.slice(0, 8)} not in tree`,
      );

    const childTag = bytesToHex(childState.confirmationTag);
    const bytes = encode(mlsMessageEncoder, commitMessage);
    const existing = this.#nodes.get(childTag);
    if (!existing) {
      this.#nodes.set(childTag, {
        tag: childTag,
        epoch: Number(childState.groupContext.epoch),
        parentTag,
        childTags: [],
        edge: { commitDigest: commitDigest(bytes), senderLeafIndex },
      });
      this.#markDirty(childTag);
      this.#putHeavy(childTag, {
        snapshot: serializeClientState(childState),
        commit: ownCommitStamp
          ? encodeOwnCommitRecord({ wireBytes: bytes, stamp: ownCommitStamp })
          : bytes,
      });
    } else {
      if (
        existing.parentTag !== parentTag ||
        !existing.edge ||
        bytesToHex(existing.edge.commitDigest) !==
          bytesToHex(commitDigest(bytes))
      )
        throw new Error(
          "GroupHistoryTree: existing child has conflicting parent or commit",
        );

      // Confirmation can follow an earlier observation of the same edge. In
      // that case preserve idempotence while upgrading the bare wire record to
      // durable confirmation-time evidence. Never replace an existing stamp.
      const cached = this.#heavy.get(childTag);
      const decoded = cached?.commit
        ? decodeOwnCommitRecord(cached.commit)
        : undefined;
      if (ownCommitStamp && decoded?.kind === "legacy") {
        this.#markDirty(childTag);
        this.#putHeavy(childTag, {
          snapshot: cached!.snapshot,
          commit: encodeOwnCommitRecord({
            wireBytes: bytes,
            stamp: ownCommitStamp,
          }),
        });
      }
    }
    if (!parent.childTags.includes(childTag)) parent.childTags.push(childTag);
    return childTag;
  }

  /**
   * Records an edge from a snapshot captured at branch-build time. Unlike
   * {@link recordCommit}, the child snapshot is supplied pre-serialized — fork
   * recovery serializes each branch state the instant it is produced, before
   * ts-mls can zero that state's secrets when exploring its children. Idempotent
   * on the child tag. Returns `false` (without recording) when the parent is not
   * yet in the tree, so a batch can skip a dangling edge instead of throwing.
   */
  recordEdge(edge: EdgeSnapshot): boolean {
    this.#assertMutable();
    const parent = this.#nodes.get(edge.parentTag);
    if (!parent) return false;
    if (!this.#nodes.has(edge.childTag)) {
      this.#nodes.set(edge.childTag, {
        tag: edge.childTag,
        epoch: edge.childEpoch,
        parentTag: edge.parentTag,
        childTags: [],
        edge: {
          commitDigest: edge.commitDigest,
          senderLeafIndex: edge.senderLeafIndex,
        },
      });
      this.#markDirty(edge.childTag);
      this.#putHeavy(edge.childTag, {
        snapshot: edge.childSnapshot,
        commit: edge.commitBytes,
      });
    }
    if (!parent.childTags.includes(edge.childTag))
      parent.childTags.push(edge.childTag);
    return true;
  }

  /**
   * Replaces a node's retained snapshot — used after staging a proposal onto a
   * node, which updates its `unappliedProposals` without advancing the epoch.
   * The new state's confirmation tag MUST equal the node tag (staging a proposal
   * does not change it). Throws if the node is absent or the tag would change.
   */
  updateSnapshot(tag: string, state: ClientState): void {
    this.#assertMutable();
    const node = this.#nodes.get(tag);
    if (!node)
      throw new Error(
        `GroupHistoryTree: cannot update absent node ${tag.slice(0, 8)}`,
      );
    const stateTag = bytesToHex(state.confirmationTag);
    if (stateTag !== tag)
      throw new Error(
        "GroupHistoryTree: updateSnapshot would change the node identity",
      );
    const existing = this.#heavy.get(tag);
    this.#markDirty(tag);
    this.#putHeavy(tag, {
      snapshot: serializeClientState(state),
      commit: existing?.commit,
    });
  }

  /**
   * Binds a backing store to a fresh, in-memory tree so its nodes can be flushed
   * and its heavy material later evicted/reloaded. Marks every current node
   * dirty so the first {@link flush} persists the whole tree. A no-op if the
   * same store is already bound (e.g. on a tree loaded via {@link load}).
   */
  bindStore(store: HistoryTreeStore): void {
    this.#assertMutable();
    if (this.#store === store) return;
    this.#store = store;
    this.#rootDirty = true;
    for (const tag of this.#nodes.keys()) this.#markDirty(tag);
  }

  /**
   * Persists all unflushed nodes incrementally: each dirty node's light edge
   * record, snapshot, and commit bytes are written under its own keys, plus the
   * meta (root) record. Append-only — already-persisted nodes are untouched, so
   * a save costs O(new nodes), not O(tree). Requires a bound store.
   */
  async flush(): Promise<void> {
    this.#assertMutable();
    if (this.#flushing) return this.#flushing;
    const operation = (async () => {
      const { write, finish } = await this.#stageFlush();
      await this.#requireStore().commit(write);
      finish();
    })();
    this.#flushing = operation;
    try {
      await operation;
    } finally {
      this.#flushing = undefined;
    }
  }

  /**
   * Stages every unflushed node as a {@link HistoryTreeWrite} the caller commits
   * atomically with its other writes. Call `finish` only after that commit; it
   * marks the staged nodes clean.
   * @internal
   */
  async stageFlush(): Promise<{
    write: HistoryTreeWrite;
    finish: () => void;
  }> {
    this.#assertMutable();
    await this.#flushing;
    return this.#stageFlush();
  }

  /** Reads and decodes a persisted node record. */
  async #readNode(tag: string): Promise<NodeRecord | undefined> {
    if (!this.#store) return undefined;
    const bytes = await this.#store.node(tag);
    return bytes ? decodeNodeRecord(bytes) : undefined;
  }

  #requireStore(): HistoryTreeStore {
    if (!this.#store || !this.#gid)
      throw new Error("GroupHistoryTree: flush requires a bound store");
    return this.#store;
  }

  async #stageFlush(): Promise<{
    write: HistoryTreeWrite;
    finish: () => void;
  }> {
    this.#requireStore();
    const write = emptyTreeWrite();

    const revision = this.#revision;
    const dirty = [...this.#dirty].map(([tag, generation]) => ({
      tag,
      generation,
      node: this.#nodes.get(tag),
      heavy: this.#heavy.get(tag),
    }));
    // Every persisted tree carries a checkpoint: it names the members, so a
    // load reads them by tag instead of listing storage.
    const base: TreeCheckpoint = this.#checkpoint ?? {
      version: 2,
      rootTag: this.#rootTag ?? "",
      members: [],
      garbage: [],
      receivers: {},
      projections: {},
    };
    const checkpoint: TreeCheckpoint = {
      ...base,
      rootTag: this.#rootTag ?? base.rootTag,
      members: this.tags(),
      garbage: base.garbage.filter((tag) => !this.#nodes.has(tag)),
      receivers: Object.fromEntries(
        this.tags().map((tag) => [tag, base.receivers[tag] ?? null]),
      ),
      projections: { ...base.projections },
    };
    for (const { tag, node, heavy } of dirty) {
      if (!node || !heavy)
        throw new Error("GroupHistoryTree: dirty material missing");
      let commit: Uint8Array | undefined;
      if (node.edge) {
        commit = heavy.commit ?? (await this.#readNode(tag))?.commit;
        if (!commit)
          throw new Error("GroupHistoryTree: required commit missing");
      }
      write.puts.set(
        tag,
        encodeNodeRecord({
          edge: this.#encodePhysicalEdge(node),
          snapshot: heavy.snapshot,
          commit,
        }),
      );
      checkpoint.receivers[tag] = [
        ...deserializeClientState(heavy.snapshot).historicalReceiverData.keys(),
      ].map(Number);
      delete checkpoint.projections[tag];
    }
    const writeRoot = !!this.#rootTag && (this.#rootDirty || dirty.length > 0);
    if (writeRoot) write.meta = encodeCheckpoint(checkpoint);
    return {
      write,
      finish: () => {
        if (writeRoot) {
          this.#checkpoint = checkpoint;
          if (this.#revision === revision) this.#rootDirty = false;
        }
        for (const { tag, generation } of dirty)
          if (this.#dirty.get(tag) === generation) this.#dirty.delete(tag);
        // Flushed entries are now clean and may be evicted under cache pressure.
        this.#evict();
      },
    };
  }

  /**
   * Loads a tree's light index from a store (heavy material stays lazy). Returns
   * `undefined` if no tree is persisted under `gid`. The store stays bound, so
   * snapshots/commit bytes are fetched on demand.
   */
  static async load(
    store: HistoryTreeStore,
    gid: string,
    options?: { snapshotCacheSize?: number },
  ): Promise<GroupHistoryTree | undefined> {
    const metaBytes = await store.meta();
    if (!metaBytes) return undefined;
    const checkpoint = decodeCheckpoint(metaBytes);

    const tree = new GroupHistoryTree(undefined, options);
    tree.#store = store;
    tree.#gid = gid;

    const records = new Map<string, NodeRecord>();
    for (const tag of checkpoint.members) {
      const bytes = await store.node(tag);
      if (!bytes) throw new Error("GroupHistoryTree: required edge missing");
      const record = decodeNodeRecord(bytes);
      records.set(tag, record);
      const rec = decodeEdgeRecord(record.edge);
      tree.#nodes.set(tag, {
        tag,
        epoch: rec.epoch,
        parentTag: rec.parentTag,
        childTags: [],
        edge: rec.edge,
      });
    }
    tree.#rootTag = checkpoint.rootTag;
    tree.#checkpoint = checkpoint;
    await tree.#validateCheckpoint(checkpoint, records);
    const root = tree.#nodes.get(checkpoint.rootTag)!;
    root.parentTag = undefined;
    for (const node of tree.#nodes.values())
      if (node.parentTag)
        tree.#nodes.get(node.parentTag)!.childTags.push(node.tag);
    // Loaded nodes are already persisted — nothing dirty.
    return tree;
  }

  /** Stages deletion of every persisted record of a tree. */
  static async stagePurge(store: HistoryTreeStore): Promise<HistoryTreeWrite> {
    const write = emptyTreeWrite();
    const metaBytes = await store.meta();
    if (!metaBytes) return write;
    const checkpoint = decodeCheckpoint(metaBytes);
    for (const tag of [...checkpoint.members, ...checkpoint.garbage])
      write.deletes.add(tag);
    write.meta = null;
    return write;
  }

  /**
   * Captures one settled keep decision. Callers fence dependency admission until cleanup ends.
   * @internal
   */
  async prepareRetention(
    options: HistoryRetentionOptions,
  ): Promise<HistoryRetentionPlan> {
    this.#assertMutable();
    const revision = this.#revision;
    const topology = retainedTopology(this, options);
    const snapshots = new Map<string, Uint8Array>();
    const receiverEpochs = new Map<string, number[] | undefined>();
    for (const tag of topology.retainedTags) {
      const bytes = await this.snapshotOf(tag);
      if (!bytes)
        throw new Error("GroupHistoryTree: required snapshot missing");
      const projected = projectHistoricalReceivers(
        bytes,
        topology.appFloorEpoch,
        (options.pins ?? []).filter((pin) => pin.stateTag === tag),
      );
      snapshots.set(tag, projected.snapshot);
      receiverEpochs.set(tag, projected.receiverEpochs);
    }
    if (revision !== this.#revision)
      throw new Error("GroupHistoryTree: retention plan became stale");
    return {
      ...topology,
      revision,
      canonicalTipTag: options.canonicalTipTag,
      snapshots,
      receiverEpochs,
    };
  }

  /**
   * Flush required bytes, publish authority, then adopt; never delete before publication.
   * @internal
   */
  async publishRetention(plan: HistoryRetentionPlan): Promise<void> {
    this.#assertMutable();
    if (!plan.logicalRootTag) return;
    if (!this.#store || !this.#gid) {
      this.#publishLocalRetention(plan);
      return;
    }
    if (this.#flushing) await this.#flushing;
    if (plan.revision !== this.#revision)
      throw new Error("GroupHistoryTree: retention plan became stale");
    this.#retentionActive = true;
    try {
      const identity = retentionPlanIdentity(plan);
      const flushed = await this.#stageFlush();
      await this.#store.commit(flushed.write);
      flushed.finish();
      const root = this.#nodes.get(plan.logicalRootTag)!;
      const existingBoundary =
        plan.logicalRootTag === this.#checkpoint?.rootTag
          ? this.#checkpoint.boundary
          : undefined;
      const boundary =
        existingBoundary ??
        (root.parentTag && root.edge
          ? {
              parentTag: root.parentTag,
              epoch: this.#nodes.get(root.parentTag)!.epoch,
              digest: bytesToHex(root.edge.commitDigest),
              senderLeafIndex: root.edge.senderLeafIndex,
            }
          : undefined);
      const checkpoint: TreeCheckpoint = {
        version: 2,
        rootTag: plan.logicalRootTag,
        members: [...plan.retainedTags],
        garbage: [
          ...new Set([
            ...(this.#checkpoint?.garbage ?? []),
            ...plan.excludedTags,
          ]),
        ],
        receivers: Object.fromEntries(
          [...plan.receiverEpochs].map(([tag, epochs]) => [
            tag,
            epochs ? [...epochs] : null,
          ]),
        ),
        boundary,
        projections: Object.fromEntries(
          [...plan.snapshots].map(([tag, bytes]) => [tag, bytesToHex(bytes)]),
        ),
      };
      // A plan object is not trusted merely because its TypeScript type matches.
      decodeCheckpoint(encodeCheckpoint(checkpoint));
      if (!checkpoint.members.includes(plan.canonicalTipTag))
        throw new Error("GroupHistoryTree: retention excludes canonical tip");
      const keep = new Set(checkpoint.members);
      for (const tag of checkpoint.members) {
        const snapshot = plan.snapshots.get(tag);
        const node = this.#nodes.get(tag);
        if (!snapshot || !node)
          throw new Error("GroupHistoryTree: retention snapshot absent");
        const state = deserializeClientState(snapshot);
        if (
          bytesToHex(state.confirmationTag) !== tag ||
          Number(state.groupContext.epoch) !== node.epoch ||
          bytesToHex(state.groupContext.groupId) !== this.#gid
        )
          throw new Error(
            "GroupHistoryTree: retention snapshot identity mismatch",
          );
        const allowed = checkpoint.receivers[tag];
        const actual = [...state.historicalReceiverData.keys()]
          .map(Number)
          .sort((a, b) => a - b);
        if (
          allowed !== null &&
          actual.join() !== [...allowed!].sort((a, b) => a - b).join()
        )
          throw new Error(
            "GroupHistoryTree: retention receiver allowlist mismatch",
          );
        if (
          tag !== checkpoint.rootTag &&
          (!node.parentTag ||
            !keep.has(node.parentTag) ||
            this.#nodes.get(node.parentTag)!.epoch + 1 !== node.epoch)
        )
          throw new Error("GroupHistoryTree: retention parent closure broken");
        if (node.edge) {
          const bytes = (await this.#readNode(tag))?.commit;
          if (
            !bytes ||
            bytesToHex(commitDigest(decodeOwnCommitRecord(bytes).wireBytes)) !==
              bytesToHex(node.edge.commitDigest)
          )
            throw new Error("GroupHistoryTree: retention commit mismatch");
        }
      }
      const authority = encodeCheckpoint(checkpoint);
      try {
        await this.#store.commit({ ...emptyTreeWrite(), meta: authority });
      } catch (error) {
        const persisted = await this.#store.meta();
        if (persisted && bytesToHex(persisted) === bytesToHex(authority)) {
          this.#adoptCheckpoint(checkpoint, plan.snapshots);
          this.#publishedRetention = {
            plan: new WeakRef(plan),
            revision: this.#revision,
            identity,
          };
        }
        throw error;
      }
      this.#adoptCheckpoint(checkpoint, plan.snapshots);
      this.#publishedRetention = {
        plan: new WeakRef(plan),
        revision: this.#revision,
        identity,
      };
    } finally {
      this.#retentionActive = false;
    }
  }

  /** Process-local authority only; never advertises restart recovery. */
  #publishLocalRetention(plan: HistoryRetentionPlan): void {
    if (plan.revision !== this.#revision)
      throw new Error("GroupHistoryTree: retention plan became stale");
    if (
      !plan.logicalRootTag ||
      !plan.retainedTags.includes(plan.canonicalTipTag)
    )
      throw new Error("GroupHistoryTree: retention excludes canonical tip");
    const gid = bytesToHex(
      deserializeClientState(plan.snapshots.get(plan.canonicalTipTag)!)
        .groupContext.groupId,
    );
    const keep = new Set(plan.retainedTags);
    if (
      keep.size !== plan.retainedTags.length ||
      this.tags().some(
        (tag) => keep.has(tag) === plan.excludedTags.includes(tag),
      )
    )
      throw new Error("GroupHistoryTree: retention membership mismatch");
    for (const tag of keep) {
      const node = this.#nodes.get(tag);
      const snapshot = plan.snapshots.get(tag);
      if (
        !node ||
        !snapshot ||
        (tag !== plan.logicalRootTag && !keep.has(node.parentTag!))
      )
        throw new Error("GroupHistoryTree: retention snapshot absent");
      const state = deserializeClientState(snapshot);
      if (
        bytesToHex(state.confirmationTag) !== tag ||
        Number(state.groupContext.epoch) !== node.epoch ||
        bytesToHex(state.groupContext.groupId) !== gid
      )
        throw new Error(
          "GroupHistoryTree: retention snapshot identity mismatch",
        );
      const epochs = plan.receiverEpochs.get(tag);
      if (
        epochs !== undefined &&
        [...state.historicalReceiverData.keys()]
          .map(Number)
          .sort((a, b) => a - b)
          .join() !== [...epochs].sort((a, b) => a - b).join()
      )
        throw new Error("GroupHistoryTree: retention receiver mismatch");
    }
    const root = this.#nodes.get(plan.logicalRootTag)!;
    const boundary =
      plan.logicalRootTag === this.#checkpoint?.rootTag
        ? this.#checkpoint.boundary
        : root.parentTag && root.edge
          ? {
              parentTag: root.parentTag,
              epoch: this.#nodes.get(root.parentTag)!.epoch,
              digest: bytesToHex(root.edge.commitDigest),
              senderLeafIndex: root.edge.senderLeafIndex,
            }
          : undefined;
    const identity = retentionPlanIdentity(plan);
    this.#adoptCheckpoint(
      {
        version: 2,
        rootTag: plan.logicalRootTag,
        members: [...keep],
        garbage: [],
        receivers: Object.fromEntries(
          [...plan.receiverEpochs].map(([tag, epochs]) => [
            tag,
            epochs ? [...epochs] : null,
          ]),
        ),
        projections: {},
        boundary,
      },
      plan.snapshots,
    );
    this.#publishedRetention = {
      plan: new WeakRef(plan),
      revision: this.#revision,
      identity,
    };
    // With no adapter, the projected bytes must remain available in memory.
    for (const [tag, snapshot] of plan.snapshots)
      this.#putHeavy(tag, { snapshot, commit: this.#heavy.get(tag)?.commit });
  }

  /** @internal Exact local plan adopted from durable authority, including after-forward rejection. */
  isRetentionPublished(plan: HistoryRetentionPlan): boolean {
    return (
      this.#publishedRetention?.plan.deref() === plan &&
      this.#publishedRetention.revision === this.#revision &&
      this.#publishedRetention.identity === retentionPlanIdentity(plan)
    );
  }

  /**
   * Restart-safe, idempotent exact-key cleanup of the currently durable authority.
   * @internal
   */
  async resumeRetentionCleanup(): Promise<void> {
    this.#assertMutable();
    if (!this.#store || !this.#gid) return;
    if (this.#dirty.size || this.#flushing)
      throw new Error(
        "GroupHistoryTree: flush mutations before retention cleanup",
      );
    this.#retentionActive = true;
    try {
      const persisted = await GroupHistoryTree.load(this.#store, this.#gid, {
        snapshotCacheSize: this.#cacheMax,
      });
      if (!persisted || !persisted.#checkpoint) return;
      const checkpoint = persisted.#checkpoint;
      if (
        this.#rootTag !== checkpoint.rootTag ||
        this.tags().join() !== checkpoint.members.join()
      )
        throw new Error(
          "GroupHistoryTree: cleanup authority differs from live membership",
        );
      if (
        checkpoint.garbage.length ||
        Object.keys(checkpoint.projections).length
      ) {
        // Projections, garbage removal and the clean checkpoint commit together.
        const write = emptyTreeWrite();
        for (const [tag, snapshot] of Object.entries(checkpoint.projections)) {
          const record = await this.#readNode(tag);
          if (!record)
            throw new Error("GroupHistoryTree: required snapshot missing");
          write.puts.set(
            tag,
            encodeNodeRecord({ ...record, snapshot: hexToBytes(snapshot) }),
          );
        }
        for (const tag of checkpoint.garbage) write.deletes.add(tag);
        const clean = { ...checkpoint, garbage: [], projections: {} };
        write.meta = encodeCheckpoint(clean);
        await this.#store.commit(write);
        this.#checkpoint = clean;
      }
    } finally {
      this.#retentionActive = false;
    }
  }

  #adoptCheckpoint(
    checkpoint: TreeCheckpoint,
    snapshots: ReadonlyMap<string, Uint8Array>,
  ): void {
    const keep = new Set(checkpoint.members);
    for (const tag of this.tags())
      if (!keep.has(tag)) {
        this.#nodes.delete(tag);
        this.#heavy.delete(tag);
        this.#dirty.delete(tag);
      }
    for (const node of this.#nodes.values())
      node.childTags = node.childTags.filter((tag) => keep.has(tag));
    this.#nodes.get(checkpoint.rootTag)!.parentTag = undefined;
    this.#rootTag = checkpoint.rootTag;
    this.#checkpoint = checkpoint;
    this.#revision++;
    for (const [tag, snapshot] of snapshots)
      if (this.#heavy.has(tag))
        this.#putHeavy(tag, { snapshot, commit: this.#heavy.get(tag)?.commit });
  }

  async #validateCheckpoint(
    checkpoint: TreeCheckpoint,
    records: ReadonlyMap<string, NodeRecord>,
  ): Promise<void> {
    const root = this.#nodes.get(checkpoint.rootTag);
    if (!root) throw new Error("GroupHistoryTree: logical root absent");
    if (checkpoint.boundary) {
      const b = checkpoint.boundary;
      if (
        root.parentTag !== b.parentTag ||
        root.epoch !== b.epoch + 1 ||
        !root.edge ||
        bytesToHex(root.edge.commitDigest) !== b.digest ||
        root.edge.senderLeafIndex !== b.senderLeafIndex ||
        this.#nodes.has(b.parentTag)
      )
        throw new Error("GroupHistoryTree: invalid boundary provenance");
    } else if (root.parentTag || root.edge)
      throw new Error("GroupHistoryTree: unexpected root edge");
    for (const node of this.#nodes.values()) {
      if (!Number.isSafeInteger(node.epoch) || node.epoch < 0)
        throw new Error("GroupHistoryTree: invalid epoch");
      const seen = new Set<string>();
      let cursor = node;
      while (cursor.tag !== root.tag) {
        if (seen.has(cursor.tag))
          throw new Error("GroupHistoryTree: checkpoint cycle");
        seen.add(cursor.tag);
        const parent = cursor.parentTag
          ? this.#nodes.get(cursor.parentTag)
          : undefined;
        if (!parent || parent.epoch + 1 !== cursor.epoch)
          throw new Error("GroupHistoryTree: retained parent closure broken");
        cursor = parent;
      }
      const primary = records.get(node.tag)?.snapshot;
      if (!primary)
        throw new Error("GroupHistoryTree: required snapshot missing");
      const snapshot =
        checkpoint.projections[node.tag] === undefined
          ? primary
          : hexToBytes(checkpoint.projections[node.tag]);
      const state = deserializeClientState(snapshot);
      if (
        bytesToHex(state.confirmationTag) !== node.tag ||
        Number(state.groupContext.epoch) !== node.epoch ||
        bytesToHex(state.groupContext.groupId) !== this.#gid
      )
        throw new Error("GroupHistoryTree: snapshot identity mismatch");
      const receivers = checkpoint.receivers[node.tag];
      const actual = [...state.historicalReceiverData.keys()]
        .map(Number)
        .sort((a, b) => a - b);
      if (
        actual.some(
          (epoch) =>
            !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= node.epoch,
        )
      )
        throw new Error("GroupHistoryTree: invalid historical receiver epoch");
      if (
        receivers !== null &&
        actual.join() !== [...receivers!].sort((a, b) => a - b).join()
      )
        throw new Error("GroupHistoryTree: receiver allowlist mismatch");
      if (node.edge) {
        const record = records.get(node.tag)?.commit;
        if (!record || node.edge.commitDigest.length !== 32)
          throw new Error("GroupHistoryTree: required commit missing");
        const wire = decodeOwnCommitRecord(record).wireBytes;
        if (
          bytesToHex(commitDigest(wire)) !==
            bytesToHex(node.edge.commitDigest) ||
          !decode(mlsMessageDecoder, wire)
        )
          throw new Error("GroupHistoryTree: invalid retained commit");
      }
    }
  }

  #assertMutable(): void {
    if (this.#retentionActive)
      throw new Error(
        "GroupHistoryTree: retention publication or cleanup in progress",
      );
  }

  #markDirty(tag: string): void {
    this.#dirty.set(tag, ++this.#revision);
  }

  #encodePhysicalEdge(node: MutableNode): Uint8Array {
    const boundary =
      node.tag === this.#checkpoint?.rootTag
        ? this.#checkpoint.boundary
        : undefined;
    return encodeEdgeRecord(
      boundary ? { ...node, parentTag: boundary.parentTag } : node,
    );
  }

  /** Inserts/refreshes a heavy entry at the LRU tail, then evicts if needed. */
  #putHeavy(tag: string, entry: HeavyEntry): void {
    this.#heavy.delete(tag);
    this.#heavy.set(tag, entry);
    this.#evict();
  }

  /** Moves a heavy entry to the LRU tail (most-recently-used). */
  #touch(tag: string): void {
    const entry = this.#heavy.get(tag);
    if (!entry) return;
    this.#heavy.delete(tag);
    this.#heavy.set(tag, entry);
  }

  /** Evicts clean (flushed) heavy entries oldest-first until within the cap. */
  #evict(): void {
    if (this.#heavy.size <= this.#cacheMax) return;
    for (const tag of this.#heavy.keys()) {
      if (this.#heavy.size <= this.#cacheMax) break;
      if (this.#dirty.has(tag)) continue; // never evict unflushed material
      this.#heavy.delete(tag);
    }
  }
}

/** Encodes a node's light edge record (everything but the heavy material). */
function encodeEdgeRecord(node: MutableNode): Uint8Array {
  const w = new BinaryWriter().uint8(HISTORY_TREE_VERSION).varint(node.epoch);
  w.opaque(node.parentTag ? hexToBytes(node.parentTag) : new Uint8Array());
  if (node.parentTag) {
    w.opaque(node.edge?.commitDigest ?? new Uint8Array());
    if (node.edge?.senderLeafIndex !== undefined) {
      w.uint8(1).varint(node.edge.senderLeafIndex);
    } else {
      w.uint8(0);
    }
  }
  return w.build();
}

/** Decodes a light edge record into its node fields. */
function decodeEdgeRecord(bytes: Uint8Array): {
  epoch: number;
  parentTag?: string;
  edge?: HistoryEdge;
} {
  const r = new BinaryReader(bytes);
  const version = r.uint8();
  if (version !== HISTORY_TREE_VERSION)
    throw new Error(`GroupHistoryTree: unknown edge record version ${version}`);
  const epoch = r.varint();
  const parentBytes = r.opaque();
  const parentTag = parentBytes.length ? bytesToHex(parentBytes) : undefined;
  let edge: HistoryEdge | undefined;
  if (parentTag) {
    const commitDigestBytes = r.opaque();
    const senderPresent = r.uint8();
    const senderLeafIndex = senderPresent ? r.varint() : undefined;
    edge = { commitDigest: commitDigestBytes, senderLeafIndex };
  }
  r.end();
  return { epoch, parentTag, edge };
}

function encodeCheckpoint(checkpoint: TreeCheckpoint): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(checkpoint));
  const bytes = new Uint8Array(payload.length + 1);
  bytes[0] = 2;
  bytes.set(payload, 1);
  return bytes;
}

function decodeCheckpoint(bytes: Uint8Array): TreeCheckpoint {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(1)),
  );
  if (!value || typeof value !== "object")
    throw new Error("GroupHistoryTree: invalid checkpoint");
  const c = value as TreeCheckpoint;
  const validTag = (tag: unknown): tag is string =>
    typeof tag === "string" && /^(?:[0-9a-f]{2})+$/.test(tag);
  const tagsValid = (tags: unknown): tags is string[] =>
    Array.isArray(tags) &&
    tags.every(validTag) &&
    new Set(tags).size === tags.length;
  if (
    c.version !== 2 ||
    !validTag(c.rootTag) ||
    !tagsValid(c.members) ||
    !tagsValid(c.garbage) ||
    !c.members.includes(c.rootTag) ||
    c.garbage.some((tag) => c.members.includes(tag)) ||
    !c.receivers ||
    typeof c.receivers !== "object" ||
    Array.isArray(c.receivers) ||
    Object.keys(c.receivers).length !== c.members.length ||
    !c.projections ||
    typeof c.projections !== "object" ||
    Array.isArray(c.projections) ||
    Object.entries(c.projections).some(
      ([tag, snapshot]) => !c.members.includes(tag) || !validTag(snapshot),
    )
  )
    throw new Error("GroupHistoryTree: invalid checkpoint membership");
  for (const tag of c.members) {
    const epochs = c.receivers[tag];
    if (
      epochs !== null &&
      (!Array.isArray(epochs) ||
        epochs.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 0) ||
        new Set(epochs).size !== epochs.length)
    )
      throw new Error("GroupHistoryTree: invalid receiver allowlist");
  }
  if (
    c.boundary &&
    (!validTag(c.boundary.parentTag) ||
      !Number.isSafeInteger(c.boundary.epoch) ||
      c.boundary.epoch < 0 ||
      !/^[0-9a-f]{64}$/.test(c.boundary.digest) ||
      (c.boundary.senderLeafIndex !== undefined &&
        (!Number.isSafeInteger(c.boundary.senderLeafIndex) ||
          c.boundary.senderLeafIndex < 0)))
  )
    throw new Error("GroupHistoryTree: invalid boundary provenance");
  return c;
}
