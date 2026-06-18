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
    case "skipped":
      switch (result.reason) {
        case "past-epoch":
          return disposition.stale(inputCategories.alreadyApplied);
        case "self-echo":
          return disposition.stale(inputCategories.ownEcho);
        case "wrong-wireformat":
          return disposition.stale(inputCategories.invalidEncoding);
        case "beyond-anchor":
        case "missing-retained-anchor":
          return disposition.stale(inputCategories.missingHistory);
      }
    // eslint-disable-next-line no-fallthrough
    case "unreadable":
      return disposition.stale(inputCategories.invalidEncoding);
  }
}
