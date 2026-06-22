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
import type { GenericKeyValueStore } from "../utils/key-value.js";

/** Wire-format version byte for a persisted node-edge / meta record. */
const HISTORY_TREE_VERSION = 1;

/** Default number of heavy snapshots kept rehydrated in memory at once. */
const DEFAULT_SNAPSHOT_CACHE = 128;

/** The store backing a tree's heavy material. A `GenericKeyValueStore<Uint8Array>`. */
type HistoryTreeStore = GenericKeyValueStore<Uint8Array>;

const metaKey = (gid: string) => `${gid}/meta`;
const edgeKey = (gid: string, tag: string) => `${gid}/edge/${tag}`;
const stateKey = (gid: string, tag: string) => `${gid}/state/${tag}`;
const commitKey = (gid: string, tag: string) => `${gid}/commit/${tag}`;

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
  /** The commit edge from the parent. `undefined` only for the root. */
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
 * group state ever observed — the canonical branch and every fork — as a tree
 * of {@link ClientState} snapshots linked by commit edges. No pruning is
 * performed: the tree retains everything.
 *
 * The **light index** (per-node epoch/parent/edge metadata) is always resident.
 * **Heavy material** (serialized snapshots + commit bytes) is kept in a bounded
 * in-memory LRU and otherwise fetched from a backing key-value store on demand,
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
  readonly #dirty = new Set<string>();
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

  /** The root node tag (the welcome/creation state), or `undefined` if empty. */
  get rootTag(): string | undefined {
    return this.#rootTag;
  }

  /** Number of nodes (states) retained in the tree. */
  get size(): number {
    return this.#nodes.size;
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
      this.#putHeavy(tag, { snapshot: serializeClientState(state) });
      this.#dirty.add(tag);
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
    const bytes = await this.#store.getItem(stateKey(this.#gid, tag));
    if (!bytes) return undefined;
    this.#putHeavy(tag, { snapshot: bytes });
    return bytes;
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
    if (!node || !node.parentTag) return undefined;
    const cached = this.#heavy.get(childTag);
    if (cached?.commit) {
      this.#touch(childTag);
      return cached.commit;
    }
    if (!this.#store || !this.#gid) return undefined;
    // Fetched on demand (rare — for replay/debug); not cached, to avoid
    // displacing a hot snapshot or polluting the LRU with commit-only entries.
    return (
      (await this.#store.getItem(commitKey(this.#gid, childTag))) ?? undefined
    );
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
  ): string {
    const parent = this.#nodes.get(parentTag);
    if (!parent)
      throw new Error(
        `GroupHistoryTree: parent ${parentTag.slice(0, 8)} not in tree`,
      );

    const childTag = bytesToHex(childState.confirmationTag);
    if (!this.#nodes.has(childTag)) {
      const bytes = encode(mlsMessageEncoder, commitMessage);
      this.#nodes.set(childTag, {
        tag: childTag,
        epoch: Number(childState.groupContext.epoch),
        parentTag,
        childTags: [],
        edge: { commitDigest: commitDigest(bytes), senderLeafIndex },
      });
      this.#putHeavy(childTag, {
        snapshot: serializeClientState(childState),
        commit: bytes,
      });
      this.#dirty.add(childTag);
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
      this.#putHeavy(edge.childTag, {
        snapshot: edge.childSnapshot,
        commit: edge.commitBytes,
      });
      this.#dirty.add(edge.childTag);
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
    this.#putHeavy(tag, {
      snapshot: serializeClientState(state),
      commit: existing?.commit,
    });
    this.#dirty.add(tag);
  }

  /**
   * Binds a backing store to a fresh, in-memory tree so its nodes can be flushed
   * and its heavy material later evicted/reloaded. Marks every current node
   * dirty so the first {@link flush} persists the whole tree. A no-op if the
   * same store is already bound (e.g. on a tree loaded via {@link load}).
   */
  bindStore(store: HistoryTreeStore): void {
    if (this.#store === store) return;
    this.#store = store;
    this.#rootDirty = true;
    for (const tag of this.#nodes.keys()) this.#dirty.add(tag);
  }

  /**
   * Persists all unflushed nodes incrementally: each dirty node's light edge
   * record, snapshot, and commit bytes are written under its own keys, plus the
   * meta (root) record. Append-only — already-persisted nodes are untouched, so
   * a save costs O(new nodes), not O(tree). Requires a bound store.
   */
  async flush(): Promise<void> {
    if (!this.#store || !this.#gid)
      throw new Error("GroupHistoryTree: flush requires a bound store");
    const gid = this.#gid;

    for (const tag of this.#dirty) {
      const node = this.#nodes.get(tag);
      const heavy = this.#heavy.get(tag);
      if (!node || !heavy) continue;
      await this.#store.setItem(edgeKey(gid, tag), encodeEdgeRecord(node));
      await this.#store.setItem(stateKey(gid, tag), heavy.snapshot);
      if (node.parentTag && heavy.commit)
        await this.#store.setItem(commitKey(gid, tag), heavy.commit);
    }
    if (this.#rootDirty && this.#rootTag) {
      await this.#store.setItem(metaKey(gid), encodeMeta(this.#rootTag));
      this.#rootDirty = false;
    }
    this.#dirty.clear();
    // Flushed entries are now clean and may be evicted under cache pressure.
    this.#evict();
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
    const metaBytes = await store.getItem(metaKey(gid));
    if (!metaBytes) return undefined;
    const rootTag = decodeMeta(metaBytes);

    const tree = new GroupHistoryTree(undefined, options);
    tree.#store = store;
    tree.#gid = gid;

    const prefix = `${gid}/edge/`;
    const keys = await store.keys();
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const tag = key.slice(prefix.length);
      const bytes = await store.getItem(key);
      if (!bytes) continue;
      const rec = decodeEdgeRecord(bytes);
      tree.#nodes.set(tag, {
        tag,
        epoch: rec.epoch,
        parentTag: rec.parentTag,
        childTags: [],
        edge: rec.edge,
      });
    }
    for (const node of tree.#nodes.values()) {
      if (node.parentTag)
        tree.#nodes.get(node.parentTag)?.childTags.push(node.tag);
    }
    tree.#rootTag = rootTag;
    // Loaded nodes are already persisted — nothing dirty.
    return tree;
  }

  /** Removes every persisted key for a group's tree from the store. */
  static async purge(store: HistoryTreeStore, gid: string): Promise<void> {
    const prefix = `${gid}/`;
    const keys = await store.keys();
    for (const key of keys) {
      if (key === metaKey(gid) || key.startsWith(prefix))
        await store.removeItem(key);
    }
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

/** Encodes the meta record (the root tag pointer). */
function encodeMeta(rootTag: string): Uint8Array {
  return new BinaryWriter()
    .uint8(HISTORY_TREE_VERSION)
    .opaque(hexToBytes(rootTag))
    .build();
}

/** Decodes the meta record into the root tag. */
function decodeMeta(bytes: Uint8Array): string | undefined {
  const r = new BinaryReader(bytes);
  const version = r.uint8();
  if (version !== HISTORY_TREE_VERSION)
    throw new Error(`GroupHistoryTree: unknown meta version ${version}`);
  const rootBytes = r.opaque();
  r.end();
  return rootBytes.length ? bytesToHex(rootBytes) : undefined;
}
