/**
 * The client's storage key layout, in one place.
 *
 * Root keys in the app's {@link MarmotStorage}:
 *
 * ```
 * group/<gid>/state                          TLS ClientState (canonical tip)
 * group/<gid>/removed                        removal realized marker
 * group/<gid>/removal-attribution            removal evidence record
 * group/<gid>/disband/...                    disband request/convergence/intent/terminal/registry-state
 * group/<gid>/tree/{meta,edge,state,commit}  full-fork history tree
 * group/<gid>/publication                    pending commit publication
 * group/<gid>/ingest/wrapper/<eventId>       processed transport wrapper
 * group/<gid>/ingest/effect/<digest>         convergence effect
 * group/<gid>/ingest/delivered               delivered-payload evidence
 * group/<gid>/ingest/backfill-{cursor,progress}/<relay>  backfill paging state
 * keypackage/<ref>                           stored key package (private keys included)
 * invite/<giftWrapId>                        received invite
 * ```
 *
 * Group-scoped components receive a view scoped to `group/`, so their keys
 * start with `<gid>/`.
 *
 * @module
 */

/** Prefix of every group-scoped key. */
export const GROUP_PREFIX = "group/";
/** Prefix of every stored key package. */
export const KEY_PACKAGE_PREFIX = "keypackage/";
/** Prefix of every stored invite. */
export const INVITE_PREFIX = "invite/";

/** Keys relative to the `group/`-scoped storage view. */
export const groupKeys = {
  /** Every key owned by one group. */
  prefix: (gid: string) => `${gid}/`,
  state: (gid: string) => `${gid}/state`,
  removed: (gid: string) => `${gid}/removed`,
  removalAttribution: (gid: string) => `${gid}/removal-attribution`,
  publication: (gid: string) => `${gid}/publication`,
  wrapperPrefix: (gid: string) => `${gid}/ingest/wrapper/`,
  effectPrefix: (gid: string) => `${gid}/ingest/effect/`,
  delivered: (gid: string) => `${gid}/ingest/delivered`,
};

/** Parses the group id from a `group/`-scoped key. */
export function groupIdOfKey(key: string): string | undefined {
  const gid = key.slice(0, key.indexOf("/"));
  return /^[0-9a-f]+$/.test(gid) ? gid : undefined;
}
