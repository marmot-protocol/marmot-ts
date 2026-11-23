/**
 * The storage contract an app supplies to a Marmot client: one database per
 * group plus one account database, each made of typed tables with named,
 * index-backed queries.
 *
 * Adapters store plaintext index columns next to one opaque `value` the
 * library encodes. The library prepares every value before it opens a
 * transaction, so a transaction callback only awaits the transaction's own
 * methods (IndexedDB commits a transaction as soon as it goes idle).
 *
 * Values hold MLS secrets and private key material. Encryption at rest is the
 * adapter's responsibility (SQLCipher, an encrypted file system, or an
 * encrypting IndexedDB wrapper).
 *
 * @module @category Storage
 */

/** A row whose payload is library-encoded bytes. */
export interface Row {
  /** Library-encoded record. Adapters store it verbatim. */
  value: Uint8Array;
}

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

/** Singleton records of one group, addressed by name. */
export type GroupMetaKey =
  /** Canonical `ClientState` (TLS). */
  | "state"
  /** Fork-history checkpoint. */
  | "tree"
  /** Removal-realized marker. */
  | "removed"
  /** Removal attribution evidence. */
  | "removal"
  /** Pending commit publication. */
  | "publication"
  /** Convergence effects ledger. */
  | "effects"
  /** Delivered application payload evidence. */
  | "delivered"
  | "disband/request"
  | "disband/convergence"
  | "disband/terminal"
  | "disband/intent"
  | "disband/registry-state"
  /** Per-relay backfill cursor (relay hash suffix). */
  | `backfill-cursor/${string}`
  /** Per-relay backfill paging progress (relay hash suffix). */
  | `backfill-progress/${string}`;

/** A heavy fork-history node: the snapshot and commit for one state tag. */
export interface TreeNodeRow extends Row {
  /** Hex confirmation tag of the state. Primary key. */
  tag: string;
}

/** A processed transport wrapper (kind-445 event). */
export interface WrapperRow extends Row {
  /** Wrapper event id. Primary key. */
  id: string;
  /** Epoch the wrapper was processed at. Indexed for retention. */
  epoch: number;
}

/**
 * One decrypted application message (rumor), deduplicated by rumor id.
 * `value` is the rumor itself; the other columns are copied from it so the
 * database can index them.
 */
export interface MessageRow extends Row {
  /** Rumor id. Primary key. */
  id: string;
  kind: number;
  pubkey: string;
  /** Rumor `created_at` (unix seconds). */
  createdAt: number;
  /** Indexable single-letter tags, each encoded as `"<name>:<value>"`. */
  tags: string[];
}

/**
 * How one rumor arrived: a single delivery of an MLS application message on
 * one fork-history state. Several deliveries can carry the same rumor.
 */
export interface DeliveryRow extends Row {
  /** Delivery id (`<stateTag>:<transport id>`). Primary key. */
  id: string;
  /** Rumor carried by this delivery. Indexed. */
  rumorId: string;
  /** Epoch the payload decrypted against. */
  epoch: number;
  /** When the delivery was recorded (unix seconds). */
  createdAt: number;
  /**
   * Material needed to re-adopt the delivery after a fork switch (transport
   * envelope, MLS message, payload). Cleared once it leaves the retention
   * window. Rows with evidence are indexed (sparse).
   */
  evidence?: Uint8Array;
}

/**
 * A message query. Clauses intersect; values inside one clause are
 * alternatives. Results are newest first (`createdAt` descending, then `id`
 * ascending).
 */
export interface MessageQuery {
  ids?: readonly string[];
  kinds?: readonly number[];
  authors?: readonly string[];
  /** Each entry is a set of `"<name>:<value>"` alternatives; entries intersect. */
  tags?: readonly (readonly string[])[];
  /** Inclusive lower bound on `createdAt`. */
  since?: number;
  /** Inclusive upper bound on `createdAt`. */
  until?: number;
  limit?: number;
}

/** Read access to one group's tables. */
export interface GroupReader {
  meta: {
    get(key: GroupMetaKey): Promise<Uint8Array | undefined>;
  };
  treeNodes: {
    get(tag: string): Promise<TreeNodeRow | undefined>;
  };
  wrappers: {
    get(id: string): Promise<WrapperRow | undefined>;
  };
  messages: {
    get(id: string): Promise<MessageRow | undefined>;
    /** Index-backed query; see {@link MessageQuery}. */
    query(query: MessageQuery): Promise<MessageRow[]>;
  };
  deliveries: {
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
  meta: GroupReader["meta"] & {
    set(key: GroupMetaKey, value: Uint8Array): Promise<void>;
    delete(key: GroupMetaKey): Promise<void>;
  };
  treeNodes: GroupReader["treeNodes"] & {
    put(row: TreeNodeRow): Promise<void>;
    delete(tag: string): Promise<void>;
  };
  wrappers: GroupReader["wrappers"] & {
    put(row: WrapperRow): Promise<void>;
    /** Deletes wrappers with `epoch < floor`, keeping ids in `except`. */
    deleteBelow(floor: number, except?: readonly string[]): Promise<void>;
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
  /** Opens (creating if needed) the database of one group. */
  open(groupId: string): Promise<MarmotGroupDatabase>;
  /** Permanently deletes one group's database. Missing groups are not an error. */
  drop(groupId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

/** A stored key package (private keys included in `value`). */
export interface KeyPackageRow extends Row {
  /** Hex key package reference. Primary key. */
  ref: string;
  /** Publication slot (`d` tag / client id), when assigned. */
  identifier?: string;
  /** Lifetime start (unix seconds). */
  notBefore: number;
  /** Whether a Welcome consumed this package. */
  used: boolean;
}

/** Lifecycle state of an invite gift wrap. */
export type InviteState = "received" | "unread" | "seen";

/** An invite gift wrap and, once decrypted, its Welcome rumor. */
export interface InviteRow extends Row {
  /** Gift wrap event id. Primary key. */
  id: string;
  /** Indexed. */
  state: InviteState;
  /** Welcome rumor id once decrypted. Indexed. */
  rumorId?: string;
  /** When the gift wrap was received (unix seconds). */
  receivedAt: number;
}

/** A group known to this account. */
export interface GroupRow extends Row {
  /** Hex group id. Primary key. */
  id: string;
  status: "active" | "terminal";
}

/** A multi-database operation in progress, replayed or rolled back on start. */
export interface IntentRow extends Row {
  /** Intent id. Primary key. */
  id: string;
  kind: "join" | "create" | "destroy";
  /** Hex group id the intent concerns. */
  groupId: string;
}

/** Read access to the account tables. */
export interface AccountReader {
  meta: {
    get(key: string): Promise<Uint8Array | undefined>;
  };
  keyPackages: {
    get(ref: string): Promise<KeyPackageRow | undefined>;
    all(): Promise<KeyPackageRow[]>;
  };
  invites: {
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
  meta: AccountReader["meta"] & {
    set(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
  };
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
