# Phase 9: Self-Update / Replacement-Leaf Identity Binding - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-24
**Phase:** 09-self-update-replacement-leaf-identity-binding
**Areas discussed:** Add-vs-Update disambiguation, Rejection surface for identity change, UPD-02/UPD-03 scope, UPD-04 standalone Update admission

---

## Add-vs-Update disambiguation

### How to tell a replacement leaf from a freed-slot reuse

| Option | Description | Selected |
|--------|-------------|----------|
| Classify each changed leaf against the proposal list | Pass proposals + `committerLeafIndex` into the proof validator; three buckets mirroring MDK. Nothing new to plumb. | ✓ |
| Prior-leaf-exists AND no Remove for that index | Purely structural; infers intent from tree shape. | |
| Full MDK-style proposal walk | Closest to the reference but reverses Phase 8 D-02. | |

**User's choice:** Classify each changed leaf against the proposal list
**Notes:** `validateCommitLegality` already receives both `proposals` and `committerLeafIndex` — they are simply not forwarded to `validateCommitAccountIdentityProofs`. Keeps the tree diff as enumerator while recovering the Add/Update distinction it cannot make alone.

### An unclassifiable changed leaf

| Option | Description | Selected |
|--------|-------------|----------|
| Fail closed — reject the commit | Unclassifiable is a violation; removes the bypass. | ✓ |
| Treat as Update — enforce equality | Safe without a new reason, but misreports legitimate freed-slot Adds. | |
| Treat as Add — skip the check | Lowest false-positive risk, but is itself the bypass. | |

**User's choice:** Fail closed — reject the commit
**Notes:** Matches the codebase's existing fail-closed convention. Surfaced a follow-on risk that drove the next question.

### Paths where classification is genuinely impossible

| Option | Description | Selected |
|--------|-------------|----------|
| Defer — unjudgeable, not illegal | Reuse the deferral disposition; the commit is not proven illegal. | ✓ |
| Degrade to proof-validity only, documented | Simple, but is the mdk#707 seam-asymmetry class. | |
| Fail closed here too — hard reject | Maximum symmetry; risks stranding convergence. | |

**User's choice:** Defer — unjudgeable, not illegal
**Notes:** Two such paths were identified in the scout: `validateLegalityWithoutProposals` (fork-recovery, when proposals cannot be rebuilt) and any seam passing `committerLeafIndex: undefined`. `foundation/errors.md:63-68` turned out to prescribe exactly this, so the choice has direct normative backing.

### Labelling the deferral

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `missing_parent` | No new literal; slightly overloads the name. | |
| New reason, e.g. `unjudgeable_identity` | Honest and diagnosable; costs a literal. | ✓ |
| Let Claude decide | Defer to planning. | |

**User's choice:** New reason, e.g. `unjudgeable_identity`
**Notes:** Investigated the cost first — the literal propagates by derivation and `src/audit/` has no deferred-reason normalization, so it is a one-line change, far cheaper than Phase 8's D-05 precedent.

### Bounding the retry

| Option | Description | Selected |
|--------|-------------|----------|
| Rely on existing pool bounds | Ages out on the rollback horizon; some wasted re-peel work. | ✓ |
| Mark tried once and stop re-deciding | Avoids the spin; adds state the pool was not designed for. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Rely on existing pool bounds
**Notes:** Accepted tradeoff — the pool retries by re-peeling against new tree nodes, not by re-deciding legality, so an unjudgeable commit re-peels each sweep until it expires.

---

## Rejection surface for identity change

### How to report an identity change

| Option | Description | Selected |
|--------|-------------|----------|
| New literal, e.g. `member-identity-changed` | Keeps two distinct spec failures distinct. | ✓ |
| Reuse `identity-mismatch` | No union change, but collapses a membership violation into a proof error. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** New literal, e.g. `member-identity-changed`
**Notes:** `identity-mismatch` is already taken for "the proof's signer does not match this leaf's own credential" (validator step 10). Reusing it would make Pitfall 12's required test — rejected *distinctly* from an invalid proof — impossible to write.

### What the violation carries

| Option | Description | Selected |
|--------|-------------|----------|
| Reason + `proofReason` + `leafIndex` only | Phase 8 D-06 shape unchanged; pubkey-free. | ✓ |
| Also add the prior leaf's index | Richer for debugging; usually redundant for in-place replacement. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Reason + `proofReason` + `leafIndex` only
**Notes:** `errors.md` §Privacy forbids pubkeys and account ids in diagnostics; `leafIndex` is not in that list. `detail` must stay a fixed pubkey-free string — this is the most tempting place in the phase to leak an identity.

---

## UPD-02 / UPD-03 scope

| Option | Description | Selected |
|--------|-------------|----------|
| Ratify with tests; add no new checks | Both already enforced by Phase 8's changed-leaf path. | ✓ |
| Add explicit dedicated checks anyway | Readable and traceable, but duplicates logic. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Ratify with tests; add no new checks
**Notes:** Established during the scout that UPD-02 is caught by validator step 11 (template reconstructed from the leaf's own signature key) and UPD-03 by steps 5/6. A significant finding shaped this: the 104-byte envelope stores no MLS signature key, so a stale proof is cryptographically indistinguishable from a corrupt one — both are `invalid-proof`, and no "stale" reason is possible without a wire-format change.

---

## UPD-01 test fidelity

| Option | Description | Selected |
|--------|-------------|----------|
| Pure-validator tests; document the seam-parity gap | Full logic coverage, no fork change. | ✓ |
| Export signing helpers from our ts-mls fork, then full 4-seam parity | True parity; costs a fork API change and snapshot churn. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Pure-validator tests now; document the seam-parity gap
**Notes:** ts-mls's package root re-exports only *types* from `./leafNode.js` — no `signLeafNodeCommit`/`signLeafNodeUpdate` — and CLAUDE.md forbids subpath imports. A forged leaf can be spliced for the pure validator but cannot survive `processMessage`'s leaf-signature check, so a seam test would pass for the wrong reason. The fork-export path was noted as a deferred idea since the fork is ours.

---

## UPD-04 standalone Update admission

### Where the gate goes

| Option | Description | Selected |
|--------|-------------|----------|
| Both seams, mirroring D-09's Add treatment | Inbound admin-policy + local propose path. | ✓ |
| Inbound only | Matches MDK; leaves the local hole open. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Both seams, mirroring D-09's Add treatment
**Notes:** Confirmed the local hole is real — `SendIntent` accepts any raw `Proposal` including an Update, and neither the explicit Add branch nor `validatePreApplyProposals` inspects Updates today.

### Unresolvable sender leaf

| Option | Description | Selected |
|--------|-------------|----------|
| Reject | Matches MDK and the seam's existing convention. | ✓ |
| Defer, consistent with Area 1 | More uniform, but a standalone proposal has no parent to wait for. | |
| Let Claude decide | Defer to planning. | |

**User's choice:** Reject
**Notes:** `admin-policy.ts` already returns `"reject"` for an unresolvable self_remove sender and an undefined commit sender. Pre-apply admission is branch-independent, so Area 1's deferral rationale does not transfer.

---

## Claude's Discretion

- The tri-state shape for `validateCommitLegality`'s return, and how each of the five call sites maps it onto its existing disposition.
- Exact literal spellings for the new deferred reason and the new proof reject reason.
- How a changed leaf is matched to an Add proposal's KeyPackage leaf.
- Where the bucket-classification helper lives (must be pure `src/core`).
- Test file layout — extend existing suites or add a new file.

## Deferred Ideas

- Exporting `signLeafNodeCommit` / `signLeafNodeUpdate` from the ts-mls fork to unlock full 4-seam parity for UPD-01.
- Any signature-key rotation or remove-and-re-add convenience API (out of scope for v2.0).
- A distinct "stale proof" reject reason — impossible without a wire-format change.
- Tightening the pool so a permanently-unjudgeable commit is not re-peeled each sweep.
