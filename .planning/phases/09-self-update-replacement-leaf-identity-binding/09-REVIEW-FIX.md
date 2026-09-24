---
phase: 09-self-update-replacement-leaf-identity-binding
fixed_at: 2026-09-24T13:51:00Z
review_path: .planning/phases/09-self-update-replacement-leaf-identity-binding/09-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 9: Code Review Fix Report

**Fixed at:** 2026-09-24T13:51:00Z
**Source review:** `.planning/phases/09-self-update-replacement-leaf-identity-binding/09-REVIEW.md`
**Iteration:** 1

**Summary:**

- Findings in scope: 6 (CR-01, WR-01, WR-02, WR-03, WR-04, and IN-03 promoted by the orchestrator)
- Fixed: 6
- Skipped: 0

**Verification (final state, all five commits applied, run in the main repo):**

- `tsc -b tsconfig.build.json` — exit 0
- `vitest run` — **111 files / 1250 tests passing**
  (baseline was 111 / 1249; the +1 is the IN-03 positive control added below)
- `prettier --check .` — "All matched files use Prettier code style!"

Every commit was verified individually with compile + targeted tests + the full
suite before being made; no commit was created on a red tree.

**Disclosure — one unreproduced test failure.** The first full-suite run in the
main repo after the fast-forward reported `1 failed | 1249 passed`. It did not
reproduce: the suite has since run green **11 consecutive times** in the main
repo (1250/1250 each), on top of 4 green runs in the worktree — 1 failing run
out of roughly 15 total.

I could not identify the failing test: that run's output was truncated by a
`tail -6` and the detail is unrecoverable. I am reporting it rather than
omitting it.

Assessment (not proof): most likely pre-existing non-determinism. 14 test files
use `setTimeout` / `Date.now` / raw promise scheduling, including the async
integration suites. None of the five changes introduce timers, randomness,
ordering dependence, or async scheduling — all five are pure classification and
validation logic on already-materialized state. Submodules were also ruled out
as a cause: `refs/marmot`, `refs/mdk` and `ts-mls` all match the recorded HEAD
pointers exactly, identical to the worktree. **A reviewer should keep an eye out
for an intermittent failure; I cannot positively prove it is unrelated.**

> **Environment note.** Work ran in an isolated git worktree. `git worktree add`
> does not populate submodules, so `refs/mdk` and `refs/marmot` were initialized
> with `git submodule update --init`, which checks out the *recorded* commits.
> No submodule pointer (`refs/mdk`, `refs/marmot`, `ts-mls`) appears in any
> commit — each commit stages only explicitly named source paths.

---

## Fixed Issues

### CR-01: `validateLegalityWithoutProposals` could never return `legal`

**Files modified:** `src/engine/fork-recovery.ts`, `src/core/components/leaf-replacement.ts`, `src/engine/__tests__/known-state-fallback-legality.test.ts`
**Commit:** `8bcfbd2`
**Status:** fixed — **requires human verification** (convergence semantics)

Confirmed the finding by reading the code: the helper called
`validateCommitAccountIdentityProofs` with no `classification`, so
`classifyChangedLeaf` returned `undecidable` for every changed leaf, and both
`resolveCandidateParent` call sites mapped `undecidable` to a
`temporary_refusal` deferral that no future bytes could ever clear.

**The review's suggested patch was NOT applied literally.** It proposed passing
`classification: { proposals: [], committerLeafIndex }`. With an empty proposal
list, a legitimately *added* member's leaf matches no Add, no Update sender and
not the committer, so `classifyChangedLeaf` would have returned
`unattributable` — a **terminal violation**. That would have converted "our own
legal Add commit is deferred forever" into "our own legal Add commit is
permanently rejected": strictly worse, since a terminal verdict is
unrecoverable. Adapted instead:

1. Added `committerOf(message)` in `fork-recovery.ts`, reading
   `content.sender.leafIndex` — the committer survives an unresolvable
   `ProposalRef` even when the proposal rebuild does not (the review's own
   observation).
2. Added an explicit `proposalsComplete?: boolean` (default `true`) to
   `ChangedLeafClassificationInput`. Step 5 of `classifyChangedLeaf` now returns
   `undecidable` when the committer is unknown **or** the list is incomplete,
   and reserves the terminal `unattributable` for a genuinely complete picture.
   This matches the literal's own documented contract ("full classification
   information *was* available"), so it is a correctness fix, not a loosening.
3. The helper now threads the committer in with `proposalsComplete: false`, so
   the committer's own update-path leaf **is** classified and its replacement
   identity **is** compared against its prior occupant — strictly more checking
   than the pre-Phase-9 contract, not less.
4. The residual `undecidable` is decided as `legal` (the review's option (a),
   restoring the documented WR-03 contract) rather than propagated.

**Constraints honoured.** No check was weakened: profile drift, changed-leaf
proof validity, component integrity rules 1–2, the `0x8009` leaf-only guard,
admin-leaf coupling, and now the committer's identity binding all still run. A
definite `violation` still returns immediately, and admin-leaf coupling is still
evaluated *before* the residual is discarded — preserving the
non-short-circuiting precedence that plan 09-02 established (this is exactly
what keeps the pre-existing rejection test green).

**Why this is flagged for human verification:** it converts a deferral into an
accept on a convergence path. Tests and the type checker cannot prove that is
semantically right; a reviewer should confirm that accepting a recorded child
after every proposal-independent check is the intended contract.

### IN-03: no positive control covered the regressed path

**Files modified:** `src/engine/__tests__/known-state-fallback-legality.test.ts`
**Commit:** `8bcfbd2` (same atomic commit as CR-01, as instructed)
**Status:** fixed

Added the inverse case: a benign, proposal-free self-update sent as a
**PrivateMessage** (so neither proposals nor a committer index are recoverable —
the exact CR-01 repro) must resolve to `resolution.kind === "resolved"`.

This is a genuine regression guard, not a tautology: before the CR-01 fix that
path could only return `violation` or `undecidable`, and `undecidable` mapped to
`deferred`, so the assertion would necessarily have failed. The pre-existing
rejecting case still passes, confirming a definite violation still outranks.

### WR-01: staged-proposal pruning was not extended to Updates

**Files modified:** `src/engine/group-engine.ts`
**Commit:** `2829c37`
**Status:** fixed

`withoutInadmissibleStagedProposals` now also filters on
`validateUpdateProposalAccountIdentityProofs(..., state.ratchetTree, ...)`,
mirroring the standalone Update-admission gate. Confirmed the deadlock premise
is real: Phase 9 made a proof-invalid staged Update commit-blocking *post-apply*
in `#assertStagedCommitLegal` while `createCommit` kept bundling it by
reference, so every `send({kind:"commit"})`/`send({kind:"selfUpdate"})` would
throw for the rest of an epoch that only a commit could end.

*Caveat:* covered only indirectly. The admission tests assert exact
`unappliedProposals` counts (so over-pruning would have surfaced), but there is
no dedicated regression test reproducing the deadlock itself.

### WR-02: a structurally unattributable inbound commit was deferred forever

**Files modified:** `src/engine/ingest.ts`
**Commit:** `fca0049`
**Status:** fixed — **requires human verification** (terminal-verdict semantics)

The ingest seam now rejects terminally (`account-identity-proof` /
`unattributable-leaf`, with `dedup.remember`) instead of deferring.

**Guarded exactly as the constraints require:** the terminal path fires only
when `capturedCommit.committerLeafIndex === undefined` — i.e. classification
*was* genuinely captured (the ts-mls callback fired during the `processMessage`
that returned `newState`, so `capturedCommit.proposals` is the complete list)
and the only missing piece is a non-`member` sender, which no future bytes can
supply. When a committer *is* known, the deferral idiom is retained unchanged.

*Caveat:* this branch had **no test coverage before or after**. Constructing a
commit with a non-member sender that still processes to `newState` requires an
external-commit fixture the suite has no helper for, and I judged a fragile
hand-rolled fixture worse than none. A reviewer should confirm Marmot never
legitimately accepts non-member-sender commits — if it does, those would now be
rejected rather than (as today) deferred forever, which pins `convergenceStatus`
at `Resolving` and blocks all outbound work regardless.

### WR-03: documented non-throwing contract violated by `getAppDataDictionary`

**Files modified:** `src/engine/fork-recovery.ts`, `src/core/components/integrity.ts`
**Commit:** `460301a`
**Status:** fixed

Both unguarded calls in `validateLegalityWithoutProposals` are now wrapped and
mapped to `{ reason: "component-integrity", detail: "app_data_dictionary did not
decode" }`, matching the `getAppComponents` handling directly above them.

Also guarded the two sibling calls at the head of `validateAppComponentIntegrity`
(`integrity.ts:201-202`), which the finding's **File:** line cites. Same defect
class: that validator is documented as typed and non-throwing, and the
convergence/replay seams reach it through `validateCommitLegality` without
wrapping, so an escaping throw aborted the ingest generator instead of producing
a verdict.

### WR-04: the `add` bucket suppressed the identity comparison on signature bytes alone

**Files modified:** `src/core/components/leaf-replacement.ts`
**Commit:** `273e0d1`
**Status:** fixed

The Add bucket now requires the slot to have been genuinely freed —
`changed.parentLeaf === undefined`, or this commit carries a Remove of
`changed.leafIndex` — before matching on signature bytes. An Add matching into a
still-occupied, un-removed slot falls through to `unattributable`/`undecidable`:
fail closed.

Unreachable for a ts-mls-computed resulting state (an Add is only ever placed at
a blank leaf), so no legitimate commit changes disposition; it is reachable only
on the two paths that feed a *persisted* resulting state into the classifier.
Verified against the existing `integrity.test.ts` Test 4, which builds a real
Remove+Add commit that provably reuses the freed slot — it still passes.

---

## Out of Scope (not attempted)

IN-01, IN-02 and IN-04 were excluded by the orchestrator's scope and were not
touched.

## Observations for the phase owner

- **A sibling of WR-02 remains.** `resolveCandidateParent`'s *replay* branch
  (`fork-recovery.ts`) maps `undecidable` to `deferred` using the same
  `capturedCommit` whose `committerLeafIndex` can be `undefined`. WR-02 cites
  only `ingest.ts`, so I left it alone rather than widen scope, but it is the
  same defect class the phase exists to close.
- **`undecidable` is now a narrow state.** After these fixes it arises only from
  an incomplete classification (currently just `validateLegalityWithoutProposals`,
  which decides it locally) or an unknown committer at ingest (now terminal).
  Worth confirming the tri-state still earns its keep at the seams that branch
  on it.

---

_Fixed: 2026-09-24T13:51:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
