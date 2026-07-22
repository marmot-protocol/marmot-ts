/** @module @category Client - Verify */
import type { VerifiedEvent, VerifyEventMethod } from "applesauce-core/helpers";
import { fakeVerifyEvent, verifyEvent } from "applesauce-core/helpers";

export type { VerifiedEvent, VerifyEventMethod };
export { fakeVerifyEvent, verifyEvent };

/**
 * The reason an inbound Nostr event was rejected at the trust boundary.
 *
 * - `"invalid-signature"` — the event's NIP-01 id or BIP-340 Schnorr signature
 *   did not verify.
 * - `"lifetime-cap"` — a KeyPackage's MLS `Lifetime` is missing, over-long, or
 *   not current.
 * - `"tag-cardinality"` — a required tag was absent, repeated, empty, or
 *   carried duplicate/extra values.
 */
export type RejectReason =
  "invalid-signature" | "lifetime-cap" | "tag-cardinality";

/**
 * The default, injectable event verifier. Re-exports applesauce's
 * `verifyEvent`, which recomputes the NIP-01 id and checks the BIP-340
 * Schnorr signature, caching the boolean result on the event.
 *
 * Callers that trust their event source (e.g. a caller that has already
 * verified events upstream) may inject {@link fakeVerifyEvent} instead — do
 * not introduce a separate boolean skip-verification flag.
 */
export const defaultVerifyEvent: VerifyEventMethod = verifyEvent;
