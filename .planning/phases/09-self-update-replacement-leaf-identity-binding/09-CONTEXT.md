# Phase 9: Self-Update / Replacement-Leaf Identity Binding - Context

**Gathered:** 2026-09-24
**Status:** Ready for planning

<domain>
## Phase Boundary

A replacement leaf — produced by an Update proposal or by a committer's update-path — must preserve the member's
account identity, and its `0x8009` proof must bind that leaf's resulting signature key. Enforcement extends the Phase 8
chokepoint (`validateCommitAccountIdentityProofs` in `src/core/components/integrity.ts`), plus a new standalone-Update
admission gate at the two proposal seams.

Covers UPD-01..04. **Validation-only: no new key-rotation API, no producer change.**

**Established by the codebase scout (do not re-derive):**

- **marmot-ts never produces an offending leaf.** ts-mls `createUpdateProposal` (`ts-mls/src/createMessage.ts:161`)
  and `createUpdatePath` (`ts-mls/src/updatePath.ts:104`) both carry `credential`, `signaturePublicKey`, and
  `extensions` forward verbatim, and marmot-ts never passes `leafNodeExtensions` outside KeyPackage generation. Every
  signed input of the proof is therefore unchanged, so the carried-forward proof stays valid. **Pitfall 13 (stale proof
  on rotation) is unreachable from our own producer** — this phase defends against non-marmot-ts peers. The roadmap's
  "validation-only" framing is correct and confirmed.
- **UPD-02 and UPD-03 are already enforced** by Phase 8's changed-leaf validator (see D-07/D-08).
- The genuinely new logic is **UPD-01** (identity equality against the prior leaf) and **UPD-04** (standalone Update
  admission, explicitly deferred to this phase by Phase 8 D-10).

**Not in this phase:**

- Founding create via Welcome (Phase 10, FOUND-01..05).
- Rust-signed interop fixtures, the exports snapshot, and the QA gate (Phase 11).
- Any actual signature-key rotation API. ts-mls has no mechanism to install a new MLS signature key during a
  self-update; the spec's proof-reuse rule makes "same proof carried forward" the correct common case.

</domain>

<decisions>
## Implementation Decisions

### Changed-leaf classification (Add vs Update) — the core of UPD-01

- **D-01:** Forward the commit's proposals and `committerLeafIndex` into `validateCommitAccountIdentityProofs`. Both
  are **already parameters of `validateCommitLegality`** (`integrity.ts:498`) — they are simply not passed through to
  the proof validator today. Classify every `diffChangedLeaves` entry into the three buckets MDK's
  `validate_staged_commit_account_identity_proofs` uses:
  - the leaf matches an **Add** proposal's KeyPackage leaf → treat as an Add: proof validity only, **no** prior-identity
    comparison (a new member in a freed slot legitimately has a different identity);
  - an **Update** proposal whose `senderLeafIndex` equals that leaf index → enforce identity equality against the
    parent tree's leaf at the same index;
  - the leaf index equals **`committerLeafIndex`** → the committer's update-path leaf: enforce identity equality.

  This keeps Phase 8's tree diff as the enumerator (D-02 stands — ts-mls still exposes no `StagedCommit`) while
  recovering the Add/Update distinction the diff alone cannot make.

  **Why this is required:** a tree diff cannot tell a replacement leaf from a freed-slot reuse. A commit that removes
  the member at index 3 and adds a new member into that slot is byte-indistinguishable from "leaf 3 changed its
  identity". Without the proposal list, UPD-01 would reject legitimate Remove+Add commits.

- **D-02:** A changed leaf matching **none** of the three buckets is a violation in its own right — **fail closed**.
  This matches the codebase's existing fail-closed convention (fork-recovery drops the edge, tree-fed convergence
  abandons the switch) and removes the bypass where an attacker evades UPD-01 by making a leaf unattributable.

- **D-03:** Where classification is **structurally impossible through no fault of the sender**, the outcome is
  **deferred, not rejected**. Two such paths exist and the planner must handle both:
  - `validateLegalityWithoutProposals` (`src/engine/fork-recovery.ts:164`), taken when `proposalsFromPublicCommit`
    returns `undefined` — a PrivateMessage commit, a non-member sender, or a proposal reference the parent snapshot no
    longer stages (`fork-recovery.ts:145`). Its own docstring says it runs "the `0x8009` profile and changed-leaf proof
    check" with no proposals at all.
  - Any seam passing `committerLeafIndex: undefined` — `withCapturedProposals.take()` returns
    `number | undefined` (`admin-policy.ts:410`), so `ingest.ts:824` and `group-engine.ts:2065` can both legitimately
    do this.

  **Spec backing:** `refs/marmot/foundation/errors.md` (lines 63-68) — a Commit whose authorization cannot be evaluated
  against a candidate parent "remains `deferred`"; only *failed* authorization is terminal `authorization_failed`.
  Deferring here is what the spec prescribes, not a convenience.

- **D-04:** Add a new `DeferredReason` literal (e.g. `unjudgeable_identity`) to `deferredReasons` in
  `src/core/inbound.ts:70`. This is a **one-line change**: `DeferredReason` is derived
  (`typeof deferredReasons[keyof typeof deferredReasons]`), `disposition.deferred(reason)` already accepts that type,
  `ingest-disposition.ts:18` passes `result.reason` straight through, and `src/audit/` has **no** normalization for
  deferred reasons — so unlike Phase 8's D-05 there is no audit union to extend.

  Retry is bounded by the **existing** pool limits: `maxSize` plus source-epoch expiry against `maxRewindCommits`.
  Accepted tradeoff: an unjudgeable commit is re-peeled on each sweep until it ages out, because
  `group-engine.ts:1841` already pools any `kind: "deferred"` result and the pool's retry trigger is re-peeling
  against new tree nodes, not re-deciding legality. No new retry mechanism.

### Rejection surface

- **D-05:** Report a replacement-leaf identity change with a **new** `AccountIdentityProofRejectReason` literal (e.g.
  `member-identity-changed`). **Do not reuse `identity-mismatch`** — it already means "the proof's signer does not
  match this leaf's own credential identity" (validator step 10, a single-leaf check). Conflating them would collapse
  a membership-model violation into a proof-binding error and make Pitfall 12's required test ("rejected *distinctly*
  from an invalid proof") impossible to write.

  Cost is again minimal: the union is consumed by reference (`src/engine/types.ts:10` → `proofReason?:` at `:186`;
  `group-engine.ts:56`), with no audit normalization.

- **D-06:** The violation keeps Phase 8's D-06 shape exactly — `reason: "account-identity-proof"`, plus `proofReason`
  and `leafIndex`. No new fields. `leafIndex` is not among the values `refs/marmot/foundation/errors.md` §Privacy
  (lines 122-125) forbids in diagnostics (account ids, group ids, message ids, relay URLs, pubkeys, payloads,
  ciphertext, plaintext, key material), and `detail` stays a fixed pubkey-free string. **Neither identity may appear
  in `detail`** — this is the single most tempting place in the phase to leak a pubkey.

### UPD-02 / UPD-03 — ratify, do not re-implement

- **D-07:** Add named UPD-02 and UPD-03 regression tests and **add no new validator code**. Both are already enforced
  by the Phase 8 changed-leaf path:
  - **UPD-02** (stale/reused proof): validator step 11 reconstructs the signing template from the leaf's *own*
    `signaturePublicKey`, so a proof bound to a different key fails verification.
  - **UPD-03** (`0x8009` stripped from a non-blank leaf): steps 5 and 6 throw `missing-support` / `missing-data`.
    Stripping the dictionary necessarily changes the leaf, which changes its signature, so `diffChangedLeaves` always
    surfaces it. Removal via `AppDataUpdate` is separately rejected by the Phase 7/8 leaf-only guard.

  Duplicating these as standalone checks would create two places to keep in sync — the trap Phase 7 D-12 warned about.

- **D-08:** **Do not invent a "stale proof" reason.** The 104-byte envelope is
  `signer_pubkey[32] ‖ created_at[8] ‖ signature[64]` and stores **no** MLS signature key — the key is a *signed
  input*, recoverable only by reconstructing the event. A stale proof is therefore cryptographically
  indistinguishable from a corrupt one; both correctly surface as `invalid-proof`. Reporting UPD-02 more precisely
  would require changing the wire format.

### UPD-04 — standalone Update admission

- **D-09:** Gate at **both** seams, mirroring exactly what Phase 8 D-09 did for Adds:
  - **Inbound:** `src/engine/admin-policy.ts`, the `incoming.kind === "proposal"` branch (`:288`). Both
    `senderLeafIndex` and `ratchetTree` are already in scope there, so no new plumbing is needed.
  - **Local:** `src/engine/group-engine.ts` `case "proposal"` (`:983`), beside the existing Add check.

  The local gate is **not optional**: `SendIntent` includes `{ kind: "proposal"; proposal: Proposal }`, which accepts
  any raw proposal including an Update, and neither the explicit Add branch nor `validatePreApplyProposals` inspects
  Updates today. A locally-built standalone Update currently bypasses every proof and identity check.

- **D-10:** If the Update's sender leaf cannot be resolved to a current member, **reject**. This matches MDK
  ("standalone Update proposal has no authenticated member sender") and the seam's own existing convention —
  `admin-policy.ts` already returns `"reject"` for an unresolvable self_remove sender (`:309`) and an undefined commit
  sender (`:324`). D-03's deferral rationale deliberately does **not** apply: pre-apply admission is
  branch-independent, so there is no candidate parent whose arrival could make the proposal judgeable later.

### Testing

- **D-11:** UPD-01 gets **pure-validator tests**, and the seam-parity gap is **documented explicitly** so its absence
  is never mistaken for an oversight.

  **Why parity is not reachable:** ts-mls's package root re-exports only *types* from `./leafNode.js` — `LeafNode`,
  `LeafNodeCommit`, `LeafNodeData`, `LeafNodeInfo*`, `LeafNodeKeyPackage`, `LeafNodeUpdate` (`ts-mls/src/index.ts:246-256`).
  `signLeafNodeCommit`, `signLeafNodeUpdate`, `leafNodeEncoder`, and `verifyLeafNodeSignature` are **not** exported,
  and CLAUDE.md forbids subpath imports (the vendor guard fails the build). A test therefore cannot hand-sign a forged
  LeafNode.

  A credential-swapped leaf spliced into a resulting tree **is** sufficient for the pure validator —
  `validateCommitAccountIdentityProofs` takes two `ClientState`s, the tree diff compares signature *bytes*, and
  `validateLeafAccountIdentityProof` never checks the MLS leaf signature. It is **not** sufficient at the seams:
  reaching ingest / fork-recovery / tree-fed requires surviving `processMessage`, which *does* verify leaf signatures,
  so an unsigned forged leaf would be rejected by ts-mls first and the test would pass **for the wrong reason** —
  exactly what the existing fixture-sanity test (`account-identity-proof-seams.test.ts:880`) exists to prevent.

  Phase 8's update-path forging technique (seat a forged member at epoch 1, then have them self-update, carrying the
  same bad proof forward re-signed — `seams.test.ts:1070`) **cannot** produce UPD-01's case, because ts-mls always
  copies `ownLeaf.credential` forward.

- **D-12:** Update `src/core/components/__tests__/integrity.test.ts:492` — "returns undefined for an honest
  self-update (**D-03: no prior-leaf identity comparison**)". It asserts by name the absence of the check this phase
  adds. It must keep passing (an honest self-update preserves identity) but its rationale comment is now wrong.

### Claude's Discretion

- **The tri-state return shape.** `validateCommitLegality` currently returns `CommitIntegrityViolation | undefined`
  and needs a third "undecidable" state to express D-03's deferral. Shape, naming, and how the five call sites
  (`fork-recovery.ts:251,301`, `group-engine.ts:1482,2065`, `ingest.ts:824`) map it to their existing dispositions are
  the planner's call. Note each seam already has a deferral-shaped outcome: fork-recovery returns
  `{ kind: "deferred", reason: "temporary_refusal" }`, the tree sweep returns `undefined` to keep the envelope pooled,
  and ingest can yield `DeferredIngestResult`.
- Exact literal spellings for the new deferred reason and the new proof reject reason (follow codebase conventions).
- How a changed leaf is matched to an Add proposal's KeyPackage leaf (signature-byte equality is the cheapest exact
  test and is already the diff's own primitive).
- Where the bucket-classification helper lives. It must be pure `src/core` and reachable from
  `validateCommitAccountIdentityProofs`.
- Test file layout: whether UPD-01/UPD-04 extend the existing suites or get a new file.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (normative)

- `refs/marmot/app-components/account-identity-proof-v2.md` §"Lifecycle, authorization, and removal" (lines 96-111) —
  the normative core of this phase: a component may be replaced "only as part of an MLS-authenticated replacement of
  its own LeafNode"; the replacement leaf's `BasicCredential.identity` **MUST** equal the prior account identity; "a
  change of account identity is not a self-update; it requires removing the old membership and separately authorizing
  a new membership"; and `0x8009` **MUST NOT** be removed from a non-blank member leaf.
- `refs/marmot/app-components/account-identity-proof-v2.md` §"Production and reuse" (line 83) — a proof may be reused
  "only while all signed inputs remain byte-for-byte identical"; a new signature key, ciphersuite, scheme, or account
  identity requires a new proof (UPD-02).
- `refs/marmot/foundation/errors.md` lines 63-68 — deferred vs terminal `authorization_failed`; the normative basis
  for D-03.
- `refs/marmot/foundation/errors.md` §"Privacy" lines 122-125 — diagnostics must avoid pubkeys, account ids, group
  ids, message ids, relay URLs, payloads, ciphertext, plaintext, key material (D-06).
- `refs/marmot/foundation/authorization-proofs.md` — the 104-byte envelope layout underpinning D-08.
- `refs/marmot/protocol-core/group-messaging.md` §"Commit authorization" (lines 44-52) — non-admins may commit only a
  self-update-only commit or a SelfRemove-only commit, and the two shapes may not be combined; standalone non-admin
  proposals are limited to SelfRemove in v1 core.
- `refs/marmot/protocol-core/joining.md` lines 62, 70 — a new member performs a self-update as soon as practical, so
  replacement leaves are common immediately after join.

### Rust reference

- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`:
  - `validate_leaf_account_identity_proof_for_member` (line 523) — the exact UPD-01 model: resolve the member id from
    the leaf, validate the proof, then compare against `expected_member_id`.
  - `validate_staged_commit_account_identity_proofs` (line 539) — the three-bucket structure D-01 mirrors: Adds,
    `update_proposals` (expected id from `member_id_of_sender`), and `update_path_leaf_node` (expected id = the
    committer).
  - `validate_standalone_proposal_account_identity_proof` (line 602) — the **Update branch** is UPD-04's model,
    including the reject-on-unresolvable-sender behaviour of D-10. Its docstring states the rationale: "a
    syntactically valid MLS proposal must not sit pending until a later Commit discovers that its leaf proof or
    profile is invalid."

### Upstream submodule check (2026-09-24)

**DONE at plan start — both submodules fast-forwarded and the pointer bump committed as `c2c17ac`
(`chore(refs): fast-forward marmot and mdk submodules`). Line numbers above are post-bump. Do not re-run the sweep.**

- `refs/marmot` was **2 commits behind**, now at `26fa6a6` (encrypted NIP-88 polls, group reports / dismissal labels /
  admin deletion). The diff touches `features/content-moderation.md`, `foundation/application-messages.md`,
  `foundation/registries.md`, `features/README.md`, `layout.md` — **none touch proof, leaf, or update semantics.**
- `refs/mdk` was **124 commits behind**, now at `4f1a906b`. Overwhelmingly marmot-app, transport, recovery and Android
  binding work.
- **Correction to the pre-bump note:** `account_identity_proof.rs` **is** touched upstream, by exactly one commit —
  `7bd34342` ("Adopt pinned rust-nostr fork in production transport"). The change is **cosmetic, not semantic**: its
  hunks are confined to the `AccountIdentityProofRequest` impl's import paths and the `mod tests` helper
  (`nostr::Keys` → `nostr::prelude::Keys`). **All three functions this phase models are outside every changed hunk** —
  their bodies are unchanged; only their line numbers shifted (536→523, 552→539, 615→602, corrected above).
  **No design decision in this document is affected.** The three-bucket model of D-01 and the reject-on-unresolvable-sender
  behaviour of D-10 both still match the reference exactly.

### Prior phases

- `.planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-CONTEXT.md` — D-01/D-02 (delta
  validation via tree diff), **D-03 (proof validity only; identity equality explicitly deferred to this phase)**,
  D-05/D-06 (reason union and violation shape), **D-10 (standalone Update admission deferred to UPD-04)**.
- `.planning/phases/08-.../08-VERIFICATION.md` — Phase 8 passed 5/5; the seam chokepoint this phase extends is
  verified working.
- `.planning/phases/07-account-identity-proof-component-0x8009-legacy-clean-cut/07-CONTEXT.md` — D-13 (throw model and
  reason union), D-16 (KeyPackage vs group ciphersuite).
- `.planning/phases/06-shared-authorization-proof-envelope-primitive/06-CONTEXT.md` — envelope layout and error model.

### Planning / research

- `.planning/REQUIREMENTS.md` — UPD-01..04 (lines 53-56).
- `.planning/research/PITFALLS.md` **Pitfall 12** (identity change treated as an ordinary self-update) and
  **Pitfall 13** (stale proof reused across a key rotation — confirmed unreachable from our own producer, see
  `<domain>`).
- `.planning/research/PITFALLS.md` **Pitfall 11** (seam asymmetry, mdk#707) — the defect class D-02/D-03 guard against.
- `.planning/research/SUMMARY.md` §"Phase 9" (lines 178-188) and the open question at lines 270-273 (no ts-mls
  identity-rotating replacement-leaf path; resolved here as a documented limitation, not a fix).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/core/components/integrity.ts`:
  - `validateCommitAccountIdentityProofs` (`:361`) — the extension point; currently takes only
    `{ parentState, resultingState }`.
  - `validateCommitLegality` (`:498`) — **already receives `proposals` and `committerLeafIndex`**; D-01 only needs to
    forward them.
  - `validateAddProposalAccountIdentityProofs` (`:435`) — the structural template for UPD-04's Update-branch sibling.
- `src/core/components/tree-diff.ts` `diffChangedLeaves` — returns `{ leafIndex, leaf }`. **Must also surface the
  parent leaf** (or the caller must re-read `parentTree[leafIndex * 2]`) for D-01's comparison; it currently discards
  it. `leafIndex` is the true MLS index, not the member-enumeration index.
- `src/core/credential.ts` `getCredentialPubkey` (`:48`) and ts-mls's `getCredentialFromLeafIndex` (exported from the
  package root) — the identity-equality primitives, already used together in `admin-policy.ts:311-316`.
- `src/core/components/account-identity-proof.ts` `validateLeafAccountIdentityProof` — unchanged; still the
  proof-validity check for every bucket.
- `src/core/inbound.ts` `deferredReasons` (`:70`) / `disposition.deferred` (`:108`) — D-04.
- `src/__tests__/helpers/account-identity-proof-fixtures.ts` — `forgeKeyPackage({ proof: "missing" | "tampered" })`.
  **Neither mode produces UPD-01's case**; a new credential-swap fixture is needed (D-11).

### Established Patterns

- Seam dispositions are fixed per seam and must not drift: send throws `CommitLegalityError`
  (`group-engine.ts` `#assertStagedCommitLegal`), inbound yields `rejected` (`ingest.ts:824`), replay drops the edge
  (`fork-recovery.ts`), tree-fed convergence fails closed (`group-engine.ts` `#treeResolution`).
- `validateCommitLegality` is **non-throwing** — fork-recovery and tree re-convergence call it unwrapped. Any new
  validator throw must be caught and mapped.
- D-07 ordering inside the adapter is fixed: component-integrity → profile/proof → disband-legality →
  admin-leaf coupling.
- Reason literals are unions consumed by reference; audit reasons are normalized to underscores where audit
  normalization exists (it does not, for either union this phase touches).
- `withCapturedProposals` is a pure side channel — **no validation logic may go inside it** (Pitfall 1).

### Integration Points

- `src/core/components/integrity.ts` — D-01/D-02/D-05/D-06 and the tri-state return.
- `src/core/components/tree-diff.ts` — expose the prior leaf (D-01).
- `src/core/inbound.ts` — the new deferred reason (D-04).
- `src/core/components/account-identity-proof.ts` — the new reject reason (D-05).
- `src/engine/admin-policy.ts` `:288` — UPD-04 inbound gate (D-09).
- `src/engine/group-engine.ts` `:983` — UPD-04 local gate (D-09); `:1482`, `:2065` — tri-state mapping.
- `src/engine/fork-recovery.ts` `:164` (`validateLegalityWithoutProposals`), `:251`, `:301` — D-03's primary path.
- `src/engine/ingest.ts` `:824` — tri-state mapping to `DeferredIngestResult`.
- Tests: `src/core/components/__tests__/integrity.test.ts` (incl. `:492`, D-12),
  `src/core/components/__tests__/tree-diff.test.ts`, `src/engine/__tests__/account-identity-proof-seams.test.ts`,
  `src/engine/__tests__/standalone-add-admission.test.ts` (the shape UPD-04's tests should mirror),
  `src/__tests__/helpers/account-identity-proof-fixtures.ts`.

</code_context>

<specifics>
## Specific Ideas

- UPD-01's positive control matters as much as the negative: an honest self-update (identity preserved, leaf re-signed)
  must still return no violation — that is `integrity.test.ts:492`, which must keep passing.
- The Remove+Add-into-a-freed-slot commit is the regression test that proves D-01 actually works. Without bucket
  classification it is a false positive; it should fail without the fix and pass with it.
- UPD-04's tests should mirror `standalone-add-admission.test.ts`'s five-case shape: raw local proposal intent, raw
  local commit, inbound standalone rejected, inbound standalone valid still staged, and the inbound-commit labelling
  case.
- UPD-02's test should use a genuinely *stale* proof (validly signed over a different signature key), not a tampered
  one, and assert it surfaces as `invalid-proof` — documenting D-08's indistinguishability rather than hiding it.
- Phase 8's review cycle (`08-REVIEW-FIX.md`, WR-01..WR-07) suggests budgeting a review-fix pass here too; WR-07 in
  particular was "make the regression rows fail without the fix", which is exactly the bar for D-01's tests.

</specifics>

<deferred>
## Deferred Ideas

- **Exporting `signLeafNodeCommit` / `signLeafNodeUpdate` from the ts-mls fork** to make a wire-valid
  identity-changing commit constructible, unlocking full 4-seam parity for UPD-01. Deliberately not taken now (D-11):
  it is a fork API change plus rebuild and exports-snapshot churn. Revisit if Phase 11's QA gate wants the parity row.
- Any signature-key rotation / remove-and-re-add convenience API. Out of scope for v2.0 (roadmap: "no new
  key-rotation API"); `SUMMARY.md` lines 270-273 catalogues it as a documented limitation.
- A distinct "stale proof" reject reason — impossible without a wire-format change (D-08).
- Tightening the pool so a permanently-unjudgeable commit is not re-peeled each sweep (D-04 accepts the waste; the
  entry ages out on the rollback horizon).

</deferred>

---

*Phase: 09-self-update-replacement-leaf-identity-binding*
*Context gathered: 2026-09-24*
