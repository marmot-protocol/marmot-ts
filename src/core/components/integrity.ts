/** @module @category Core - App Components */
import {
  appDataUpdateProposalType,
  ClientState,
  getAppDataDictionary,
  GroupContextExtension,
  Proposal,
} from "ts-mls";

import { getAdminPolicy, getAppComponents } from "./dictionary.js";
import { getGroupMembers } from "../group-members.js";
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
 * {@link validateAdminLeafCoupling}, or {@link validateCommitLegality}.
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

/**
 * Ported from `validate_admin_leaf_coupling_for_staged_commit`: enforces the
 * admin-policy resulting-epoch invariant (admin-policy-v1.md "Validation") —
 * every admin key in the resulting epoch's admin set MUST correspond to an
 * account with at least one member leaf in the resulting epoch.
 *
 * `resultingMemberAccounts` is the set of hex account pubkeys that have at
 * least one member leaf in the RESULTING epoch (D-08: account-level, not
 * leaf-level — an account with two leaves survives if only one is removed).
 * Callers derive it from the post-apply state; this validator stays pure and
 * MLS-free.
 *
 * When the resulting extensions carry no admin-policy bytes, this evaluates
 * the carried-forward (current-epoch) admin set instead of skipping the check
 * (Pitfall 3): a membership-only commit that de-leafs an admin without
 * touching admin-policy bytes must still be rejected.
 *
 * An empty resolved admin set returns `undefined` (vacuously satisfied):
 * component bytes cannot encode an empty admin list, so an empty resolved set
 * means the epoch carries no admin-policy state at all — not a bypass, per
 * MDK's own documented rationale for the same early return.
 *
 * Does NOT special-case SelfRemove (Pitfall 4): a non-admin's SelfRemove never
 * changes the admin set and passes trivially here; an admin's SelfRemove is
 * already refused earlier by `createAdminCommitPolicyCallback`
 * (`src/engine/admin-policy.ts`), so this validator never needs its own
 * carve-out for it.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_admin_leaf_coupling_for_staged_commit`, `reject_admins_without_member_accounts`
 * @see Marmot v2 spec: app-components/admin-policy-v1.md "Validation"
 */
export function validateAdminLeafCoupling(args: {
  currentExtensions: GroupContextExtension[];
  resultingExtensions: GroupContextExtension[];
  resultingMemberAccounts: readonly string[];
}): CommitIntegrityViolation | undefined {
  let resultingAdmins: string[];
  try {
    const resultingSet = getAdminPolicy(args.resultingExtensions);
    if (resultingSet !== undefined) {
      resultingAdmins = resultingSet;
    } else {
      const carriedForward = getAdminPolicy(args.currentExtensions);
      resultingAdmins = carriedForward ?? [];
    }
  } catch {
    return {
      reason: "admin-leaf-coupling",
      detail: "resulting admin-policy component did not decode",
    };
  }

  // An empty resolved admin set means the epoch has no admin-policy state at
  // all (component bytes cannot encode an empty list) — vacuously satisfied,
  // not a bypass.
  if (resultingAdmins.length === 0) return undefined;

  const memberAccounts = new Set(args.resultingMemberAccounts);
  const orphaned = resultingAdmins.filter(
    (admin) => !memberAccounts.has(admin),
  );
  if (orphaned.length > 0) {
    return {
      reason: "admin-leaf-coupling",
      detail: `${orphaned.length} admin key(s) have no member leaf in the resulting epoch`,
    };
  }

  return undefined;
}

/**
 * The single shared seam adapter for commit legality: derives every argument
 * {@link validateAppComponentIntegrity} and {@link validateAdminLeafCoupling}
 * need from `parentState`/`resultingState`/`proposals`, so no seam re-derives
 * them independently (the mdk#707 bug class — "a guard that exists on one
 * seam only is a documented bug").
 *
 * Stays pure: reads two `ClientState` values, performs no I/O, and calls
 * nothing from `src/engine` or `src/client`.
 *
 * Each calling seam supplies its own disposition for a returned violation:
 * throw on send (D-02), `rejected` with the violation's `reason` on inbound
 * (D-03), or drop the candidate edge on convergence/replay (D-04/D-09). This
 * adapter itself is seam-agnostic.
 */
export function validateCommitLegality(args: {
  parentState: ClientState;
  resultingState: ClientState;
  proposals: readonly Proposal[];
}): CommitIntegrityViolation | undefined {
  const appDataUpdateOps = collectAppDataUpdateOps(args.proposals);
  const requiredIds =
    getAppComponents(args.parentState.groupContext.extensions) ?? [];

  const integrityViolation = validateAppComponentIntegrity({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    appDataUpdateOps,
    requiredIds,
  });
  if (integrityViolation) return integrityViolation;

  const resultingMemberAccounts = getGroupMembers(args.resultingState);

  return validateAdminLeafCoupling({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    resultingMemberAccounts,
  });
}
