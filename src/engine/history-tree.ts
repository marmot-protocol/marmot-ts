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

/** Wire-format version byte for {@link GroupHistoryTree.serialize}. */
const HISTORY_TREE_VERSION = 1;

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

/**
 * The retained group history tree (Marmot v2 full-fork history). Holds every
 * group state ever observed — the canonical branch and every fork — as a tree
 * of serialized {@link ClientState} snapshots linked by commit edges.
 *
 * Snapshots are stored as bytes, never as live `ClientState` objects: ts-mls
 * zeroes a parent state's consumed secrets in place when a commit is processed
 * from it, so a retained live object could be corrupted out from under a
 * sibling-branch replay. Re-deriving a state ({@link stateAt}) deserializes a
 * fresh, independent object every call.
 *
 * This is the structural core only — convergence (choosing which tip is
 * canonical) and the inbound wiring that grows the tree live in the engine
 * layers that consume it. No pruning is performed: the tree retains everything.
 */
export class GroupHistoryTree {
  /** The resident light index — node metadata, always in memory. */
  readonly #nodes = new Map<string, MutableNode>();
  /** Serialized `ClientState` snapshot per node tag (the heavy material). */
  readonly #snapshots = new Map<string, Uint8Array>();
  /** Serialized commit `MlsMessage` per child tag (the edge that made it). */
  readonly #commitBytes = new Map<string, Uint8Array>();
  /** The root node tag, or `undefined` while the tree is empty. */
  #rootTag: string | undefined;

  /** Seeds an empty tree, optionally with a root {@link ClientState}. */
  constructor(root?: ClientState) {
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
      this.#snapshots.set(tag, serializeClientState(state));
    }
    this.#rootTag = tag;
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

  /** The serialized `ClientState` snapshot for a node, or `undefined`. */
  snapshotOf(tag: string): Uint8Array | undefined {
    return this.#snapshots.get(tag);
  }

  /**
   * Rehydrates a node's state into a fresh, independent {@link ClientState}.
   * Returns `undefined` if the node has no retained snapshot. Each call decodes
   * a new object, so callers may mutate/advance it without affecting the tree.
   */
  stateAt(tag: string): ClientState | undefined {
    const bytes = this.#snapshots.get(tag);
    return bytes ? deserializeClientState(bytes) : undefined;
  }

  /** The serialized commit bytes that produced a node, or `undefined`. */
  commitBytesOf(childTag: string): Uint8Array | undefined {
    return this.#commitBytes.get(childTag);
  }

  /** Decodes the commit `MlsMessage` that produced a node, or `undefined`. */
  commitMessageOf(childTag: string): MlsMessage | undefined {
    const bytes = this.#commitBytes.get(childTag);
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
      this.#snapshots.set(childTag, serializeClientState(childState));
      this.#commitBytes.set(childTag, bytes);
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
      this.#snapshots.set(edge.childTag, edge.childSnapshot);
      this.#commitBytes.set(edge.childTag, edge.commitBytes);
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
    if (!this.#nodes.has(tag))
      throw new Error(
        `GroupHistoryTree: cannot update absent node ${tag.slice(0, 8)}`,
      );
    const stateTag = bytesToHex(state.confirmationTag);
    if (stateTag !== tag)
      throw new Error(
        "GroupHistoryTree: updateSnapshot would change the node identity",
      );
    this.#snapshots.set(tag, serializeClientState(state));
  }

  /**
   * Serializes the entire tree (every node snapshot + commit bytes + structure)
   * to the Marmot binary profile. Child links are not stored; they are rebuilt
   * from parent references on {@link deserialize}.
   */
  serialize(): Uint8Array {
    const records: Uint8Array[] = [];
    for (const node of this.#nodes.values()) {
      const w = new BinaryWriter();
      w.opaque(hexToBytes(node.tag));
      w.varint(node.epoch);
      w.opaque(node.parentTag ? hexToBytes(node.parentTag) : new Uint8Array());
      w.opaque(this.#snapshots.get(node.tag) ?? new Uint8Array());
      // Edge fields are present iff the node has a parent (non-root).
      if (node.parentTag) {
        w.opaque(node.edge?.commitDigest ?? new Uint8Array());
        w.opaque(this.#commitBytes.get(node.tag) ?? new Uint8Array());
        if (node.edge?.senderLeafIndex !== undefined) {
          w.uint8(1).varint(node.edge.senderLeafIndex);
        } else {
          w.uint8(0);
        }
      }
      records.push(w.build());
    }

    return new BinaryWriter()
      .uint8(HISTORY_TREE_VERSION)
      .opaque(this.#rootTag ? hexToBytes(this.#rootTag) : new Uint8Array())
      .vector(records)
      .build();
  }

  /** Decodes bytes from {@link serialize} into a tree. Throws on bad input. */
  static deserialize(bytes: Uint8Array): GroupHistoryTree {
    const reader = new BinaryReader(bytes);
    const version = reader.uint8();
    if (version !== HISTORY_TREE_VERSION)
      throw new Error(`GroupHistoryTree: unknown version ${version}`);

    const tree = new GroupHistoryTree();
    const rootBytes = reader.opaque();
    const rootTag = rootBytes.length ? bytesToHex(rootBytes) : undefined;

    const records = reader.vector((r) => {
      const tag = bytesToHex(r.opaque());
      const epoch = r.varint();
      const parentBytes = r.opaque();
      const parentTag = parentBytes.length
        ? bytesToHex(parentBytes)
        : undefined;
      const snapshot = r.opaque();
      let edge: HistoryEdge | undefined;
      let commit: Uint8Array | undefined;
      if (parentTag) {
        const commitDigestBytes = r.opaque();
        commit = r.opaque();
        const senderPresent = r.uint8();
        const senderLeafIndex = senderPresent ? r.varint() : undefined;
        edge = { commitDigest: commitDigestBytes, senderLeafIndex };
      }
      return { tag, epoch, parentTag, snapshot, edge, commit };
    });
    reader.end();

    for (const rec of records) {
      tree.#nodes.set(rec.tag, {
        tag: rec.tag,
        epoch: rec.epoch,
        parentTag: rec.parentTag,
        childTags: [],
        edge: rec.edge,
      });
      tree.#snapshots.set(rec.tag, rec.snapshot);
      if (rec.commit) tree.#commitBytes.set(rec.tag, rec.commit);
    }
    // Rebuild child links from parent references.
    for (const node of tree.#nodes.values()) {
      if (node.parentTag) {
        const parent = tree.#nodes.get(node.parentTag);
        if (parent) parent.childTags.push(node.tag);
      }
    }
    tree.#rootTag = rootTag;
    return tree;
  }
}
