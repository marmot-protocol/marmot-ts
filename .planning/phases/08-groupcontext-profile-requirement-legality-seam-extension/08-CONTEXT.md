# Phase 8: GroupContext Profile Requirement & Legality-Seam Extension - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Enforce that every group requires `0x8009` in its GroupContext `app_components` required list, and that the
requirement plus valid per-leaf `0x8009` proofs hold identically on every legality seam: send, inbound ingest,
pool-replay/fork-recovery, and tree-fed convergence. Enforcement is centralized in the shared `validateCommitLegality`
adapter (`src/core/components/integrity.ts`) first, then closed at the seam-local points that cannot be centralized:
admin-policy callback, standalone Add admission, and the invite path. It also defines what happens to stored groups
that are outside the current profile.

Covers GRP-01..04.

**Already landed in Phase 7 (do not redo; add tests only where noted):**
- GRP-01 creation side: `DEFAULT_GROUP_COMPONENT_IDS` requires `0x8009`, and `0xf2f1` is gone from required
  capabilities (07 D-05). `validateAppComponentIntegrity` already rejects `0x8009` GroupContext data or
  `AppDataUpdate` ops. Phase 8 owns the GRP-01 tests.
- GRP-03 join: `groups-manager.ts` join calls `assertCurrentGroupAccountIdentityProofProfile` and
  `validateGroupMemberAccountIdentityProofs` before `adoptClientState` (07 D-07). Phase 8 owns the GRP-03 tests.
- The invite seam: `proposeInviteUser` validates the invitee KeyPackage with its own ciphersuite.

**Not in this phase:**
- Identity equality between a replacement leaf and the member's prior leaf, and standalone Update admission (Phase 9,
  UPD-01..04).
- Founding create via Welcome (Phase 10).
- The full QA-F1 parity matrix, Rust-signed fixtures, and the exports snapshot gate (Phase 11 / future).

</domain>

<decisions>
## Implementation Decisions

### Which leaves the commit-legality check verifies
- **D-01:** Delta validation, matching MDK `validate_staged_commit_account_identity_proofs`. `validateCommitLegality`
  runs two checks:
  - (a) Profile check: parent and resulting GroupContext must both classify as the current profile, and the profile
    must not change. Reuse `classifyGroupAccountIdentityProofProfile`. A commit that drops the `0x8009` requirement,
    or adds `0xf2f1`, fails.
  - (b) Changed-leaf check: validate the `0x8009` proof of every changed leaf against the group ciphersuite.
  - Unchanged leaves are trusted: they were validated at join or when they last changed. Do not re-verify the whole
    tree on every commit.
- **D-02:** Find changed leaves with a **tree diff**, not a proposal walk. Compare the parent and resulting ratchet
  trees and validate every non-blank leaf that is new or byte-different. This covers Adds, Update proposals, and the
  committer's update-path leaf without relying on ts-mls exposing them. ts-mls has no `StagedCommit`, and both states
  are already present at every seam. Blanked leaves (removals) are not validated.
- **D-03:** For Update-proposal and update-path leaves, Phase 8 checks **proof validity only**:
  - support and data present,
  - signer equals the leaf's `BasicCredential` identity,
  - ciphersuite and scheme match,
  - the signed MLS signature key equals the leaf's key,
  - the signature verifies.

  Identity equality with the member's prior leaf stays Phase 9 (UPD-01..03).
- **D-04:** Seam-parity tests are a **targeted GRP-02 matrix**, not full QA-F1. One test file runs the same invalid
  commits through send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence, and asserts the identical
  `account-identity-proof` violation (reason plus `proofReason`) on each:
  - a commit that drops the `0x8009` requirement,
  - an Add whose leaf has no proof,
  - an update-path leaf with an invalid proof.

  Model it on `src/engine/__tests__/commit-legality-seams.test.ts`. The research notes flag this phase for a planned
  review-fix cycle.

### Rejection surface
- **D-05:** Add one new `CommitIntegrityViolationReason`, `"account-identity-proof"`, covering both profile drift and
  invalid changed leaves. Propagate it to every union that mirrors the reason: the `RejectedIngestResult.reason`
  inline union in `src/engine/types.ts`, session ingest types, and audit reason normalization
  (`account_identity_proof`).
- **D-06:** `CommitIntegrityViolation` gains optional typed fields:
  - `proofReason?: AccountIdentityProofRejectReason`, taken from the caught `AccountIdentityProofError.reason`,
  - `leafIndex?: number`, the failing leaf; omitted for profile failures.

  Both are pubkey-free, which satisfies the `foundation/errors.md` diagnostics-privacy rule. `detail` stays
  pubkey-free. The adapter keeps its non-throwing contract: catch validator throws and map them to the violation.
- **D-07:** Order inside `validateCommitLegality`: component-integrity → **profile/proof** → disband-legality →
  admin-leaf coupling. `0x8009` data in the GroupContext keeps reporting `component-integrity`, so Phase 7
  expectations hold. An invalid identity blocks before any admin-set reasoning.

### Standalone proposal admission
- **D-08:** Close the Phase 7 D-06 gap in `createAdminCommitPolicyCallback` by removing the "no proof material → skip"
  branch. Every Add in a commit is validated before apply with `validateKeyPackageAccountIdentityProof`, the same core
  validator. The adapter's tree diff (D-02) still catches it after apply. Both points call the same core function, so
  there is one implementation reached from two points. Update the named test that pins the gap
  (`group-engine.test.ts` "D-06 known gap") and the `marmot-group.test.ts:761` comment.
- **D-09:** Validate standalone **Add** proposals before they are queued, on both sides:
  - Inbound: the callback validates Adds when `incoming.kind === "proposal"` instead of blanket-accepting. A rejected
    proposal surfaces as `rejected` with reason `account-identity-proof`, matching the D-05 surface.
  - Local: the engine's propose/send proposal path validates any Add, so a hand-built `ProposalAction` returning a raw
    Add cannot bypass `proposeInviteUser`'s check.
- **D-10:** Standalone **Update** proposal admission is deferred entirely to Phase 9 (UPD-04). A bad Update leaf is
  still caught at commit time by D-02 and D-03.

### Stored groups outside the profile
- **D-11:** A stored group whose GroupContext does not classify as current (requires `0xf2f1`, is mixed, or does not
  require `0x8009`) **loads**. It stays listable, displayable, and `destroy()`-able, but it is marked with a typed
  unsupported-profile flag. **All traffic is refused:**
  - every outbound send (application messages, proposals, commits),
  - every inbound envelope, including application messages.

  Each refusal is a typed error or result. It must not throw inside `loadAll`, and one bad record must not break loading
  the others. This supersedes Phase 7 D-10 ("load untouched").
- **D-12:** No automatic cleanup. Nothing is deleted and nothing is published, consistent with Phase 7 D-09 for
  KeyPackages. Add a line to the Phase 7 migration docs telling apps to call `destroy()` on unsupported groups.

### Claude's Discretion
- Exact names: the unsupported-profile flag/state (a field on `MarmotGroup`, or a lifecycle/load outcome), the typed
  refusal error or result, and any tree-diff helper.
- Where the tree-diff helper lives. It must be pure `src/core`, reachable from `validateCommitLegality`.
- Whether the D-11 traffic refusal is enforced at `GroupSession`, the engine, or both. It must cover inbound and
  outbound uniformly; prefer a single gate modeled on the existing disband/removed gates.
- Exact test fixture construction for the parity matrix, including how to forge an invalid update-path leaf.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (normative)
- `refs/marmot/app-components/account-identity-proof-v2.md`: negotiation and presence, the GroupContext required list,
  valid/invalid locations, the validation list, lifecycle/removal ("not GroupContext state"), and migration from v1
  (a legacy group is outside the profile).
- `refs/marmot/app-components/README.md`: the LeafNode `app_components` support list vs the GroupContext required
  list, and update processing.
- `refs/marmot/protocol-core/group-setup.md`: required components at group creation (GRP-01).
- `refs/marmot/protocol-core/joining.md`: Welcome join validation (GRP-03).
- `refs/marmot/protocol-core/group-messaging.md`: admin-only commits and proposal admission (GRP-04).
- `refs/marmot/foundation/errors.md`: diagnostics-privacy rule (D-06).

### Rust reference
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`:
  - `validate_staged_commit_account_identity_proofs`, the model for D-01/D-03.
  - `validate_standalone_proposal_account_identity_proof`: Add branch now, Update branch in Phase 9.
  - `protocol_profile_of_group_extensions`.
- `refs/mdk/crates/cgka-engine/src/app_components.rs`: `validate_membership_proposal`, the standalone admission seam.
- `refs/mdk/crates/cgka-engine/src/message_processor/ingest.rs` (~L1401) and `message_processor/send.rs` (~L309,
  ~L618): where MDK calls the staged-commit check on each seam.
- Upstream check (2026-09-15): `refs/marmot` has no new commits. `refs/mdk` is 3 commits ahead (`1c94c944`,
  `a9c2527c`, `ebb6cf96`: terminal harness, removed-copy ingest before hydration, sqlite timeline). None touch proof
  or legality code. Bump in a separate `chore(refs):` commit at plan start.

### Prior phases
- `.planning/phases/07-account-identity-proof-component-0x8009-legacy-clean-cut/07-CONTEXT.md`: D-05/D-06/D-07/D-10
  (the boundary this phase closes), D-13/D-14 (throw model, reasons).
- `.planning/phases/07-account-identity-proof-component-0x8009-legacy-clean-cut/07-REVIEW-FIX.md`: WR-01 admin-policy
  Add gate fix.
- `.planning/phases/06-shared-authorization-proof-envelope-primitive/06-CONTEXT.md`: envelope primitive and error
  model.

### Planning / research
- `.planning/REQUIREMENTS.md`: GRP-01..04 (and UPD-01..04 for the boundary).
- `.planning/research/SUMMARY.md` §"Phase 8" and "Gaps to Address": centralize in `validateCommitLegality`, the
  leaf-only carve-out, and the open question on standalone Update admission (resolved: D-10).
- `.planning/research/PITFALLS.md`: Pitfall 9 (`0x8009` leaking into GroupContext), Pitfall 11 (seam asymmetry,
  mdk#707).
- `.planning/research/ARCHITECTURE.md`: seam map.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/components/account-identity-proof.ts`:
  - `validateLeafAccountIdentityProof(leaf, ciphersuite)`: single leaf; D-02 feeds changed leaves here.
  - `validateKeyPackageAccountIdentityProof`: Add admission, D-08/D-09.
  - `validateGroupMemberAccountIdentityProofs`: whole tree; join only.
  - `classifyGroupAccountIdentityProofProfile` / `assertCurrentGroupAccountIdentityProofProfile`: D-01a and D-11.
  - `hasAccountIdentityProofMaterial`: its skip use goes away (D-08).
  - `AccountIdentityProofError` / `AccountIdentityProofRejectReason`: D-06.
- `src/core/components/integrity.ts`:
  - `validateCommitLegality`: the single shared adapter, extended per D-01/D-05/D-07.
  - `CommitIntegrityViolation` / `CommitIntegrityViolationReason`: extended per D-05/D-06.
- `src/core/group-members.ts` `getGroupMemberPubkeys`: the pattern for pure ClientState tree reads.

### Established Patterns
- The adapter is **non-throwing**. The `getAppComponents` try/catch → typed violation is the precedent for wrapping
  throwing validators, because fork-recovery and tree re-convergence do not wrap the call.
- Seam dispositions are fixed per seam:
  - send throws `CommitLegalityError` (`group-engine.ts` `#assertStagedCommitLegal`),
  - inbound yields `rejected` (`ingest.ts` ~L730),
  - replay drops the edge (`fork-recovery.ts` ~L125),
  - tree-fed convergence fails closed (`group-engine.ts` `#treeResolution` ~L2863).
- `withCapturedProposals`: no validation logic may go inside the wrapper (Pitfall 1). The admin callback's own proof
  checks are the pre-apply exception and already exist.
- The disband and removed-state gates, repeated at routing, session, and engine (Phase 04.1-06), are the precedent for
  D-11's all-traffic refusal.
- Reasons are literal unions; audit reasons are normalized to underscores (Phase 03.1-07).

### Integration Points
- `src/core/components/integrity.ts`: the D-01/D-02/D-05/D-06/D-07 core change, reaching all four seams.
- `src/engine/admin-policy.ts`: D-08 (remove the skip) and D-09 (proposal-kind Add validation).
- `src/engine/group-engine.ts`: local propose path Add validation (D-09), `#assertStagedCommitLegal`,
  `#treeResolution`.
- `src/engine/ingest.ts`, `src/engine/fork-recovery.ts`: consume the new reason; confirm the dispositions.
- `src/engine/types.ts`, `src/client/session/*`, `src/audit/*`: reason union propagation (D-05).
- `src/client/group-registry.ts` / `MarmotGroup.fromClientState` / `GroupsManager.loadAll`: D-11 classify-on-load and
  the flag.
- `src/client/session/group-session.ts`: likely the D-11 traffic gate.
- Tests:
  - `src/core/components/__tests__/integrity.test.ts`,
  - `src/engine/__tests__/commit-legality-seams.test.ts`, `send-commit-legality.test.ts`,
  - `src/engine/__tests__/group-engine.test.ts` (D-06 gap test),
  - `src/client/group/__tests__/marmot-group.test.ts`,
  - a new GRP-02 parity file (D-04),
  - GRP-01 creation and GRP-03 join tests.
- Docs: the Phase 7 migration section (D-12).

</code_context>

<specifics>
## Specific Ideas

- The parity matrix asserts the **identical structured violation** on every seam: reason `account-identity-proof` plus
  the same `proofReason`. "Rejected somewhere" is not enough.
- GRP-01 test: a created group's GroupContext `app_components` required list includes `0x8009`, and its
  `app_data_dictionary` has no `0x8009` entry.
- GRP-03 tests:
  - a Welcome into a group that does not require `0x8009` fails before anything is persisted,
  - a Welcome where one current member's proof is invalid fails the same way.
- GRP-04 tests:
  - `proposeInviteUser` with a proof-less or forged KeyPackage throws before proposing,
  - a raw Add `ProposalAction` is refused by the engine,
  - an inbound standalone Add with a bad proof is `rejected`, not queued.

</specifics>

<deferred>
## Deferred Ideas

- Standalone Update proposal admission proof and identity check → Phase 9 (UPD-04).
- Identity equality of Update/update-path leaves against the prior member leaf → Phase 9 (UPD-01..03).
- Full per-seam QA-F1 matrix (duplicate, mixed `0xf2f1`+`0x8009`, wrong ciphersuite, identity change, Welcome join) →
  future / Phase 11.
- A helper to list or purge unsupported-profile stored groups was considered and not taken (D-12); apps call
  `destroy()`.

</deferred>

---

*Phase: 08-groupcontext-profile-requirement-legality-seam-extension*
*Context gathered: 2026-09-15*
