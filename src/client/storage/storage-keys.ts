/**
 * The group database's `meta` record names, in one place.
 *
 * Each group has its own {@link MarmotGroupDatabase}, so keys carry no group
 * id. Tables (`treeNodes`, `wrappers`, `messages`, `deliveries`) hold the
 * records that grow; `meta` holds singletons:
 *
 * ```
 * state                      TLS ClientState (canonical tip)
 * tree                       fork-history checkpoint
 * removed                    removal realized marker
 * removal                    removal attribution evidence
 * publication                pending commit publication
 * effects                    convergence effects ledger
 * delivered                  delivered-payload evidence
 * disband/{request,convergence,terminal,intent,registry-state}
 * backfill-cursor/<relay>    backfill cursor (relay hash)
 * backfill-progress/<relay>  backfill paging progress (relay hash)
 * ```
 *
 * @module
 */
import type { GroupMetaKey } from "./database/types.js";

/** Meta record names of one group database. */
export const groupKeys = {
  state: "state",
  removed: "removed",
  removalAttribution: "removal",
  publication: "publication",
  effects: "effects",
  delivered: "delivered",
  backfillCursor: (relayHash: string): GroupMetaKey =>
    `backfill-cursor/${relayHash}`,
  backfillProgress: (relayHash: string): GroupMetaKey =>
    `backfill-progress/${relayHash}`,
} as const satisfies Record<
  string,
  GroupMetaKey | ((relayHash: string) => GroupMetaKey)
>;
