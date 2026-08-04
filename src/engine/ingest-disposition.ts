/** @module @category Engine */
import {
  disposition,
  inputCategories,
  type Disposition,
} from "../core/inbound.js";
import type { IngestResult } from "./types.js";

/** Maps an {@link IngestResult} to its protocol-visible {@link Disposition}. */
export function ingestResultDisposition<TEnvelope>(
  result: IngestResult<TEnvelope>,
): Disposition {
  switch (result.kind) {
    case "processed":
      return disposition.accepted();
    case "rejected":
      return disposition.stale(inputCategories.authorizationFailed);
    case "deferred":
      return disposition.deferred(result.reason);
    case "invalidated":
      return disposition.invalidated();
    case "stateInvalidated":
      // A withdrawn group-state notification is the state-side counterpart of
      // an invalidated app payload (convergence.md calls withdrawal the
      // counterpart of app-payload invalidation).
      return disposition.invalidated();
    case "autoCommit":
      // A locally-staged self_remove-only commit (B6) — an accepted local action,
      // not an inbound message disposition.
      return disposition.accepted();
    case "removed":
      // A valid commit that legitimately removed us — accepted inbound; terminal
      // for our membership (member-departure.md).
      return disposition.accepted();
    case "skipped":
      switch (result.reason) {
        case "past-epoch":
          return disposition.stale(inputCategories.alreadyApplied);
        case "self-echo":
          return disposition.stale(inputCategories.ownEcho);
        case "duplicate":
          return disposition.stale(inputCategories.duplicate);
        case "wrong-wireformat":
        case "invalid-app-payload":
          return disposition.stale(inputCategories.invalidEncoding);
        case "beyond-anchor":
        case "missing-retained-anchor":
          return disposition.stale(inputCategories.missingHistory);
        case "self-evicted":
          return disposition.stale(inputCategories.staleEpoch);
      }
    // eslint-disable-next-line no-fallthrough
    case "unreadable":
      return disposition.stale(inputCategories.invalidEncoding);
  }
}
