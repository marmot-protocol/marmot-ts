# Phase 9 — Deferred / Accepted Items

Items surfaced during Phase 9 execution and code review that were deliberately **not** closed in
this phase. Recorded per the convention in `PROJECT.md` ("Accepted/deferred review items are
recorded in the phase `deferred-items.md` files").

Phase 9 code review (`09-REVIEW.md`) found 1 Critical + 4 Warning + 4 Info. The Critical and all
four Warnings were fixed (`09-REVIEW-FIX.md`, commits `460301a`, `273e0d1`, `8bcfbd2`, `2829c37`,
`fca0049`). The items below are what remains.

## Open code items

### D-09-01: `resolveCandidateParent` replay branch still defers a non-member-sender commit forever

**Severity:** Warning (sibling of the fixed WR-02)
**Location:** `src/engine/fork-recovery.ts:374-375` and `:425-426`

WR-02 was fixed at the **ingest** seam (`src/engine/ingest.ts`), converting a permanently-deferred
structurally-unattributable commit into a terminal reject. The *replay* branch of
`resolveCandidateParent` still maps `undecidable → { kind: "deferred", reason: "temporary_refusal" }`
off the same `capturedCommit`, whose `committerLeafIndex` is `undefined` for any non-member sender
(ts-mls sets it from `getSenderLeafNodeIndex`, which returns `undefined` for every non-`member`
sender type). Proposals *are* captured on this path, so `proposalsComplete` is `true`; the
`undecidable` therefore comes solely from the absent committer index and can never clear.

The code-review finding cited only `ingest.ts`, and the fixer correctly declined to widen scope.

**Why it is low-urgency:** adopted v1 Marmot defines no legitimate non-member-sender commit path
(see D-09-04), so reaching this branch already implies a malformed or out-of-spec commit. The
consequence is a stuck deferral rather than acceptance of anything invalid — it fails closed on
authorization, open on liveness.

**Fix shape:** mirror the `ingest.ts` treatment — treat "proposals captured AND committer
unattributable" as terminal at this seam too.

### D-09-02: IN-01 — inconsistent leaf-index coercion inside the classifier

**Severity:** Info — out of `--fix` scope (Critical + Warning only)
**Location:** `src/core/components/leaf-replacement.ts:95` vs `:103-106`

The Update branch coerces (`Number(item.senderLeafIndex) === changed.leafIndex`); the committer
branch compares the branded value raw (`input.committerLeafIndex === changed.leafIndex`). Safe
today because `LeafIndex = Brand<number, "LeafIndex">`, but the two callers feeding this field
differ — `admin-policy.ts:428` passes ts-mls's branded value unconverted, `fork-recovery.ts:133`
coerces. If that type ever widens, a committer's own update-path leaf silently reclassifies as
`unattributable`, terminally rejecting every honest commit.

### D-09-03: IN-02 — `undecidable` reported on the send path with an inverted reason literal

**Severity:** Info — out of `--fix` scope
**Location:** `src/engine/group-engine.ts:1530-1535`

`#assertStagedCommitLegal` maps `undecidable` to `proofReason: "unattributable-leaf"`, but that
literal is documented (`account-identity-proof.ts:105-108`, `integrity.ts:406-407`) as meaning
full classification information *was* available and the leaf is attributable to nobody — the
opposite of `undecidable`. Callers branching on `proofReason` cannot distinguish the two.

Note: the CR-01 fix introduced `ChangedLeafClassificationInput.proposalsComplete`, which makes
this distinction representable. A follow-up could add a distinct `unclassifiable-leaf` literal.

### D-09-04 (informational, no action): non-member-sender commits are invalid in adopted v1

Recorded because it is the premise the WR-02 fix rests on, and it should not have to be
re-derived later.

- `refs/marmot/protocol-core/group-messaging.md:53` — "adopted v1 defines no non-admin
  `new_member_commit` External Commit path."
- `refs/marmot/app-components/multi-device-join-authorization-v1.md:10` — "adopted membership
  authorization continues to reject this External Commit shape."
- `refs/marmot/features/multi-device.md:22` — an External Commit so shaped "remains invalid until
  this feature becomes normative."

External Commits become legitimate only under the **draft** multi-device feature (MIP-06), which
is catalog-only for this milestone. `src/` has no `senderTypes.new_member_commit` handling.
Phase 10 (Founding Group Creation via **Welcome**) does not depend on external commits.

**If multi-device (MDEV-01) is ever taken on, revisit WR-02's terminal reject and D-09-01
together** — both would become wrong.

## Test-coverage debt

### D-09-05: WR-02's terminal-reject branch has no test coverage

**Location:** `src/engine/ingest.ts` (the fixed WR-02 branch)

Neither before nor after the fix. Constructing a non-member-sender commit that still processes to
`newState` needs an external-commit fixture the suite lacks; the fixer judged a fragile
hand-rolled one worse than none, and recorded it rather than faking coverage. Agreed — but the
branch is currently asserted only by reasoning, not by a test.

### D-09-06: IN-04 — dead destructured fixtures in the new tests

**Severity:** Info — out of `--fix` scope
**Location:** `src/core/components/__tests__/integrity.test.ts:589, 614, 739, 1004, 1046, 1134, 1161`;
`src/engine/__tests__/standalone-update-admission.test.ts:253`

Values destructured only to be discarded with `void impl;` / `void adminPubkey;` to satisfy
`noUnusedLocals` — template residue that obscures which fixture fields each test actually uses.

## Unresolved observation

### D-09-07: one unreproduced test failure during the fix pass

During the code-review fix pass, the first full-suite run after merging reported
`1 failed | 1249 passed`. It did **not** reproduce across 11 consecutive runs by the fixer, nor
across 3 further runs by the orchestrator (14 consecutive green at 1250/1250). The failing test
was never identified — that run's output was truncated by a `tail -6` and is unrecoverable.

Ruled out: submodule drift (all three match HEAD exactly). None of the Phase 9 fix commits touch
timers, randomness, or ordering.

**Status:** most likely pre-existing non-determinism, but *not proven unrelated*. Recorded rather
than omitted. If an unexplained single-test failure appears in CI, start here and capture full
output — do not `tail` a suite run whose failure you may need to diagnose.

## Requires confirmation from the phase owner

### D-09-08: CR-01 converts a permanent deferral into an accept on a convergence path

**Location:** `src/engine/fork-recovery.ts:308-312`

`validateLegalityWithoutProposals` now returns `legal` once every proposal-independent check has
run and none objected. This restores the helper's documented pre-Phase-9 WR-03 contract ("run
every legality check that does not need those proposals"), and the alternative — a deferral no
future protocol bytes can ever clear — silently dropped our own canonical branch from convergence
candidacy. Tests cannot prove this is the intended protocol contract; it is a design judgment
worth an explicit owner sign-off.
