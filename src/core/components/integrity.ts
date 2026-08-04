/** @module @category Core - App Components */
import {
  appDataUpdateProposalType,
  getAppDataDictionary,
  GroupContextExtension,
  Proposal,
} from "ts-mls";

import { APP_COMPONENTS_COMPONENT_ID, AppComponentId } from "./ids.js";
import { compareBytes } from "./bytes.js";

/**
 * Ported commit-legality validators for the Marmot app-component layer.
 *
 * Both validators here are pure, seam-agnostic, and non-throwing by design
 * (D-01/D-02 split): they read plain `GroupContextExtension[]` values and
 * return a typed {@link CommitIntegrityViolation} instead of throwing, so
 * every calling seam (send, inbound, convergence/replay) decides its own
 * disposition — throw, `rejected`, or drop-edge — for the same violation.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs
 * @see Marmot v2 spec: app-components/README.md, app-components/admin-policy-v1.md
 */

/** The reason a commit was found to violate a ported MDK commit-legality rule. */
export type CommitIntegrityViolationReason =
  "component-integrity" | "admin-leaf-coupling";

/**
 * A typed, non-throwing violation returned by {@link validateAppComponentIntegrity},
 * `validateAdminLeafCoupling`, or `validateCommitLegality`.
 *
 * `detail` is a diagnostic string naming component ids and counts only — never
 * raw pubkeys or other protocol-sensitive material (diagnostics-privacy rule,
 * see foundation/errors.md). The protocol-visible signal is `reason`.
 */
export interface CommitIntegrityViolation {
  reason: CommitIntegrityViolationReason;
  detail: string;
}

/**
 * A single `AppDataUpdate` operation extracted from a commit's proposals, in
 * the shape {@link validateAppComponentIntegrity} consumes. `data === undefined`
 * means the operation is a Remove (mirrors MDK's `Option<&[u8]>` with `None` =
 * Remove).
 */
export interface AppDataUpdateOp {
  componentId: AppComponentId;
  data: Uint8Array | undefined;
}

/**
 * Turns a commit's `Proposal[]` into the `AppDataUpdateOp[]` shape every seam
 * feeds to {@link validateAppComponentIntegrity} (and, later, the shared seam
 * adapter). This is the single adapter every seam uses so the proposal → op
 * mapping is never re-implemented seam-locally.
 *
 * Preserves commit order and does not deduplicate — a component id may legally
 * carry more than one `AppDataUpdate` op in a single commit.
 */
export function collectAppDataUpdateOps(
  proposals: readonly Proposal[],
): AppDataUpdateOp[] {
  const ops: AppDataUpdateOp[] = [];
  for (const proposal of proposals) {
    if (
      proposal.proposalType !== appDataUpdateProposalType ||
      !("appDataUpdate" in proposal)
    )
      continue;
    const { appDataUpdate } = proposal;
    if (appDataUpdate.operation === "update") {
      ops.push({
        componentId: appDataUpdate.componentId,
        data: appDataUpdate.update,
      });
    } else {
      ops.push({ componentId: appDataUpdate.componentId, data: undefined });
    }
  }
  return ops;
}

/** Treats `undefined` on both sides as equal; `undefined` vs defined is unequal. */
function bytesEqual(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return compareBytes(a, b) === 0 && a.length === b.length;
}

/**
 * Ported from `validate_app_component_integrity_for_staged_commit`: rejects a
 * commit whose resulting GroupContext strips or rewrites Marmot component
 * state outside the validated `AppDataUpdate` channel.
 *
 * Enforced rules, in order (mirrors the MDK rustdoc numbering):
 * 1. the `app_data_dictionary` extension itself may never be dropped if it was
 *    present before;
 * 2. the `app_components` id (`0x0001`) and every id in the CURRENT epoch's
 *    required-component-id list may never be dropped;
 * 3. every dictionary entry that changes relative to the current epoch —
 *    added, rewritten, or removed — must match one of this commit's own
 *    `AppDataUpdate` operations.
 *
 * @param args.requiredIds MUST be derived by the caller from the CURRENT
 * (pre-commit) extensions — see Pitfall 2 in 03-RESEARCH.md. Deriving this
 * from `resultingExtensions` would let a commit add an id to `app_components`
 * and thereby protect that same id in the same commit, which is the exact bug
 * class this validator exists to close.
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_app_component_integrity_for_staged_commit`
 * @see Marmot v2 spec: app-components/README.md "Update Processing", "Unknown Data"
 */
export function validateAppComponentIntegrity(args: {
  currentExtensions: GroupContextExtension[];
  resultingExtensions: GroupContextExtension[];
  appDataUpdateOps: readonly AppDataUpdateOp[];
  requiredIds: readonly AppComponentId[];
}): CommitIntegrityViolation | undefined {
  // Read the raw dictionary generically (not the typed accessors in
  // dictionary.ts) so unknown component ids participate in the diff.
  const current = getAppDataDictionary(args.currentExtensions);
  const resulting = getAppDataDictionary(args.resultingExtensions);

  // Rule 1: the app_data_dictionary extension itself may never be dropped.
  if (current !== undefined && resulting === undefined) {
    return {
      reason: "component-integrity",
      detail: "resulting GroupContext drops the app_data_dictionary",
    };
  }

  // Rule 2: the protected set (current required ids + 0x0001) may never be
  // dropped.
  const protectedIds = new Set<AppComponentId>(args.requiredIds);
  protectedIds.add(APP_COMPONENTS_COMPONENT_ID);
  for (const id of protectedIds) {
    const currentlyPresent =
      current?.some((c) => c.componentId === id) ?? false;
    const stillPresent = resulting?.some((c) => c.componentId === id) ?? false;
    if (currentlyPresent && !stillPresent) {
      return {
        reason: "component-integrity",
        detail: `drops required app component 0x${id.toString(16)}`,
      };
    }
  }

  // Rule 3: every changed entry must be attributable to one of this commit's
  // own AppDataUpdate ops.
  const opsByComponent = new Map<AppComponentId, (Uint8Array | undefined)[]>();
  for (const op of args.appDataUpdateOps) {
    const list = opsByComponent.get(op.componentId) ?? [];
    list.push(op.data);
    opsByComponent.set(op.componentId, list);
  }

  const allIds = new Set<AppComponentId>();
  for (const entry of current ?? []) allIds.add(entry.componentId);
  for (const entry of resulting ?? []) allIds.add(entry.componentId);

  for (const id of allIds) {
    const before = current?.find((c) => c.componentId === id)?.data;
    const after = resulting?.find((c) => c.componentId === id)?.data;
    if (bytesEqual(before, after)) continue;

    const allowed = opsByComponent.get(id);
    const backed = allowed?.some((candidate) => bytesEqual(candidate, after));
    if (!backed) {
      return {
        reason: "component-integrity",
        detail: `changes app component 0x${id.toString(16)} outside an AppDataUpdate proposal`,
      };
    }
  }

  return undefined;
}
