/** @module @category Core - App Components */
import {
  appDataUpdateProposalType,
  ClientState,
  defaultProposalTypes,
  getAppDataDictionary,
  GroupContextExtension,
  Proposal,
  ProposalWithSender,
} from "ts-mls";

import { getAdminPolicy, getAppComponents } from "./dictionary.js";
import { getGroupMemberPubkeys } from "../group-members.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  AppComponentId,
} from "./ids.js";
import { bytesEqual } from "./bytes.js";
import {
  AccountIdentityProofError,
  getGroupProfileSupport,
  validateKeyPackageAccountIdentityProof,
  validateLeafAccountIdentityProof,
  type AccountIdentityProofRejectReason,
} from "./account-identity-proof.js";
import { diffChangedLeaves } from "./tree-diff.js";
import {
  classifyDisbandCommit,
  type DisbandClassification,
} from "./disband-validation.js";

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
  | "component-integrity"
  | "admin-leaf-coupling"
  | "disband-legality"
  | "account-identity-proof";

/**
 * A typed, non-throwing violation returned by {@link validateAppComponentIntegrity},
 * {@link validateAdminLeafCoupling}, or {@link validateCommitLegality}.
 *
 * `detail` is a diagnostic string naming component ids and counts only — never
 * raw pubkeys or other protocol-sensitive material (diagnostics-privacy rule,
 * see foundation/errors.md). The protocol-visible signal is `reason`.
 *
 * `proofReason` and `leafIndex` are populated only for `reason:
 * "account-identity-proof"` violations (D-06), by
 * {@link validateCommitAccountIdentityProofs} and
 * {@link validateAddProposalAccountIdentityProofs}. Both are pubkey-free:
 * `proofReason` is the caught {@link AccountIdentityProofError.reason} literal
 * and `leafIndex` is the failing leaf's true MLS tree leaf index (`./tree-diff.js`
 * `diffChangedLeaves`'s `leafIndex` — never the member-enumeration index
 * `validateGroupMemberAccountIdentityProofs` uses internally). `leafIndex` is
 * omitted for a profile-drift violation (no single leaf is at fault) and for a
 * pre-apply Add-proposal violation (the leaf has no tree position yet).
 */
export interface CommitIntegrityViolation {
  reason: CommitIntegrityViolationReason;
  detail: string;
  proofReason?: AccountIdentityProofRejectReason;
  leafIndex?: number;
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
 * Preserves commit order and does not deduplicate. Note that a legal commit
 * never carries more than one `AppDataUpdate` op for the same component id —
 * `validatePreApplyProposals` (`src/engine/admin-policy.ts`) rejects a
 * duplicate id before apply, matching MDK's `seen` set in
 * `validate_app_data_update_batch_against`. This adapter stays
 * duplicate-tolerant anyway because it is a pure mapping run on the
 * already-admitted batch, and because rule 3 of
 * {@link validateAppComponentIntegrity} must stay well-defined even for a
 * batch that reached it without pre-apply admission.
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
 *
 * Additionally, per account-identity-proof-v2.md "Lifecycle, authorization, and
 * removal" ("It is not GroupContext state and MUST NOT be created, replaced, or
 * removed with `AppDataUpdate`"), this rejects any commit whose `AppDataUpdate`
 * ops target the leaf-only account identity proof component (`0x8009`), or
 * whose resulting GroupContext dictionary carries a `0x8009` entry at all —
 * mirroring MDK's `CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS`.
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

  // Leaf-only guard: 0x8009 (account identity proof) is never valid
  // GroupContext state, so no AppDataUpdate op may target it and no resulting
  // dictionary entry may carry it, regardless of any AppDataUpdate op backing
  // the change (account-identity-proof-v2.md "Lifecycle, authorization, and
  // removal"; mirrors MDK CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS).
  if (
    args.appDataUpdateOps.some(
      (op) => op.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    )
  ) {
    return {
      reason: "component-integrity",
      detail: "AppDataUpdate targets leaf-only app component 0x8009",
    };
  }
  if (
    resulting?.some(
      (entry) => entry.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    )
  ) {
    return {
      reason: "component-integrity",
      detail: "resulting GroupContext carries leaf-only app component 0x8009",
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
  let resultingSet: string[] | undefined;
  try {
    resultingSet = getAdminPolicy(args.resultingExtensions);
  } catch {
    return {
      reason: "admin-leaf-coupling",
      detail: "resulting admin-policy component did not decode",
    };
  }

  let resultingAdmins: string[];
  if (resultingSet !== undefined) {
    resultingAdmins = resultingSet;
  } else {
    try {
      resultingAdmins = getAdminPolicy(args.currentExtensions) ?? [];
    } catch {
      return {
        reason: "admin-leaf-coupling",
        detail: "carried-forward admin-policy component did not decode",
      };
    }
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
 * Ported from `validate_staged_commit_account_identity_proofs` (D-01, D-02,
 * D-03): rejects a commit that drifts the GroupContext account-identity-proof
 * profile away from `"current"`, or that carries an invalid `0x8009` proof on
 * any new or re-signed member leaf. Pure and non-throwing.
 *
 * Two checks, in order:
 * (a) **Profile drift (D-01a).** Both `parentState` and `resultingState` must
 *     classify as the current profile ({@link getGroupProfileSupport}). Both
 *     are checked — not just the resulting one — so a commit can never
 *     "fix" an already-drifted parent into passing; the profile must already
 *     have been, and remain, current.
 * (b) **Changed-leaf proof validity (D-01b, D-02, D-03).** Every entry
 *     {@link diffChangedLeaves} reports between the two ratchet trees — every
 *     non-blank leaf that is new (Add) or re-signed (Update proposal, or the
 *     committer's own update-path leaf) — is validated with
 *     {@link validateLeafAccountIdentityProof} against the RESULTING epoch's
 *     ciphersuite. Unchanged leaves are trusted and never re-validated (D-01).
 *     Per D-03, this checks proof validity only (support, data, signer,
 *     ciphersuite/scheme, signature key, signature) — it does NOT compare a
 *     changed leaf's identity against the member's prior leaf; that check is
 *     Phase 9 (UPD-01..03).
 *
 * Every thrown `AccountIdentityProofError` (or any other unexpected throw) is
 * caught and mapped to a typed violation, never left to escape — fork-recovery
 * and tree-fed convergence call {@link validateCommitLegality} unwrapped.
 * `detail` never contains a pubkey or other credential bytes (D-06,
 * diagnostics-privacy rule).
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_staged_commit_account_identity_proofs`
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Validation"
 */
export function validateCommitAccountIdentityProofs(args: {
  parentState: ClientState;
  resultingState: ClientState;
}): CommitIntegrityViolation | undefined {
  const parentSupport = getGroupProfileSupport(
    args.parentState.groupContext.extensions,
  );
  if (parentSupport.kind === "unsupported") {
    return {
      reason: "account-identity-proof",
      detail: `parent GroupContext is outside the current account identity proof profile (${parentSupport.proofReason})`,
      proofReason: parentSupport.proofReason,
    };
  }

  const resultingSupport = getGroupProfileSupport(
    args.resultingState.groupContext.extensions,
  );
  if (resultingSupport.kind === "unsupported") {
    return {
      reason: "account-identity-proof",
      detail: `resulting GroupContext is outside the current account identity proof profile (${resultingSupport.proofReason})`,
      proofReason: resultingSupport.proofReason,
    };
  }

  const changedLeaves = diffChangedLeaves(
    args.parentState.ratchetTree,
    args.resultingState.ratchetTree,
  );
  for (const { leafIndex, leaf } of changedLeaves) {
    try {
      validateLeafAccountIdentityProof(
        leaf,
        args.resultingState.groupContext.cipherSuite,
      );
    } catch (err) {
      if (err instanceof AccountIdentityProofError) {
        return {
          reason: "account-identity-proof",
          detail: `member leaf ${leafIndex} account identity proof invalid (${err.reason})`,
          proofReason: err.reason,
          leafIndex,
        };
      }
      return {
        reason: "account-identity-proof",
        detail: `member leaf ${leafIndex} account identity proof validation failed`,
        leafIndex,
      };
    }
  }

  return undefined;
}

/**
 * Ported from `validate_standalone_proposal_account_identity_proof` (Add
 * branch; D-08/D-09): validates the `0x8009` proof of every Add proposal's
 * `KeyPackage` against `ciphersuite`, pure and non-throwing. Used pre-apply by
 * the standalone-proposal admission seams (`src/engine/admin-policy.ts`
 * inbound, `src/engine/group-engine.ts` local propose path) so a bad Add
 * never reaches the queued-proposal state in the first place — the commit-time
 * tree diff in {@link validateCommitAccountIdentityProofs} still catches it
 * after apply if either admission gate is bypassed, since both call the same
 * underlying {@link validateKeyPackageAccountIdentityProof}.
 *
 * Accepts both bare `Proposal` and `ProposalWithSender` items (normalizes
 * each first) and ignores every non-Add proposal kind. Returns on the first
 * failing Add; `leafIndex` is always omitted (the KeyPackage has no tree
 * position yet, pre-apply).
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_membership_proposal`
 */
export function validateAddProposalAccountIdentityProofs(
  proposals: readonly (Proposal | ProposalWithSender)[],
  ciphersuite: number,
): CommitIntegrityViolation | undefined {
  const normalized = proposals.map((item) =>
    "proposal" in item ? item.proposal : item,
  );
  for (let position = 0; position < normalized.length; position++) {
    const proposal = normalized[position]!;
    if (proposal.proposalType !== defaultProposalTypes.add) continue;
    if (!("add" in proposal)) continue;
    try {
      validateKeyPackageAccountIdentityProof(
        proposal.add.keyPackage,
        ciphersuite,
      );
    } catch (err) {
      if (err instanceof AccountIdentityProofError) {
        return {
          reason: "account-identity-proof",
          detail: `Add proposal ${position} KeyPackage account identity proof invalid (${err.reason})`,
          proofReason: err.reason,
        };
      }
      return {
        reason: "account-identity-proof",
        detail: `Add proposal ${position} KeyPackage account identity proof validation failed`,
      };
    }
  }
  return undefined;
}

/**
 * The single shared seam adapter for commit legality: derives every argument
 * {@link validateAppComponentIntegrity}, {@link validateCommitAccountIdentityProofs},
 * {@link classifyDisbandCommit}, and {@link validateAdminLeafCoupling} need
 * from `parentState`/`resultingState`/`proposals`, so no seam re-derives them
 * independently (the mdk#707 bug class — "a guard that exists on one seam
 * only is a documented bug").
 *
 * Runs four checks, in this fixed order (D-07):
 * 1. `validateAppComponentIntegrity` — component-integrity (WIRE-03).
 * 2. `validateCommitAccountIdentityProofs` — account-identity-proof profile
 *    drift and changed-leaf proof validity (D-01/D-02/D-03). Runs before
 *    disband/admin-leaf-coupling reasoning, so an invalid identity blocks a
 *    commit before any admin-set reasoning does. `0x8009` data appearing in
 *    the GroupContext dictionary itself still reports `component-integrity`
 *    (rejected earlier by step 1), so Phase 7 expectations hold.
 * 3. `classifyDisbandCommit` — disband-legality.
 * 4. `validateAdminLeafCoupling` — admin-leaf-coupling (CONV-01).
 *
 * Stays pure: reads two `ClientState` values, performs no I/O, and calls
 * nothing from `src/engine` or `src/client`.
 *
 * Each calling seam supplies its own disposition for a returned violation:
 * throw on send (D-02), `rejected` with the violation's `reason` on inbound
 * (D-03), or drop the candidate edge on convergence/replay (D-04/D-09). This
 * adapter itself is seam-agnostic.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_staged_commit_account_identity_proofs`
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Validation"
 */
export function validateCommitLegality(args: {
  parentState: ClientState;
  resultingState: ClientState;
  proposals: readonly (Proposal | ProposalWithSender)[];
  committerLeafIndex?: number;
}): CommitIntegrityViolation | undefined {
  const proposalsWithSenders: ProposalWithSender[] = args.proposals.map(
    (item) =>
      "proposal" in item
        ? item
        : { proposal: item, senderLeafIndex: undefined },
  );
  const proposals = proposalsWithSenders.map(({ proposal }) => proposal);
  const appDataUpdateOps = collectAppDataUpdateOps(proposals);

  // The `app_components` (0x0001) bytes are attacker-influenceable: an admin
  // can land an AppDataUpdate writing arbitrary bytes to that id (Rule 3
  // accepts it because the change IS backed by that commit's own op, and
  // Rule 2 only checks presence, never decodability). From the next commit
  // onward every seam decodes those bytes here, and `decodeComponentsList`
  // throws on malformed input or a duplicate id. Honour this adapter's
  // documented non-throwing contract (D-01/D-02) by converting that into a
  // typed violation — otherwise the throw escapes the convergence/replay
  // seams (`fork-recovery.ts`, `group-engine.ts` tree re-convergence), which
  // do not wrap this call, and aborts the ingest generator before the caller
  // can persist state.
  let requiredIds: readonly AppComponentId[];
  try {
    requiredIds =
      getAppComponents(args.parentState.groupContext.extensions) ?? [];
  } catch {
    return {
      reason: "component-integrity",
      detail: "current app_components component did not decode",
    };
  }

  const integrityViolation = validateAppComponentIntegrity({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    appDataUpdateOps,
    requiredIds,
  });
  if (integrityViolation) return integrityViolation;

  const accountIdentityProofViolation = validateCommitAccountIdentityProofs({
    parentState: args.parentState,
    resultingState: args.resultingState,
  });
  if (accountIdentityProofViolation) return accountIdentityProofViolation;

  const disband: DisbandClassification = classifyDisbandCommit({
    parentState: args.parentState,
    resultingState: args.resultingState,
    proposals: proposalsWithSenders,
    committerLeafIndex: args.committerLeafIndex,
  });
  if (disband.kind === "violation")
    return { reason: "disband-legality", detail: disband.detail };

  const resultingMemberAccounts = getGroupMemberPubkeys(args.resultingState);

  return validateAdminLeafCoupling({
    currentExtensions: args.parentState.groupContext.extensions,
    resultingExtensions: args.resultingState.groupContext.extensions,
    resultingMemberAccounts,
  });
}
