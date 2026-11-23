/**
 * The storage contract an app supplies to a Marmot client: one database per
 * group plus one account database, each made of typed tables with named,
 * index-backed queries.
 *
 * Rows are plain typed objects. The only binary (`Uint8Array`) fields are MLS
 * objects: `ClientState` snapshots, MLS messages and application data, and
 * key packages. Identifiers and digests are lowercase hex strings, Nostr
 * events are stored as event objects. Adapters store nested objects natively
 * (IndexedDB) or as JSON columns (SQLite).
 *
 * The library prepares every row before it opens a transaction, so a
 * transaction callback only awaits the transaction's own methods (IndexedDB
 * commits a transaction as soon as it goes idle).
 *
 * MLS objects include secrets and private keys. Encryption at rest is the
 * adapter's responsibility (SQLCipher, an encrypted file system, or an
 * encrypting IndexedDB wrapper).
 *
 * @module @category Storage
 */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

// ---------------------------------------------------------------------------
// Group database: the group record
// ---------------------------------------------------------------------------

/** Ordering class of a commit, decided when it was prepared. */
export type CommitPriority = "privileged" | "ordinary";

/** Confirmation-time evidence for a commit this client authored. */
export interface OwnCommitStampRecord {
  /** Authenticated Marmot account identity of the committer (hex pubkey). */
  committer: string;
  priority: CommitPriority;
  /** Proposal references consumed by the commit (hex, sorted). */
  consumedProposalRefs: string[];
}

/** Evidence that this client was removed, kept until recovery completes. */
export interface RemovalRecord {
  version: 1 | 2;
  /** Authenticated sender of the removing commit (version 2). */
  removingCommitter?: string;
  removingPriority?: CommitPriority;
  /** Digest of the removing commit (hex). */
  removalDigest: string;
  /** State tag the removal was applied to. */
  parentTag: string;
  parentEpoch: number;
  /** Hex group id. */
  groupId: string;
  /** This client's account identity (hex pubkey). */
  localIdentity: string;
  localLeaf: number;
  notificationState: "pending" | "delivered";
  /** Selected recovery branch, while recovery is in progress. */
  recoveryPending?: {
    removalDigest: string;
    parentTag: string;
    selectedTip: string;
  };
}

/** This client's request to disband the group. */
export type DisbandRequestRecord =
  | {
      status: "pending";
      requestedAtMs: number;
      lastPreparedEpoch: number | null;
    }
  | {
      status: "failed";
      reason: "NoLongerMember" | "NoLongerAdmin";
      requestedAtMs: number;
      lastPreparedEpoch: null;
    };

/** Disband candidates observed during an open convergence pass. */
export interface DisbandConvergenceRecord {
  generation: number;
  baseEpoch: number;
  openedAtWallMs: number;
  deadlineWallMs: number;
  lastRelevantInputWallMs: number;
  candidates: {
    /** Disband commit digest (hex). */
    commitDigest: string;
    actorPubkey: string;
    sourceEpoch: number;
    parentTag: string;
    childTag: string;
    /** The disband commit (MLS message). */
    commitMessage: Uint8Array;
    /** The state the commit produced (MLS `ClientState`). */
    resultingState: Uint8Array;
  }[];
}

/** Read-only evidence that the group was disbanded. */
export interface DisbandTombstoneRecord {
  selectedEpoch: number;
  /** Disband commit digest (hex). */
  commitDigest: string;
  actorPubkey: string;
  notificationState: "pending" | "delivered";
}

/** A relay's answer to publishing an event. */
export interface PublishResponseRecord {
  from: string;
  ok: boolean;
  message?: string;
  uncertain?: boolean;
}

/** A commit this client prepared, kept until its publication is resolved. */
export interface PublicationRecord {
  kind: "groupEvolution" | "selfUpdate";
  /** The kind-445 transport event carrying the commit. */
  envelope: NostrEvent;
  pending: {
    kind: "commit" | "selfUpdate";
    /** State before the commit (MLS `ClientState`). */
    parentState: Uint8Array;
    /** State after the commit (MLS `ClientState`). */
    newState: Uint8Array;
    /** The commit (MLS message). */
    commitMessage: Uint8Array;
    ownCommitStamp?: OwnCommitStampRecord;
    terminalEvidence?: {
      commitDigest: string;
      actorPubkey: string;
      sourceEpoch: number;
      parentTag: string;
      terminalOutcome: "disbanded";
    };
  };
  /** Welcome for members the commit adds (MLS message). */
  welcome?: Uint8Array;
  actorPubkey?: string;
  welcomeRecipients?: {
    pubkey: string;
    keyPackageEventId: string;
    keyPackageEvent: NostrEvent;
  }[];
  relays: string[];
  acknowledged: boolean;
  response?: Record<string, PublishResponseRecord>;
}

/** Which fork-history nodes are retained, and how to load them. */
export interface TreeCheckpointRecord {
  rootTag: string;
  /** Retained node tags, in load order. */
  members: string[];
  /** Tags whose nodes may still be stored and must be deleted. */
  garbage: string[];
  /** Allowed historical receiver epochs per member; `null` means unchecked. */
  receivers: Record<string, number[] | null>;
  /** Rewritten snapshots awaiting cleanup, by tag (MLS `ClientState`). */
  projections: Record<string, Uint8Array>;
  /** The edge into the logical root when older history was pruned. */
  boundary?: {
    parentTag: string;
    epoch: number;
    digest: string;
    senderLeafIndex?: number;
  };
}

/** A group's singleton records. Every field is optional. */
export interface GroupRecord {
  /** Canonical state (MLS `ClientState`). */
  state?: Uint8Array;
  /** Scrubbed state shell kept after disband (MLS `ClientState`). */
  registryState?: Uint8Array;
  /** Committed Welcome confirmation tags (hex), retained across epochs, rejoins and disband. */
  adoptionIds?: string[];
  /** Whether the client's removal has been realized. */
  removed?: boolean;
  removal?: RemovalRecord;
  disbandRequest?: DisbandRequestRecord;
  disbandConvergence?: DisbandConvergenceRecord;
  disbandTombstone?: DisbandTombstoneRecord;
  publication?: PublicationRecord;
  checkpoint?: TreeCheckpointRecord;
}

/**
 * A partial update of the {@link GroupRecord}: listed fields are replaced,
 * `null` deletes a field, omitted fields are kept.
 */
export type GroupRecordUpdate = {
  [K in keyof GroupRecord]?: GroupRecord[K] | null;
};

// ---------------------------------------------------------------------------
// Group database: tables
// ---------------------------------------------------------------------------

/** One fork-history node: a group state and the commit that produced it. */
export interface TreeNodeRow {
  /** Hex confirmation tag of the state. Primary key. */
  tag: string;
  epoch: number;
  /** Parent state tag; absent for the original root. */
  parentTag?: string;
  /** Digest of the producing commit (hex). */
  commitDigest?: string;
  /** Leaf index of the committer, when known. */
  senderLeafIndex?: number;
  /** The state (MLS `ClientState`). */
  snapshot: Uint8Array;
  /** The producing commit (MLS message); absent for the original root. */
  commit?: Uint8Array;
  ownCommitStamp?: OwnCommitStampRecord;
}

/** How a processed transport wrapper was resolved. */
export type WrapperOutcome = "accepted" | "stale" | "invalidated";

/** A processed transport wrapper (kind-445 event). */
export interface WrapperRow {
  /** Wrapper event id. Primary key. */
  id: string;
  /** Epoch the wrapper was processed at. Indexed for retention. */
  epoch: number;
  outcome: WrapperOutcome;
}

/** A state change reported to the app when a fork switch is observed. */
export type StateNotificationRecord =
  | { kind: "epochAdvanced"; commitDigest: string; from: number; to: number }
  | { kind: "memberAdded"; commitDigest: string; pubkey: string }
  | {
      kind: "memberRemoved";
      commitDigest: string;
      pubkey: string;
      actor?: string;
    }
  | { kind: "componentChanged"; commitDigest: string; componentId: number }
  | { kind: "selfRemoved"; commitDigest: string }
  | { kind: "branchRecovered"; commitDigest: string; forkEpoch: number };

/** A fork-switch effect (withdrawal or re-adoption) and whether it was observed. */
export interface EffectRow {
  /** Commit digest the effect concerns (hex). Primary key. */
  digest: string;
  /** Indexed. */
  state: "pending" | "observed";
  direction: "withdrawal" | "adoption";
  forkEpoch?: number;
  producingEpoch?: number;
  notifications: StateNotificationRecord[];
}

/** Backfill paging state for one relay. */
export interface BackfillRow {
  /** Normalized relay URL. Primary key. */
  relay: string;
  /** Unix seconds up to which this relay's history has been read. */
  cursor?: number;
  /** A range already fetched by an interrupted, page-capped backfill. */
  progress?: { from: number; to: number };
}

/**
 * One decrypted application message (rumor), deduplicated by rumor id. The
 * fields are the rumor's own.
 */
export interface MessageRow {
  /** Rumor id. Primary key. */
  id: string;
  /** Indexed. */
  kind: number;
  /** Author. Indexed. */
  pubkey: string;
  /** Rumor `created_at` (unix seconds). Indexed. */
  createdAt: number;
  content: string;
  /** Rumor tags. Single-letter tags (`["e", id, …]`) are indexed. */
  tags: string[][];
}

/** Re-adoption material for a delivery, kept within the retention window. */
export interface DeliveryEvidence {
  /** The kind-445 transport event. */
  envelope: NostrEvent;
  /** The MLS application message. */
  message: Uint8Array;
  /** The decrypted MLS application data. */
  payload: Uint8Array;
  /** Digest of the commit that produced the delivery state (hex). */
  commitDigest?: string;
}

/**
 * How one message arrived: a single delivery of an MLS application message
 * on one fork-history state. Several deliveries can carry the same rumor.
 */
export interface DeliveryRow {
  /** Delivery id (`<stateTag>:<transportId>`). Primary key. */
  id: string;
  /** Rumor carried by this delivery. Indexed. */
  rumorId: string;
  /** Fork-history state the payload decrypted against. */
  stateTag: string;
  /** Epoch of that state. */
  epoch: number;
  /** Transport event id. */
  transportId: string;
  /** When the delivery was recorded (unix seconds). */
  createdAt: number;
  /** Present while the delivery is within the retention window. Indexed (sparse). */
  evidence?: DeliveryEvidence;
}

/**
 * A message query: one Nostr filter over message rows (NIP-01, NIP-91 `&`
 * tags and NIP-50 `search`). Results are newest first (`createdAt`
 * descending, then `id` ascending) and truncated to `limit`. Matching follows
 * `compileMessageFilter`; adapters that cannot index a clause may
 * answer it with `selectMessages` over the rows they load.
 */
export type MessageFilter = Filter;

/**
 * Read access to one group's tables.
 * Optional `all()` methods support diagnostics: they return detached rows,
 * may read an entire table into memory, and can expose private material.
 */
export interface GroupReader {
  /** The group's singleton record (empty when nothing is stored). */
  group(): Promise<GroupRecord>;
  treeNodes: {
    /** All rows, ordered by tag. */
    all?(): Promise<TreeNodeRow[]>;
    get(tag: string): Promise<TreeNodeRow | undefined>;
  };
  wrappers: {
    /** All rows, ordered by id. */
    all?(): Promise<WrapperRow[]>;
    get(id: string): Promise<WrapperRow | undefined>;
  };
  effects: {
    /** All rows, ordered by digest. */
    all?(): Promise<EffectRow[]>;
    get(digest: string): Promise<EffectRow | undefined>;
    /** Effects in one state. Index-backed. */
    byState(state: EffectRow["state"]): Promise<EffectRow[]>;
  };
  backfill: {
    /** All rows, ordered by relay. */
    all?(): Promise<BackfillRow[]>;
    get(relay: string): Promise<BackfillRow | undefined>;
  };
  messages: {
    /** All rows, ordered by id (unlike the time-ordered query). */
    all?(): Promise<MessageRow[]>;
    get(id: string): Promise<MessageRow | undefined>;
    /** Index-backed query; see {@link MessageFilter}. */
    query(filter: MessageFilter): Promise<MessageRow[]>;
  };
  deliveries: {
    /** All rows, ordered by id, including deliveries without evidence or a rumor. */
    all?(): Promise<DeliveryRow[]>;
    /** Every delivery of one rumor. Index-backed. */
    byRumor(rumorId: string): Promise<DeliveryRow[]>;
    /** Number of deliveries of one rumor. Index-backed. */
    countByRumor(rumorId: string): Promise<number>;
    /** Deliveries that still hold evidence. Sparse index. */
    withEvidence(): Promise<DeliveryRow[]>;
  };
}

/** Read and write access inside one group transaction. */
export interface GroupTransaction extends GroupReader {
  /** Applies a partial update to the group record. */
  updateGroup(update: GroupRecordUpdate): Promise<void>;
  treeNodes: GroupReader["treeNodes"] & {
    put(row: TreeNodeRow): Promise<void>;
    delete(tag: string): Promise<void>;
  };
  wrappers: GroupReader["wrappers"] & {
    put(row: WrapperRow): Promise<void>;
    /** Deletes wrappers with `epoch < floor`, keeping ids in `except`. */
    deleteBelow(floor: number, except?: readonly string[]): Promise<void>;
  };
  effects: GroupReader["effects"] & {
    put(row: EffectRow): Promise<void>;
    delete(digest: string): Promise<void>;
  };
  backfill: GroupReader["backfill"] & {
    put(row: BackfillRow): Promise<void>;
    delete(relay: string): Promise<void>;
  };
  messages: GroupReader["messages"] & {
    put(row: MessageRow): Promise<void>;
    delete(id: string): Promise<void>;
  };
  deliveries: GroupReader["deliveries"] & {
    put(row: DeliveryRow): Promise<void>;
    delete(id: string): Promise<void>;
  };
}

/** One group's database. Reads outside a transaction see committed data. */
export interface MarmotGroupDatabase extends GroupReader {
  /**
   * Runs `fn` atomically across every table: all writes commit, or none do
   * if it throws. `fn` may only await the transaction's methods. Resolves
   * once the commit is durable.
   */
  transaction<T>(fn: (tx: GroupTransaction) => Promise<T>): Promise<T>;
  /** Releases the connection without deleting data. */
  close(): Promise<void>;
}

/** Opens and deletes per-group databases. */
export interface MarmotGroupDatabases {
  /**
   * Stored group ids, ordered lexically, including unregistered groups.
   * Optional diagnostic capability. Adapters may omit empty databases.
   * Does not open or create databases.
   */
  list?(): Promise<string[]>;
  /** Opens (creating if needed) the database of one group. */
  open(groupId: string): Promise<MarmotGroupDatabase>;
  /** Permanently deletes one group's database. Missing groups are not an error. */
  drop(groupId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

/** A key package this account published or holds keys for. */
export interface KeyPackageRow {
  /** Hex key package reference. Primary key. */
  ref: string;
  /** The key package (TLS-encoded MLS `KeyPackage`). */
  publicPackage: Uint8Array;
  /** Its private keys (TLS-encoded MLS private key package), when held locally. */
  privatePackage?: Uint8Array;
  /** Publication slot (`d` tag / client id), when assigned. */
  identifier?: string;
  /** Lifetime start (unix seconds). */
  notBefore: number;
  /** Whether a Welcome consumed this package. */
  used: boolean;
  /** Kind-30443 events this package was published under. */
  published: NostrEvent[];
  /** Relays it was published to. */
  relays?: string[];
  /** Groups whose Welcome consumed it, awaiting retirement (hex ids). */
  consumptionReceipts: {
    groupId: string;
    keyPackageRef: string;
    /** Hex Welcome confirmation tag; absent on legacy group-only receipts. */
    adoptionTag?: string;
  }[];
}

/** Lifecycle state of an invite gift wrap. */
export type InviteState = "received" | "unread" | "seen";

/**
 * An invite. `received` rows (keyed by gift wrap id) hold the gift wrap and
 * its decryption progress; `unread` rows (keyed by rumor id) hold a decrypted
 * Welcome rumor; `seen` rows (gift wrap id) mark a gift wrap as handled.
 */
export interface InviteRow {
  /** Gift wrap id, or rumor id for `unread` rows. Primary key. */
  id: string;
  /** Indexed. */
  state: InviteState;
  /** Welcome rumor id once decrypted. Indexed. */
  rumorId?: string;
  /** When the gift wrap was created (unix seconds). */
  receivedAt: number;
  /** The kind-1059 gift wrap (`received`). */
  giftwrap?: NostrEvent;
  /** The decrypted kind-444 Welcome rumor. */
  rumor?: Rumor;
  /** Decryption was attempted (`received`). */
  attempted?: boolean;
  /** The plaintext was permanently invalid (`received`). */
  invalid?: boolean;
}

/** A group known to this account. */
export interface GroupRow {
  /** Hex group id. Primary key. */
  id: string;
  status: "active" | "terminal";
}

/** A multi-database operation in progress, finished or undone on start. */
export interface IntentRow {
  /** Intent id. Primary key. */
  id: string;
  kind: "join" | "create" | "destroy";
  /** Hex group id the intent concerns. */
  groupId: string;
}

/** Read access to the account tables. */
export interface AccountReader {
  keyPackages: {
    get(ref: string): Promise<KeyPackageRow | undefined>;
    all(): Promise<KeyPackageRow[]>;
  };
  invites: {
    /** Optional diagnostic read: detached rows across every state, ordered by id. */
    all?(): Promise<InviteRow[]>;
    get(id: string): Promise<InviteRow | undefined>;
    /** Invites in one state, oldest first. Index-backed. */
    byState(state: InviteState): Promise<InviteRow[]>;
    /** The invite whose Welcome rumor has this id. Index-backed. */
    byRumor(rumorId: string): Promise<InviteRow | undefined>;
  };
  groups: {
    get(id: string): Promise<GroupRow | undefined>;
    all(): Promise<GroupRow[]>;
  };
  intents: {
    all(): Promise<IntentRow[]>;
  };
}

/** Read and write access inside one account transaction. */
export interface AccountTransaction extends AccountReader {
  keyPackages: AccountReader["keyPackages"] & {
    put(row: KeyPackageRow): Promise<void>;
    delete(ref: string): Promise<void>;
  };
  invites: AccountReader["invites"] & {
    put(row: InviteRow): Promise<void>;
    delete(id: string): Promise<void>;
  };
  groups: AccountReader["groups"] & {
    put(row: GroupRow): Promise<void>;
    delete(id: string): Promise<void>;
  };
  intents: AccountReader["intents"] & {
    put(row: IntentRow): Promise<void>;
    delete(id: string): Promise<void>;
  };
}

/** The account database. Reads outside a transaction see committed data. */
export interface MarmotAccountDatabase extends AccountReader {
  /** Runs `fn` atomically; see {@link MarmotGroupDatabase.transaction}. */
  transaction<T>(fn: (tx: AccountTransaction) => Promise<T>): Promise<T>;
  /** Releases the connection without deleting data. */
  close(): Promise<void>;
}

/** Everything a Marmot client persists. */
export interface MarmotDatabase {
  account: MarmotAccountDatabase;
  groups: MarmotGroupDatabases;
}
