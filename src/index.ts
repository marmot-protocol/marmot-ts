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
} from "./engine/group-engine.js";
export type {
  IngestionPoolOptions,
  PooledEntry,
} from "./engine/ingestion-pool.js";
export type {
  GroupPeeler,
  PendingState,
  PeeledMessagePair,
  ProposalAction,
  ProposalContext,
  SendIntent,
  SendResult,
} from "./engine/types.js";
