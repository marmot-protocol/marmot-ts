export * from "./client/index.js";
export * from "./core/index.js";
export * from "./utils/index.js";

// The engine is a standalone component built on core; expose its full surface
// through the `./engine` subpath, and re-export the parts of it that do not
// collide with the client's Nostr-flavored ingest types here in the root barrel.
export { createAdminCommitPolicyCallback } from "./engine/admin-policy.js";
export {
  MarmotGroupEngine,
  type MarmotGroupEngineOptions,
  type ConvergenceScheduler,
  type TimerHandle,
} from "./engine/group-engine.js";
export {
  GroupHistoryTree,
  type EdgeSnapshot,
  type HistoryEdge,
  type HistoryNode,
} from "./engine/history-tree.js";
export type {
  IngestionPoolOptions,
  PooledEntry,
} from "./engine/ingestion-pool.js";
export type { RetainedHistoryStore } from "./engine/retained-store.js";
export {
  groupWithdrawnNotificationsByCommit,
  type StateNotification,
} from "./engine/state-notifications.js";
export type {
  GroupPeeler,
  PendingState,
  PeeledMessagePair,
  ProposalAction,
  ProposalContext,
  SendIntent,
  SendResult,
} from "./engine/types.js";
export type { AuditContextOptions, AuditSink } from "./audit/index.js";
