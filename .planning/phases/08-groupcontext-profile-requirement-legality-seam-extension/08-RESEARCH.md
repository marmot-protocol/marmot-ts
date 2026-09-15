# Phase 8: GroupContext Profile Requirement & Legality-Seam Extension - Research

**Researched:** 2026-09-15
**Domain:** Internal protocol/crypto legality gates (MLS commit validation, app-component profile
enforcement) — no new external dependencies. This is a codebase-internal research pass: every
finding below is grounded in `src/`, `ts-mls/src/`, and `refs/mdk` file:line citations, not
external library docs.
**Confidence:** HIGH (all load-bearing claims are directly read from source, not inferred)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Which leaves the commit-legality check verifies**
- **D-01:** Delta validation, matching MDK `validate_staged_commit_account_identity_proofs`.
  `validateCommitLegality` runs two checks: (a) Profile check — parent and resulting GroupContext
  must both classify as the current profile, and the profile must not change (reuse
  `classifyGroupAccountIdentityProofProfile`; a commit dropping the `0x8009` requirement or adding
  `0xf2f1` fails); (b) Changed-leaf check — validate the `0x8009` proof of every changed leaf
  against the group ciphersuite. Unchanged leaves are trusted (validated at join or when they last
  changed) — do not re-verify the whole tree on every commit.
- **D-02:** Find changed leaves with a **tree diff**, not a proposal walk. Compare the parent and
  resulting ratchet trees and validate every non-blank leaf that is new or byte-different. Covers
  Adds, Update proposals, and the committer's update-path leaf without relying on ts-mls exposing
  them (ts-mls has no `StagedCommit`; both states are already present at every seam). Blanked
  leaves (removals) are not validated.
- **D-03:** For Update-proposal and update-path leaves, Phase 8 checks **proof validity only**:
  support and data present, signer equals the leaf's `BasicCredential` identity, ciphersuite and
  scheme match, the signed MLS signature key equals the leaf's key, the signature verifies.
  Identity equality with the member's prior leaf stays Phase 9 (UPD-01..03).
- **D-04:** Seam-parity tests are a **targeted GRP-02 matrix**, not full QA-F1. One test file runs
  the same invalid commits through send, inbound ingest, fork-recovery/pool replay, and tree-fed
  convergence, and asserts the identical `account-identity-proof` violation (reason plus
  `proofReason`) on each: a commit that drops the `0x8009` requirement; an Add whose leaf has no
  proof; an update-path leaf with an invalid proof. Model it on
  `src/engine/__tests__/commit-legality-seams.test.ts`. Flagged for a planned review-fix cycle.

**Rejection surface**
- **D-05:** Add one new `CommitIntegrityViolationReason`, `"account-identity-proof"`, covering both
  profile drift and invalid changed leaves. Propagate to every union that mirrors the reason: the
  `RejectedIngestResult.reason` inline union in `src/engine/types.ts`, session ingest types, and
  audit reason normalization (`account_identity_proof`).
- **D-06:** `CommitIntegrityViolation` gains optional typed fields: `proofReason?:
  AccountIdentityProofRejectReason` (from the caught `AccountIdentityProofError.reason`),
  `leafIndex?: number` (the failing leaf; omitted for profile failures). Both pubkey-free
  (diagnostics-privacy rule). `detail` stays pubkey-free. The adapter keeps its non-throwing
  contract.
- **D-07:** Order inside `validateCommitLegality`: component-integrity → **profile/proof** →
  disband-legality → admin-leaf coupling. `0x8009` data in the GroupContext keeps reporting
  `component-integrity` (Phase 7 expectations hold). An invalid identity blocks before any
  admin-set reasoning.

**Standalone proposal admission**
- **D-08:** Close the Phase 7 D-06 gap in `createAdminCommitPolicyCallback` by removing the "no
  proof material → skip" branch. Every Add in a commit is validated before apply with
  `validateKeyPackageAccountIdentityProof`, the same core validator. The adapter's tree diff (D-02)
  still catches it after apply — one implementation reached from two points. Update the named test
  that pins the gap (`group-engine.test.ts` "D-06 known gap") and the `marmot-group.test.ts:761`
  comment.
- **D-09:** Validate standalone **Add** proposals before they are queued, on both sides: Inbound —
  the callback validates Adds when `incoming.kind === "proposal"` instead of blanket-accepting; a
  rejected proposal surfaces as `rejected` with reason `account-identity-proof`. Local — the
  engine's propose/send proposal path validates any Add, so a hand-built proposal cannot bypass
  `proposeInviteUser`'s check.
- **D-10:** Standalone **Update** proposal admission is deferred entirely to Phase 9 (UPD-04). A
  bad Update leaf is still caught at commit time by D-02 and D-03.

**Stored groups outside the profile**
- **D-11:** A stored group whose GroupContext does not classify as current (requires `0xf2f1`, is
  mixed, or does not require `0x8009`) **loads**. It stays listable, displayable, and
  `destroy()`-able, but is marked with a typed unsupported-profile flag. **All traffic is
  refused:** every outbound send (application messages, proposals, commits), every inbound
  envelope, including application messages. Each refusal is a typed error or result. Must not throw
  inside `loadAll`; one bad record must not break loading the others. Supersedes Phase 7 D-10
  ("load untouched").
- **D-12:** No automatic cleanup. Nothing is deleted and nothing is published, consistent with
  Phase 7 D-09 for KeyPackages. Add a line to the Phase 7 migration docs telling apps to call
  `destroy()` on unsupported groups.

### Claude's Discretion
- Exact names: the unsupported-profile flag/state (a field on `MarmotGroup`, or a
  lifecycle/load outcome), the typed refusal error or result, and any tree-diff helper.
- Where the tree-diff helper lives. It must be pure `src/core`, reachable from
  `validateCommitLegality`.
- Whether the D-11 traffic refusal is enforced at `GroupSession`, the engine, or both. It must
  cover inbound and outbound uniformly; prefer a single gate modeled on the existing
  disband/removed gates.
- Exact test fixture construction for the parity matrix, including how to forge an invalid
  update-path leaf.

### Deferred Ideas (OUT OF SCOPE)
- Standalone Update proposal admission proof and identity check → Phase 9 (UPD-04).
- Identity equality of Update/update-path leaves against the prior member leaf → Phase 9
  (UPD-01..03).
- Full per-seam QA-F1 matrix (duplicate, mixed `0xf2f1`+`0x8009`, wrong ciphersuite, identity
  change, Welcome join) → future / Phase 11.
- A helper to list or purge unsupported-profile stored groups was considered and not taken
  (D-12); apps call `destroy()`.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| GRP-01 | A newly created group requires `0x8009` in its GroupContext `app_components` required-component list and holds no GroupContext state for it | Already landed Phase 7 (`DEFAULT_GROUP_COMPONENT_IDS`, `src/core/components/ids.ts:74-79`); this phase adds the test. See "GRP-01 test construction" below. |
| GRP-02 | A commit whose resulting epoch drops the `0x8009` requirement or contains a member leaf without valid `0x8009` support/proof is rejected identically on send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence | See "The three `validateCommitLegality` call sites" and "D-02 tree-diff design" below — confirms tree-fed convergence reuses the SAME call site as fork-recovery, and documents exactly how to forge each of the three D-04 matrix fixtures per seam. |
| GRP-03 | Joining via Welcome fails when the group does not require `0x8009` or any current member lacks a valid proof | Already landed Phase 7 (`src/client/groups-manager.ts:720-726`); this phase adds the test. |
| GRP-04 | Inviting a user and admin-policy admission of a standalone Add proposal validate the invitee's `0x8009` proof before it is proposed or queued | Invite side already landed (`proposeInviteUser`, `src/client/group/proposals/invite-user.ts:10-28`). Admin-policy standalone-Add gap and local propose-path gap documented in "D-08/D-09 exact insertion points" below. |
</phase_requirements>

## Summary

This phase closes a well-understood seam-asymmetry gap (the "mdk#707 pattern") in an already
mostly-built validation pipeline. Phase 7 built every primitive Phase 8 needs
(`validateLeafAccountIdentityProof`, `validateKeyPackageAccountIdentityProof`,
`classifyGroupAccountIdentityProofProfile`, `assertCurrentGroupAccountIdentityProofProfile`,
`validateGroupMemberAccountIdentityProofs` — all in
`src/core/components/account-identity-proof.ts`) and wired GRP-01 (creation) and GRP-03 (join)
already. What remains is: (1) extend the single shared adapter `validateCommitLegality`
(`src/core/components/integrity.ts`) with a profile-and-changed-leaf check reachable from every
commit-processing seam; (2) close two known standalone-Add gaps (admin-policy callback,
engine local-proposal send path); (3) add a load-time classification gate that marks — but does
not reject loading — a stored group outside the current profile, and refuses all its traffic.

The most consequential finding: **there are only three call sites of `validateCommitLegality`in
the whole engine**, not four. `MarmotGroupEngine.#treeResolution` (tree-fed convergence) does not
call `validateCommitLegality` directly — it calls `resolveCandidateParent`
(`src/engine/fork-recovery.ts:83-137`), the SAME function `fork-recovery.ts`'s
pool-replay/candidate-branch builder calls at line 125. So "four seams" in the phase description
means four *dispositions* (throw / `rejected` / drop-edge / fail-closed-abandon-switch) built on
top of three *call sites* (send: `group-engine.ts:1285-1298`; inbound:
`ingest.ts:730-752`; replay+tree-fed: `fork-recovery.ts:103-137`, shared). This directly answers
research_focus item 1 ("confirm both states are actually available at all four seams") — they are,
because three of the four dispositions are literally the same code path.

The second most consequential finding: **the committer's own update-path leaf always carries
forward its previous `extensions` byte-for-byte unchanged** (`ts-mls/src/updatePath.ts:105-115`,
`originalLeafNode.leaf.extensions`). There is no public ts-mls API to inject different extensions
into a self-update. This means an "update-path leaf with an invalid proof" (the hard D-04 fixture)
can only be constructed by getting an already-invalid leaf into the tree first (via a raw,
non-engine `createCommit` Add using ts-mls's public `generateKeyPackageWithKey` with tampered
`leafNodeExtensions` — bypassing the engine's own gates the same way the existing
`fourPartyEpoch1Group()` test helper already does), then having that member self-update. The
self-update's fresh signature makes the leaf byte-different from its parent (new `hpkePublicKey`,
new `signature`) even though the forged proof content itself never changes — which is exactly what
the D-02 tree-diff needs to catch it as "changed."

**Primary recommendation:** Implement the tree-diff as a pure `src/core` structural comparison
using `leaf.signature` byte-inequality as the "changed" test (not a hand-rolled TLS re-encoding —
`ts-mls`'s `leafNodeEncoder`/`leafNodeEqual` are not exported from its package root, and
`leafNodeEqual` itself only compares `signaturePublicKey`, which is insufficient). Insert the new
profile/proof check into `validateCommitLegality` between the existing component-integrity check
and the disband check (per D-07's mandated order). Add the D-11 gate as a single check at the very
top of `MarmotGroupEngine.send()` (`group-engine.ts:806-819`, alongside the existing
disband/removed checks) and a single check at the very top of `ingestEnvelopes`
(`ingest.ts:344-371`, same pattern) — both are already the established single choke points for
every outbound/inbound kind, so no additional per-method repetition is needed.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Commit legality (profile + changed-leaf proof) | Core (`src/core/components/integrity.ts`) | Engine (three call sites) | Pure, seam-agnostic validator; every engine seam calls the same function so no seam can drift (the mdk#707 defense). |
| Tree-diff (changed-leaf detection) | Core (`src/core/`, new pure module) | — | Must be pure/MLS-free like its sibling validators in `integrity.ts`; reads two `ClientState.ratchetTree` values only. |
| Standalone Add proposal admission (inbound) | Engine (`src/engine/admin-policy.ts`) | — | `createAdminCommitPolicyCallback` is the sole inbound admission gate for standalone proposals; already validates commit-embedded Adds, needs the same for the `incoming.kind === "proposal"` branch. |
| Standalone Add proposal admission (outbound/local) | Engine (`src/engine/group-engine.ts` `case "proposal"`) | Client (`proposeInviteUser`) | `proposeInviteUser` is one `ProposalAction` factory; a caller can still hand-build a raw `Proposal` and call `engine.send({kind:"proposal", ...})`, bypassing it entirely — the engine's own send path is the only funnel that cannot be bypassed. |
| Unsupported-profile classification (on load) | Client (`src/client/group-registry.ts` / `MarmotGroup.fromClientState`) | — | Classification must be non-throwing at load time (Promise.all in `loadAll()` — see Pitfall 1) and exposed as a queryable flag, mirroring the existing `status` getter pattern. |
| Unsupported-profile traffic refusal (outbound) | Engine (`MarmotGroupEngine.send()`) | — | Single existing choke point for every outbound intent kind; same place the disband/removed gates already live. |
| Unsupported-profile traffic refusal (inbound) | Engine (`ingestEnvelopes`) | — | Single existing choke point for every inbound envelope; same place the disband/removed gates already live. |
| Reason-union propagation | Engine (`src/engine/types.ts`) | Client (auto-derived) | `src/client/session/group-session.ts`'s `SessionIngestResult` is a distributive mapped type over the engine union (per prior decision log), so adding the reason to `types.ts` alone is sufficient — no separate client-side edit needed. |

## Standard Stack

No new external dependencies. This phase is entirely internal logic built on already-present
libraries:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ts-mls` (local fork) | 2.0.0-rc.14 | `ClientState`, `generateKeyPackageWithKey`, `createCommit`, `processMessage` — all already used throughout `src/engine`/`src/core` | Existing project dependency; no version change needed for this phase. |
| `@noble/hashes` | ^2.2.0 | `bytesToHex` for tag/digest formatting in any new test fixtures | Existing project dependency. |

**Installation:** none required.

## Package Legitimacy Audit

Not applicable — this phase installs no new external packages. All work is internal to `src/core`
and `src/engine`, built on dependencies already declared in `package.json`.

## Architecture Patterns

### System Architecture Diagram: the three `validateCommitLegality` call sites

```
                    ┌─────────────────────────────┐
                    │   validateCommitLegality      │   src/core/components/integrity.ts:312-373
                    │   (pure, non-throwing,        │   NEW: profile/proof check inserted here,
                    │    src/core, MLS-free)        │   between component-integrity and disband
                    └───────────────┬───────────────┘
                                    │ called from
        ┌───────────────────────────┼───────────────────────────────┐
        │                           │                                │
        ▼                           ▼                                ▼
┌───────────────┐         ┌──────────────────┐          ┌────────────────────────┐
│ SEND           │         │ INBOUND INGEST    │          │ resolveCandidateParent  │
│ group-engine.ts│         │ ingest.ts:730-752 │          │ fork-recovery.ts:83-137 │
│ #assertStaged  │         │                    │          │ (SHARED by two callers) │
│ CommitLegal    │         │ disposition:       │          └────────────┬────────────┘
│ (:1285-1298)   │         │ yield "rejected"   │                       │
│                │         │ with reason        │          ┌────────────┴────────────┐
│ disposition:   │         └────────────────────┘          │                         │
│ throw          │                                          ▼                         ▼
│ CommitLegality │                                ┌──────────────────┐    ┌────────────────────┐
│ Error          │                                │ POOL-REPLAY /      │    │ TREE-FED            │
└────────────────┘                                │ FORK-RECOVERY      │    │ CONVERGENCE          │
                                                    │ (candidate branch  │    │ group-engine.ts      │
                                                    │  builder, explore) │    │ #treeResolution       │
                                                    │                    │    │ (:2842-2929) calls    │
                                                    │ disposition:       │    │ resolveCandidateParent│
                                                    │ drop candidate     │    │ per chain link         │
                                                    │ edge (never        │    │                        │
                                                    │ recorded in tree)  │    │ disposition: abandon   │
                                                    └────────────────────┘    │ the whole switch,      │
                                                                               │ tip stays where it was │
                                                                               └────────────────────────┘
```

**Why this matters for D-04's parity matrix:** the pool-replay and tree-fed dispositions share one
implementation (`resolveCandidateParent`), so a bug fixed there is automatically fixed on both —
but a parity TEST still needs to separately exercise both, because they reach that function through
different *callers* (`#buildBranches`/`explore()` vs `#treeResolution`) with different persisted
state (a fresh candidate vs. a tree edge already recorded from a "pre-upgrade build," per the
existing `#treeResolution` docstring at `group-engine.ts:2825-2841`).

### Recommended Project Structure

No new directories. New code lands in existing files:

```
src/core/
├── components/
│   ├── integrity.ts          # D-01/D-05/D-06/D-07: extend validateCommitLegality
│   ├── account-identity-proof.ts  # unchanged — reuse validateLeafAccountIdentityProof,
│   │                                classifyGroupAccountIdentityProofProfile
│   └── (new) tree-diff.ts    # D-02: pure changed-leaf detection over two ClientState trees
│                                (Claude's discretion on filename/location within src/core)
src/engine/
├── admin-policy.ts           # D-08 (remove skip branch), D-09 (proposal-kind Add validation)
├── group-engine.ts           # D-09 (local "proposal" send-path Add validation),
│                                D-11 (single outbound gate at send())
├── ingest.ts                 # D-11 (single inbound gate at ingestEnvelopes top), consumes
│                                new "account-identity-proof" reason
├── fork-recovery.ts          # consumes new reason via validateCommitLegality (no seam-local change)
├── types.ts                  # D-05: add "account-identity-proof" to RejectedIngestResult.reason;
│                                D-11: add new SkippedIngestResult reason for unsupported-profile
src/client/
├── group-registry.ts         # D-11: classify-on-load (non-throwing)
├── group/marmot-group.ts     # D-11: expose the typed flag (mirror `status` getter pattern)
```

### Pattern 1: The three-check adapter, extended with a fourth

**What:** `validateCommitLegality` (`src/core/components/integrity.ts:312-373`) currently runs, in
order: `validateAppComponentIntegrity` (component-integrity) → `classifyDisbandCommit`
(disband-legality) → `validateAdminLeafCoupling` (admin-leaf-coupling). D-07 requires inserting the
new profile/proof check between step 1 and step 2.

**When to use:** Every commit-processing seam already calls this one function — no seam-local
change needed once the new check is added here.

**Example (structure to extend, not to copy verbatim):**
```typescript
// Source: src/core/components/integrity.ts:312-373 (current implementation)
export function validateCommitLegality(args: {
  parentState: ClientState;
  resultingState: ClientState;
  proposals: readonly (Proposal | ProposalWithSender)[];
  committerLeafIndex?: number;
}): CommitIntegrityViolation | undefined {
  // ... proposalsWithSenders / appDataUpdateOps / requiredIds setup (unchanged) ...

  const integrityViolation = validateAppComponentIntegrity({ /* ... */ });
  if (integrityViolation) return integrityViolation;

  // NEW (D-01/D-07): insert here, before disband classification.
  // const profileViolation = validateAccountIdentityProofDelta({
  //   parentState: args.parentState,
  //   resultingState: args.resultingState,
  // });
  // if (profileViolation) return profileViolation;

  const disband: DisbandClassification = classifyDisbandCommit({ /* ... */ });
  if (disband.kind === "violation")
    return { reason: "disband-legality", detail: disband.detail };

  const resultingMemberAccounts = getGroupMemberPubkeys(args.resultingState);
  return validateAdminLeafCoupling({ /* ... */ });
}
```

### Pattern 2: D-02 tree-diff — structural comparison, not TLS re-encoding

**What:** `ClientState.ratchetTree` is `(Node | undefined)[]` (`ts-mls/src/ratchetTree.ts:76`).
Leaf positions are even node indices (`nodeToLeafIndex(nodeIndex) = nodeIndex / 2`, already used at
`src/core/group-members.ts:12-16`). A node is `undefined` when blank (removed or never allocated).
The parent and resulting arrays may differ in length (tree width grows on Add;
`ts-mls/src/ratchetTree.ts:155-156`).

**Critical constraint:** `leafNodeEncoder` and `leafNodeEqual` (`ts-mls/src/leafNode.ts:173,271`)
are **not exported** from `ts-mls`'s package root (`ts-mls/src/index.ts:247-256` exports only the
`LeafNode` *type* variants, never the encoder or equality helper). Even if they were exported,
`leafNodeEqual` only compares `signaturePublicKey` (`ts-mls/src/leafNode.ts:271-273`) — it would
silently treat a leaf whose `extensions` changed (the exact case Phase 8 must catch) as "equal" if
the signature key happened to stay the same. Do not use it, and do not attempt a deep subpath
import into `ts-mls/dist/src/leafNode.js` from production code — the vendor guard
(`scripts/vendor-ts-mls.mjs`) fails the build on any subpath `ts-mls` specifier outside the vendor
directory.

**Recommended comparison:** use `leaf.signature` byte-inequality as the changed-leaf test. Every
`LeafNode` (all three `leafNodeSource` variants — key_package/update/commit) carries a `signature:
Uint8Array` field over its own TBS content (`LeafNode = LeafNodeData & LeafNodeInfoOmitted & {
signature: Uint8Array }`, `ts-mls/src/leafNode.ts:171`). A leaf is only re-signed when its content
actually changes (Add, Update proposal, or the committer's own update path) — an untouched leaf is
carried into the resulting tree as the literal same object with the literal same signature bytes.
Comparing `signature` via the existing `bytesEqual` helper (`src/core/components/bytes.ts:12-19`,
already handles `undefined` args) is:
- **Zero-dependency** — reads a field ts-mls already exposes on every `LeafNode`, no internal
  import needed.
- **Safe to over-include** — if some yet-undiscovered case re-signs an unchanged leaf, the
  tree-diff simply re-validates a leaf whose proof was already valid (wasted work, not a
  correctness bug; D-01's "unchanged leaves are trusted" is a performance note, not a security
  requirement).
- **Never under-inclusive for the cases D-02 cares about** — Adds, Update proposals, and the
  update-path leaf all produce a freshly-signed `LeafNode` by construction (see Pattern 3).

```typescript
// Sketch (Claude's discretion on exact structure/naming/location within src/core).
// Source pattern: src/core/group-members.ts:12-16 (nodeToLeafIndex), ts-mls/src/ratchetTree.ts:76
// (RatchetTree = (Node | undefined)[]), ts-mls/src/nodeType.ts (nodeTypes.leaf).
export interface ChangedLeaf {
  leafIndex: number;
  leaf: LeafNode;
}

export function diffChangedLeaves(
  parentTree: RatchetTree,
  resultingTree: RatchetTree,
): ChangedLeaf[] {
  const changed: ChangedLeaf[] = [];
  const maxLength = Math.max(parentTree.length, resultingTree.length);
  for (let nodeIndex = 0; nodeIndex < maxLength; nodeIndex += 2) {
    const before = parentTree[nodeIndex];
    const after = resultingTree[nodeIndex];
    if (!after || after.nodeType !== nodeTypes.leaf) continue; // blank or removed: skip (D-02)
    const beforeLeaf =
      before && before.nodeType === nodeTypes.leaf ? before.leaf : undefined;
    if (beforeLeaf && bytesEqual(beforeLeaf.signature, after.leaf.signature))
      continue; // unchanged: trusted, skip (D-01)
    changed.push({ leafIndex: nodeIndex / 2, leaf: after.leaf });
  }
  return changed;
}
```

Note the `leafIndex` this produces is the true MLS tree leaf index (`nodeIndex / 2`), which is what
D-06's `CommitIntegrityViolation.leafIndex` should carry — **not** the enumeration index
`validateGroupMemberAccountIdentityProofs` uses internally
(`src/core/components/account-identity-proof.ts:588-601`, which numbers members in
tree-walk-skipping-blanks order via `getGroupMembers`/`getMlsGroupMembers`, a different and
smaller-than-tree-index numbering for any group with blanked/removed leaves). Do not reuse that
helper's indexing scheme for the new violation's `leafIndex` field.

### Pattern 3: Why every leaf that D-02 must catch is guaranteed freshly-signed

- **Add:** the added `KeyPackage.leafNode` is signed fresh at KeyPackage-generation time
  (`ts-mls/src/keyPackage.ts:166`, `signLeafNodeKeyPackage`) — always a new signature, unrelated to
  any existing tree leaf.
- **Update proposal:** an Update proposal's `leafNode: LeafNodeUpdate` is a completely separate
  signed structure a member builds when they want to change their leaf — not derivable without
  `signLeafNodeUpdate` (also unexported at the package root,
  `ts-mls/src/leafNode.ts:241`/`ts-mls/src/index.ts` does not list it), so it can only be
  constructed via ts-mls's own real signing path, which always produces a fresh `signature`.
- **Committer's update-path leaf:** `createUpdatePath` (`ts-mls/src/updatePath.ts:71-138`) always
  builds a NEW `hpkePublicKey`, `parentHash`, and `leafNodeSource: "commit"` for the committer's own
  leaf (lines 105-117) and signs it fresh with `signLeafNodeCommit` — even though `extensions`,
  `capabilities`, `credential`, and `signaturePublicKey` are copied byte-for-byte from
  `originalLeafNode.leaf` (line 108-111). The `signature` is therefore always different from the
  parent leaf's signature on every commit that leaf's owner authors, satisfying the "byte-different"
  test even when the account-identity-proof content itself is unchanged (correctly triggering a
  re-check, which passes trivially for a leaf whose proof was already valid).

### Pattern 4: D-09 exact insertion points

**Inbound** (`src/engine/admin-policy.ts:39-40`):
```typescript
// CURRENT (the D-09 gap):
return (incoming) => {
  if (incoming.kind === "proposal") return "accept";   // <-- blanket accept, closes here
  for (const { proposal } of incoming.proposals) { /* commit-embedded Add validation, unchanged */ }
  // ...
};
```
`IncomingMessageCallback`'s `"proposal"` variant is `{ kind: "proposal"; proposal:
ProposalWithSender }` (`ts-mls/src/incomingMessageAction.ts:8-12`) — exactly one proposal, not an
array. The fix mirrors the existing commit-embedded Add loop body (lines 42-60) applied to this
single proposal: if `proposal.proposal.proposalType === defaultProposalTypes.add`, run
`validateKeyPackageAccountIdentityProof(proposal.proposal.add.keyPackage, ciphersuiteId)` in a
try/catch, `return "reject"` on throw. Non-Add proposal kinds (Update, Remove, PSK, ...) keep the
existing "accept" (Update is Phase 9 D-10; Remove/PSK are out of this phase's scope).

**Local/outbound** (`src/engine/group-engine.ts:879-902`, `case "proposal"`):
```typescript
case "proposal": {
  const { message, newState } = await createProposal({ /* ... */, proposal: intent.proposal, /* ... */ });
  // ...
}
```
`intent.proposal: Proposal` (`src/engine/types.ts:116`) is used directly with no validation — this
is reachable by any caller who constructs `engine.send({ kind: "proposal", proposal: {
proposalType: defaultProposalTypes.add, add: { keyPackage } } })` directly, bypassing
`proposeInviteUser` (`src/client/group/proposals/invite-user.ts:10-28`) entirely, since
`proposeInviteUser` is only invoked when its returned `ProposalAction` is passed through a
*commit's* `extraProposals` array (`group-engine.ts:922-931`), never through this standalone
`"proposal"` intent kind. Add the same `validateKeyPackageAccountIdentityProof` guard here before
calling `createProposal`, gated on `intent.proposal.proposalType === defaultProposalTypes.add`.

Note: a raw Add smuggled into `send({kind: "commit", extraProposals: [rawAddProposal]})` does NOT
need a separate D-09 gate — `#assertStagedCommitLegal` (called unconditionally after
`createCommit` in both the `"commit"` and `"selfUpdate"` cases, `group-engine.ts:975-980,
1058-1063`) already runs the D-02 tree-diff over the resulting state, which will catch that Add via
the shared adapter regardless of which proposal path introduced it.

### Pattern 5: D-04 fixture construction per matrix row

The three D-04 fixtures need three different construction strategies — this is the answer to
research_focus item 2 in full.

**1. "A commit that drops the `0x8009` requirement"** — straightforward, same shape as the existing
`buildComponentIntegrityViolation` helper in `commit-legality-seams.test.ts:203-233`: an
`AppDataUpdate` proposal (`appDataUpdateProposalType`) targeting `APP_COMPONENTS_COMPONENT_ID`
(`0x0001`) with an `operation: "update"` payload that encodes a components list omitting
`ACCOUNT_IDENTITY_PROOF_COMPONENT_ID`. This is real, wire-valid `createCommit` output — no forgery
needed.

**2. "An Add whose leaf has no proof"** — call ts-mls's exported `generateKeyPackageWithKey`
(`ts-mls/src/keyPackage.ts:135-171`, `@public`, exported at `ts-mls/src/index.ts:271-272`) directly,
passing `leafNodeExtensions: []` (or omitting the account-identity-proof entry) instead of routing
through `src/core/key-package.ts`'s `generateKeyPackage` (which always calls
`produceAccountIdentityProof` first, `src/core/key-package.ts:140-149`). The resulting KeyPackage's
leaf has a fully valid MLS-level signature (ts-mls signs whatever `leafNodeExtensions` it is given)
but no `0x8009` dictionary entry — exactly "no proof," wire-valid, real `createCommit` Add proposal.
For "an Add whose leaf has an invalid (not just missing) proof," pass a
`makeLeafAppComponentsExtension(tamperedProofBytes)` entry instead — the existing
`group-engine.test.ts:392-410` test already demonstrates this exact tamper-the-last-byte pattern for
the admin-policy unit test; the same technique works to build a real Add proposal for the seam
matrix.

**3. "An update-path leaf with an invalid proof"** (the hard one) — cannot be produced through a
normal, honest commit flow, because (Pattern 3) the update-path leaf always carries forward its
OWN previous extensions unchanged. The only way to get an invalid proof onto an update-path leaf is
to get an already-invalid leaf into the tree FIRST, via a route that bypasses this phase's own new
Add-time gates, then have that leaf's owner self-update:
  1. Build a multi-party group exactly like `fourPartyEpoch1Group()`
     (`commit-legality-seams.test.ts:79-183`) does — using RAW `createCommit`/`joinGroup` calls
     directly against `ts-mls`, not `MarmotGroupEngine.send()`. This is the existing precedent for
     constructing "admin-authorized but illegal" fixtures: the raw founding commit never passes
     through the engine's D-08/D-09 gates at all, so a forged member (built via
     `generateKeyPackageWithKey` with a tampered `leafNodeExtensions` entry, same technique as
     fixture 2) can be added as a founding/early member with no gate to bypass.
  2. Have that forged member issue a proposal-less self-update: `createCommit({ state:
     forgedMemberState, extraProposals: [] })`. Per Pattern 3, the resulting update-path leaf
     carries the SAME forged (invalid) `0x8009` entry forward, but with a fresh `signature` and
     `hpkePublicKey` — genuinely byte-different from the parent leaf, so D-02's tree-diff correctly
     flags it as changed, and D-03's proof-validity check correctly rejects it. This is a fully
     wire-valid MLS commit (ts-mls's own cryptographic verification passes — the leaf's outer MLS
     signature is real) carrying an invalid Marmot-layer proof.
  3. Feed the resulting commit message to each seam:
     - **Send:** have the forged member's own `MarmotGroupEngine` call `send({kind:
       "selfUpdate"})` and assert `CommitLegalityError` (mirrors
       `commit-legality-seams.test.ts:442-468`).
     - **Inbound:** wrap the same commit bytes and deliver to a different party's engine via
       `engine.ingest([envelope])`, assert `kind: "rejected"`.
     - **Replay/fork-recovery:** deliver as a past-epoch fork-pool candidate (advance the receiving
       engine past the source epoch first with an unrelated commit, exactly as
       `commit-legality-seams.test.ts:470-526` already does), assert the candidate edge is dropped
       (never recorded in history).
     - **Tree-fed convergence:** this seam specifically tests re-validation of ALREADY-PERSISTED
       edges (see `#treeResolution`'s docstring, `group-engine.ts:2825-2841`, "a persisted tree edge
       may have been written by a pre-upgrade build that never enforced `validateCommitLegality`").
       Construct this by calling `GroupHistoryTree.recordEdge()`
       (`src/engine/history-tree.ts:455`, public method, takes a plain `EdgeSnapshot` —
       `parentTag`/`childTag`/`childEpoch`/`commitBytes`/`commitDigest`/`childSnapshot`/
       `senderLeafIndex`, `src/engine/history-tree.ts:57-72`) directly with the forged commit's
       snapshot data, bypassing the normal `#buildBranches`/`explore()` validation path entirely
       (simulating "old data written before this gate existed"), then call
       `engine.reconvergeFromHistory()` (public, `group-engine.ts:2810-2823`) and assert the switch
       is abandoned (tip confirmation tag unchanged).

### Anti-Patterns to Avoid
- **Deep subpath imports into `ts-mls/dist/src/*.js` or `ts-mls/src/*.js` to reach
  `leafNodeEqual`/`signLeafNodeUpdate`/`leafNodeTBSEncoder`:** not exported from the package root
  (`ts-mls/src/index.ts`) for a reason — production code is blocked by the vendor guard, and no
  existing test in this codebase does this (verified by grep across `src/**/*.ts`). Even if it
  worked for test-only code (the vendor guard only scans `dist/`, not `src/**/*.test.ts`), it
  creates a fragile dependency on the fork's internal file layout. Prefer the
  `generateKeyPackageWithKey`-based forgery techniques in Pattern 5, which stay entirely within
  ts-mls's public, `@public`-annotated, index.ts-exported surface.
- **Using `leafNodeEqual` for the D-02 diff:** not exported, and even if it were, it only compares
  `signaturePublicKey` — would silently miss any leaf whose `extensions` changed but whose
  signature key did not (impossible in this codebase's flows per Pattern 3, but fragile to rely on
  regardless).
- **Reusing `validateGroupMemberAccountIdentityProofs`'s member-enumeration index as `leafIndex`
  for D-06:** it numbers members in tree-walk order via `getGroupMembers`
  (`account-identity-proof.ts:588-601`), which is NOT the same as the true MLS leaf index
  (`nodeIndex / 2`) once any leaf in the tree is blank. Use the tree-diff helper's own leaf-index
  computation.
- **Adding the D-11 traffic-refusal gate per-`MarmotGroup`-method** (mirroring `#assertNotDisbanded()`'s
  repetition across ~8 call sites in `marmot-group.ts`): unlike disband, both outbound and inbound
  already have a SINGLE existing choke point below the client layer (`MarmotGroupEngine.send()` and
  `ingestEnvelopes` respectively) — adding the gate there covers every `MarmotGroup` public method
  for free, with far less code than replicating `#assertNotDisbanded()`'s pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Changed-leaf detection | A hand-rolled TLS re-encoding of `LeafNode` to compare full byte content | `leaf.signature` inequality via the existing `bytesEqual` helper (`src/core/components/bytes.ts:12-19`) | ts-mls's own encoder isn't exported; re-implementing TLS presentation-language encoding for `LeafNodeData`/`LeafNodeInfoOmitted` (three source-dependent shapes, `ts-mls/src/leafNode.ts:13-83`) duplicates fork-internal logic that can silently drift from the real encoder. |
| Forged wire-valid leaves for tests | A custom LeafNodeTBS signer re-implementing `signWithLabel`/`MLS 1.0 LeafNodeTBS` framing | `generateKeyPackageWithKey` (ts-mls `@public` export) with tampered `leafNodeExtensions` | Produces a genuinely, cryptographically valid MLS leaf (ts-mls signs it for real) with Marmot-layer-invalid content — exactly what the seam tests need, using only exported, versioned API surface. |
| Profile classification | Re-deriving "does this group require `0x8009`" from raw extension bytes at each new call site | `classifyGroupAccountIdentityProofProfile` / `assertCurrentGroupAccountIdentityProofProfile` (`src/core/components/account-identity-proof.ts:611-689`, already built in Phase 7) | Already handles the mixed/legacy/neither cases correctly per the spec's migration-from-v1 rules; re-deriving anywhere risks exactly the seam-asymmetry defect class this phase exists to close. |

**Key insight:** every primitive this phase needs to validate proofs and classify profiles already
exists from Phase 7. The actual new work is entirely about *reach* — making sure the SAME
primitives are called from every seam, with a SAME reason surface, not building new validation
logic.

## Common Pitfalls

### Pitfall 1: `GroupRegistry.loadAll()` uses `Promise.all`, not `Promise.allSettled`
**What goes wrong:** `loadAll()` (`src/client/group-registry.ts:412-415`) is
`Promise.all(groupIds.map((groupId) => this.get(groupId)))`. If the D-11 classify-on-load logic is
implemented as a THROW (e.g., calling `assertCurrentGroupAccountIdentityProofProfile` unguarded
during `load()`/`build()`/`track()`), one malformed stored group's classification failure rejects
the WHOLE `Promise.all`, and every other group in the store fails to load too.
**Why it happens:** `Promise.all` short-circuits to rejection on the first rejected input promise.
**How to avoid:** classification must be **non-throwing** at load time — compute the profile
classification (wrapping `classifyGroupAccountIdentityProofProfile`'s own possible throw, e.g. its
`invalid-location` case at `account-identity-proof.ts:614`, in a try/catch that maps to a
"classification failed → treat as unsupported" outcome) and store the result as a field/flag on the
constructed `MarmotGroup`, exactly mirroring the existing non-throwing `status` getter pattern
(`marmot-group.ts:537-542`, itself just a derived read of `groupActiveState.kind`/
`terminalTombstone`, never a throw).
**Warning signs:** any implementation that calls `assertCurrentGroupAccountIdentityProofProfile`
(the `assert*`-prefixed, throwing variant) directly inside `GroupRegistry.load()`,
`MarmotGroup.fromClientState()`, or `GroupRegistry.track()` without a wrapping try/catch.

### Pitfall 2: The committer's own update-path leaf cannot be forged through `createCommit`
**What goes wrong:** attempting to build the D-04 "update-path leaf with invalid proof" fixture by
looking for a `createCommit` parameter that lets a self-updating member supply custom
`leafNodeExtensions` for their own leaf.
**Why it happens:** `createUpdatePath` (`ts-mls/src/updatePath.ts:105-111`) unconditionally copies
`originalLeafNode.leaf.extensions` — there is no override parameter anywhere in `createCommit`'s
public options (`ts-mls/src/createCommit.ts`) for the committer's own leaf content.
**How to avoid:** use Pattern 5's two-step construction — forge the leaf at ADD time (before it's
ever in the tree, via `generateKeyPackageWithKey`), then have it self-update to produce a
byte-different (fresh signature) leaf carrying the same forged content forward.
**Warning signs:** any test helper that passes a `leafNodeExtensions`-like option directly to
`createCommit({ state, ... })` expecting it to affect the committer's own resulting leaf — no such
option exists.

### Pitfall 3: `#treeResolution` and pool-replay share one call site — a parity test must still hit both callers
**What goes wrong:** assuming that once `resolveCandidateParent` is tested once (e.g., via
pool-replay), tree-fed convergence is automatically covered, and skipping the tree-fed row of the
D-04 matrix.
**Why it happens:** they do call the same function
(`src/engine/fork-recovery.ts:83-137`), so the VALIDATION LOGIC is identical — but the two CALLERS
present it with structurally different input (`#buildBranches`/`explore()` presents freshly-explored
candidates that get validated before ever being recorded; `#treeResolution` presents ALREADY-RECORDED
tree edges, specifically to catch data grandfathered in from before this gate existed — see its
docstring at `group-engine.ts:2825-2841`). A parity test that only exercises the fresh-candidate path
never proves the "abandon a persisted-but-now-invalid edge" behavior actually works.
**How to avoid:** construct the tree-fed matrix row via direct `GroupHistoryTree.recordEdge()`
calls (Pattern 5, step 3, tree-fed sub-bullet), not by relying on the normal explore path to
populate the tree.
**Warning signs:** a D-04 test file with only 3 `describe`/`it` blocks per fixture instead of 4.

### Pitfall 9 (carried from prior research, reconfirmed): `0x8009` leaking into GroupContext
**What goes wrong:** treating the account-identity-proof component like other components (e.g.
`0x8003` admin-policy) that DO have GroupContext-level dictionary state.
**Why it happens:** most `0x8XXX` components in `src/core/components/ids.ts` have both a required
flag AND a data payload; `0x8009` only ever has a required flag (leaf-only proof data).
**How to avoid:** already enforced by `validateAppComponentIntegrity`'s leaf-only guard
(`integrity.ts:145-169`) — GRP-01's test should assert the CREATED group's
`app_data_dictionary` carries NO `0x8009` entry, only the requirement in `app_components` (per the
Specific Ideas note in CONTEXT.md).

### Pitfall 11 (carried from prior research, reconfirmed): seam asymmetry (mdk#707)
**What goes wrong:** a validator exists and is correct, but is only reachable from some seams.
**Why it happens:** each engine seam (send, inbound, replay, tree-fed) is a separately-evolved code
path; a new check added to fix a seam-specific bug report naturally gets added at the seam where
the bug was found, not centrally.
**How to avoid:** this is the entire reason `validateCommitLegality` exists as the single shared
adapter — Phase 8's job is almost entirely "add the check to that one function," not "add checks at
each of three call sites."

## Code Examples

### Confirming there are exactly three `validateCommitLegality` call sites (not four)
```
$ grep -n "validateCommitLegality(" src/engine/*.ts
src/engine/fork-recovery.ts:125:      validateCommitLegality({    <- pool-replay AND tree-fed (shared, via resolveCandidateParent)
src/engine/ingest.ts:730:        const violation = validateCommitLegality({   <- inbound
# send: src/engine/group-engine.ts:1291 (inside #assertStagedCommitLegal)
```

### The existing send-seam disposition (model for verifying D-07's ordering doesn't regress it)
```typescript
// Source: src/engine/group-engine.ts:1285-1298 (current, unmodified by this phase)
#assertStagedCommitLegal(
  parentState: ClientState,
  resultingState: ClientState,
  committedProposals: readonly ProposalWithSender[],
  committerLeafIndex: number,
): void {
  const violation = validateCommitLegality({
    parentState,
    resultingState,
    proposals: committedProposals,
    committerLeafIndex,
  });
  if (violation) throw new CommitLegalityError(violation);
}
```
`CommitLegalityError.violation` is the raw `CommitIntegrityViolation` object
(`group-engine.ts:180-185`) — D-06's new optional `proofReason`/`leafIndex` fields propagate through
this class with zero additional code once added to the `CommitIntegrityViolation` interface.

### The audit reason normalization already handles a new hyphenated reason for free
```typescript
// Source: src/engine/group-engine.ts:2229-2235 (current, unmodified by this phase)
if (result.kind === "rejected") {
  this.#emitAudit({
    type: "rejection",
    msg_id: msgId,
    reason: (result.reason ?? "admin-policy").replaceAll("-", "_"),
  });
}
```
`"account-identity-proof"` → `"account_identity_proof"` automatically via this existing
`.replaceAll("-", "_")` call — no code change needed here, only the new literal added to
`RejectedIngestResult.reason`'s union in `src/engine/types.ts:178-182`.

### Session-layer types are auto-derived — no separate client-side reason-union edit needed
```typescript
// Source: src/client/session/group-session.ts:67-81 (current, unmodified by this phase)
type SessionIngestResult<TResult extends EngineIngestResult<NostrEvent>> =
  TResult extends { envelope: NostrEvent }
    ? Omit<TResult, "envelope"> & { event: NostrEvent }
    : TResult;

export type RejectedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"rejected">
>;
```
This is a distributive mapped type over the ENGINE union — adding `"account-identity-proof"` to
`src/engine/types.ts`'s `RejectedIngestResult<TEnvelope>.reason` union is sufficient; this file
needs no edit (confirmed by the decision log: "[Phase 03.1-09]: Derive every session ingest variant
from the engine union").

## State of the Art

Not applicable in the usual "library X deprecated, use Y" sense — this is internal protocol logic
tracking a spec/reference-implementation pair, not a third-party library upgrade. The relevant
"state of the art" tracking is the `refs/mdk` upstream check already performed for this phase
(see Sources below): as of the bump to `be785346`, no upstream MDK commits touch
`account_identity_proof.rs`, `app_components.rs`, or the staged-commit validation call sites this
phase ports from. Two precedent-worth ingest-seam changes were identified and are cited in
Sources/Pattern discussions above (`a9c2527c` durable-record-level refusal before hydration;
`dcb3c1c3` `reject_legacy_group_additions` — confirmed to be a NARROWER policy than D-11's blanket
refusal, i.e. D-11 is an intentional, stricter divergence from MDK, not an oversight).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Comparing `leaf.signature` byte-inequality is a sufficient and safe proxy for "this leaf's content changed" across every code path that produces a resulting `ClientState` in this codebase (Add, Update proposal, update-path) | Pattern 2 / Pattern 3 | If some future or overlooked ts-mls code path re-signs a leaf whose content is genuinely unchanged, the diff over-includes it (safe: wasted re-validation, not a missed violation) — no correctness risk identified, but worth a quick unit-test assertion during implementation that an untouched leaf's signature really does survive a sibling's commit unchanged, to lock in the assumption. |
| A2 | `GroupHistoryTree.recordEdge()` (`src/engine/history-tree.ts:455`) is a stable, intentionally-public test seam for injecting a "pre-upgrade" edge, not an implementation detail that might be made private/renamed | Pattern 5, step 3 (tree-fed) | If this method is refactored, the D-04 tree-fed matrix row needs re-deriving; low risk since it is already used this way conceptually (the class comment at `history-tree.ts:54` cross-references it as the documented way an edge enters the tree). |

**If this table is empty:** N/A — see above; both entries are low-risk implementation-detail
assumptions the planner should spot-check, not architecture-level guesses.

## Open Questions

1. **Exact naming for the D-11 unsupported-profile flag and refusal error/result types**
   - What we know: `MarmotGroupStatus = "active" | "removed" | "disbanded"`
     (`marmot-group.ts:81`) describes MEMBERSHIP state; profile-unsupported is an orthogonal
     protocol-compatibility concern (a group can be simultaneously `"active"` in membership terms
     and unsupported-profile). D-11 explicitly says the group "stays listable, displayable, and
     `destroy()`-able" — i.e., it should NOT be folded into a new `MarmotGroupStatus` value that
     would change existing status-branching UI logic.
   - What's unclear: whether the planner should add a sibling getter (e.g. `profileSupported:
     boolean` or `accountIdentityProofProfile: AccountIdentityProofProfile`, reusing the existing
     `AccountIdentityProofProfile` type from `account-identity-proof.ts:130-131`) or a richer
     discriminated result type.
   - Recommendation: reuse the existing `AccountIdentityProofProfile` type
     (`"current"|"legacy"|"mixed"|"neither"`) directly as the exposed getter's return type — it's
     already exactly the right shape, already tested, and avoids inventing a new boolean that loses
     information useful for diagnostics/UI (e.g., distinguishing "legacy" from "mixed" in an error
     message). Left as Claude's Discretion per CONTEXT.md.

2. **Whether the D-11 outbound gate at `MarmotGroupEngine.send()` should also short-circuit
   `mayPrepareLocalCommit`/lifecycle-adjacent internal callers, or only the public `send()` entry**
   - What we know: `send()` (`group-engine.ts:806-846`) is the only public entry point for outbound
     work; internal helpers like `#prepareOutboundCommitProposals` are only ever reached through it.
   - What's unclear: whether `MarmotGroup`'s own convenience methods (`selfUpdate()`,
     `disband()`, etc., which ultimately call `session.send()` → `engine.send()`) need their OWN
     early check for a friendlier, more specific error message (e.g. naming the unsupported profile
     kind) versus relying on the generic error thrown from deep inside `engine.send()`.
   - Recommendation: start with the single engine-level gate (matches "prefer a single gate" in
     CONTEXT.md); if UX review during code-review finds the resulting error message insufficiently
     actionable at the `MarmotGroup` call site, add a thin re-throw/wrap at that layer without
     duplicating the classification logic itself.

## Environment Availability

Not applicable — this phase has no external tool/service/runtime dependencies beyond the existing
Node.js/pnpm/Vitest toolchain already verified working in this repository (see project CLAUDE.md;
no new CLI, database, or network dependency is introduced).

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (absent = enabled per instructions).

### Applicable ASVS Categories

This is a P2P messaging protocol library, not a web application, so several ASVS categories map
loosely or not at all. Applied in protocol terms:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Partial | Not session-based; the analogous concept is per-leaf account-identity binding, which is exactly this phase's subject (`0x8009` proof binds an MLS leaf signature key to a Nostr account credential). |
| V3 Session Management | No | No web session concept; MLS epoch/state management is out of ASVS's scope for this mapping. |
| V4 Access Control | Yes | Admin-only commit/proposal authorization — already implemented in `createAdminCommitPolicyCallback` (`src/engine/admin-policy.ts`); this phase extends it (D-08/D-09) rather than introducing new access-control surface. |
| V5 Input Validation | Yes | Structural validation of untrusted MLS wire data (LeafNode extensions, dictionary entries) — `validateLeafAccountIdentityProof` (`account-identity-proof.ts:321-482`) already does exhaustive, ordered structural checks (credential shape, dictionary sort order, duplicate detection) per Phase 7; this phase reuses it, does not hand-roll new parsing. |
| V6 Cryptography | Yes | BIP-340 Schnorr signature verification via `@noble/curves/secp256k1.js` (`schnorr.utils.lift_x`, `account-identity-proof.ts:23,338`) and MLS-native signature verification via `ts-mls`'s own `Signature.verify` — never hand-rolled; this phase adds no new cryptographic primitive, only new call sites for existing verified primitives. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Seam asymmetry (a validator exists but is reachable from only some code paths) — the "mdk#707" pattern this whole phase exists to close | Elevation of Privilege / Tampering | Centralize in the single shared `validateCommitLegality` adapter (already the established pattern in this codebase); this phase's core task. |
| Forged/absent account-identity proof admitted into a group | Spoofing | `validateLeafAccountIdentityProof`'s ordered structural + cryptographic checks (already built, Phase 7); this phase's job is closing the remaining reach gaps (standalone Add admission, update-path leaves) so the same check is unavoidable. |
| Stored (pre-upgrade) data silently grandfathered past a newly-added gate | Tampering / Repudiation | `#treeResolution`'s existing fail-closed re-validation of persisted tree edges (`group-engine.ts:2825-2841`) is the established pattern; D-11's load-time classification (never throwing, always flagging) follows the same "don't trust old persisted state uncritically, but don't crash on it either" philosophy. |
| Diagnostics leaking pubkeys/identity material in error messages | Information Disclosure | `foundation/errors.md`'s diagnostics-privacy rule, already enforced throughout `account-identity-proof.ts` (e.g. "never a pubkey," `account-identity-proof.ts:582`) and explicitly re-affirmed for D-06's new `CommitIntegrityViolation` fields (`proofReason`/`leafIndex` are both pubkey-free by construction). |

## Sources

### Primary (HIGH confidence — direct source reads)
- `src/core/components/integrity.ts` — `validateCommitLegality` and its three existing checks,
  full read.
- `src/core/components/account-identity-proof.ts` — every validator/classifier this phase reuses,
  full read.
- `src/core/group-members.ts` — pure `ClientState`/ratchet-tree read pattern precedent.
- `src/engine/group-engine.ts` — `#assertStagedCommitLegal` (:1285-1298), both call sites
  (:975-980, :1058-1063), `send()` (:806-846), `#treeResolution` (:2842-2929) and its docstring
  (:2825-2841), `case "proposal"` (:879-902), `CommitLegalityError` (:180-185).
- `src/engine/ingest.ts` — inbound disposition (:730-752), the disband/self-evicted gate pattern
  (:344-371).
- `src/engine/fork-recovery.ts` — `resolveCandidateParent` (:83-137), confirmed shared by
  pool-replay and tree-fed convergence.
- `src/engine/admin-policy.ts` — `createAdminCommitPolicyCallback` full read, exact D-08/D-09 gap
  locations (:39-61).
- `src/engine/types.ts` — `RejectedIngestResult`/`SkippedIngestResult` reason unions (:166-207).
- `src/client/session/group-session.ts` — `SessionIngestResult` distributive-mapped-type
  confirmation (:61-110), audit reason normalization (:2229-2235, via group-engine.ts).
- `src/client/group-registry.ts` — `loadAll`/`load`/`track`/`build` full read (:140-416),
  `Promise.all` risk confirmed.
- `src/client/group/marmot-group.ts` — `MarmotGroupStatus`, `status` getter, `#assertNotDisbanded`
  pattern (:81, :537-542, :800-802).
- `src/client/groups-manager.ts` — GRP-03 join gate already wired (:714-726).
- `src/client/group/proposals/invite-user.ts` — `proposeInviteUser` full read (:10-28).
- `src/core/key-package.ts` — `generateKeyPackage`'s proof-attachment flow (:101-160).
- `src/core/components/ids.ts` — component id registry, `DEFAULT_GROUP_COMPONENT_IDS` (:64-79).
- `src/core/components/bytes.ts` — `bytesEqual`/`compareBytes` full read.
- `src/engine/history-tree.ts` — `recordEdge`/`EdgeSnapshot` (:57-72, :455).
- `src/engine/__tests__/commit-legality-seams.test.ts` — full read; the D-04 model file.
- `src/engine/__tests__/group-engine.test.ts` — D-06 known-gap test (:392-438), tamper-pattern
  precedent (:392-410).
- `src/core/components/__tests__/account-identity-proof.test.ts` — `makeLeaf` plain-object fixture
  pattern (:365-376), confirming this codebase's precedent for core-level unit-test leaf forgery.
- `ts-mls/src/leafNode.ts` — `LeafNode`/`LeafNodeData`/`leafNodeEncoder`/`leafNodeEqual` full read
  (:1-274), confirmed NOT exported from package root.
- `ts-mls/src/index.ts` — package-root export surface, confirmed exclusions (`leafNodeEncoder`,
  `leafNodeEqual`, `signLeafNodeUpdate`, `signWithLabel` all absent; `generateKeyPackageWithKey`
  present at :271-272).
- `ts-mls/src/ratchetTree.ts` — `RatchetTree` type, node structure (:1-80).
- `ts-mls/src/updatePath.ts` — `createUpdatePath`, confirmed extensions/signaturePublicKey
  carry-forward (:71-138).
- `ts-mls/src/keyPackage.ts` — `generateKeyPackageWithKey`/`generateKeyPackage` full read
  (:120-200), confirmed `@public` and exported.
- `ts-mls/src/incomingMessageAction.ts` — `IncomingMessageCallback` type, confirmed `"proposal"`
  variant shape.
- `ts-mls/package.json` — confirmed single `.` export, no subpath access (vendor-guard
  implication).
- `scripts/vendor-ts-mls.mjs` — confirmed vendor guard scans only `dist/`, not test files.
- `refs/mdk/crates/cgka-engine/src/message_processor/ingest.rs` (~L360-410) — durable-record-level
  refusal-before-hydration precedent (`a9c2527c`).
- `refs/mdk/crates/cgka-engine/src/openmls_projection.rs` (~L3663-3905) —
  `reject_legacy_group_additions` policy, confirmed narrower than D-11 (`dcb3c1c3`).
- `.planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-CONTEXT.md` —
  all locked decisions, discretion areas, canonical refs.
- `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — requirement text, prior-phase decision log
  (session-type auto-derivation confirmed via decision log entry).

### Secondary (MEDIUM confidence)
- None — no web-sourced claims were needed for this phase; everything is grounded in a direct
  codebase/reference-submodule read.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; every technique cited is read directly from already
  in-repo source.
- Architecture: HIGH — the three-call-site finding and the update-path carry-forward finding are
  both direct reads of the exact functions involved, not inference.
- Pitfalls: HIGH — `Promise.all` in `loadAll()` and the update-path immutability are both confirmed
  by reading the implementing code, not by analogy.

**Research date:** 2026-09-15
**Valid until:** Stable — this research is tied to specific line-numbered reads of this repo's
current `master` and the vendored `ts-mls` fork at `2.0.0-rc.14`; re-verify line numbers if
significant refactors land in `src/engine/group-engine.ts`, `src/engine/ingest.ts`,
`src/engine/fork-recovery.ts`, or `src/core/components/integrity.ts` before this phase is planned.
