---
phase: 03-commit-integrity-convergence-parity
plan: 03
subsystem: convergence
tags: [mls, ts-mls, fork-recovery, convergence, vitest, own-commit-protection]

# Dependency graph
requires:
  - phase: 03-01
    provides: pure commit-legality validators (validateAppComponentIntegrity, validateAdminLeafCoupling) — not directly consumed here but establishes the phase's validation-seam pattern
  - phase: 03-02
    provides: widened IngestResult vocabulary and StateNotification ledger — not directly consumed here
provides:
  - Native Vitest coverage for CONV-04's two D-16 properties (own-commit-not-rolled-back + dual-ordering), run against the live MarmotGroupEngine/ForkRecovery
  - A verify-first finding that ForkRecovery#buildBranches could not replay a device's own already-applied commit, and a minimal, scoped fix for it
affects: [phase-04-conformance-parity]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Verify-first testing (D-15): write native Vitest tests for a suspected-but-unconfirmed property before touching production code; let the test's actual pass/fail decide whether a fix is warranted"
    - "Reuse already-known retained state instead of replaying a commit through processMessage when replay is structurally impossible (own-authored commit reprocessing)"

key-files:
  created:
    - src/engine/__tests__/convergence-parity.test.ts
  modified:
    - src/engine/fork-recovery.ts

key-decisions:
  - "CONV-04 verify-first found Assumption A1 did not hold as originally stated: ForkRecovery#buildBranches's uniform processMessage replay cannot reprocess a device's own already-applied commit (RFC 9420: an UpdatePath never encrypts a path secret to the committer's own leaf), so a same-epoch sibling won unconditionally until fixed"
  - "Fix is scoped narrowly to ForkRecovery: resolveFork now supplies ForkRecovery#buildBranches a knownNextStates map (commit digest -> already-retained resulting state, cloned) for commits in `ours`; explore() uses that state directly instead of calling processMessage for exactly those commits. No PrevalidatedOwnCommits-style stamping, no committer-priority bookkeeping, no change to tree-convergence.ts or core/convergence.ts"
  - "tree-convergence.ts's buildTreeBranchSet (used by the tree-fed reconvergence pass on load/restart) does not share this bug — it is purely structural, reading already-recorded commitDigest/epoch metadata rather than replaying via processMessage, so it needed no change"
  - "CONV-04 marked complete in REQUIREMENTS.md — both D-16 properties are now verified end-to-end against the live engine, not stubbed"

requirements-completed: [CONV-04]

coverage:
  - id: D1
    description: "A device's own published+confirmed commit at epoch N remains the live tip after ingesting a same-epoch sibling that loses the deterministic ordering rule (D-16 property 1)"
    requirement: "CONV-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/convergence-parity.test.ts#keeps a device's own published+confirmed commit as the live tip when a losing same-epoch sibling arrives"
        status: pass
    human_judgment: false
  - id: D2
    description: "The own commit is materializable as a convergence candidate: a winning same-epoch sibling produces a real rewind, not a skip for lack of a replayable own-commit branch"
    requirement: "CONV-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/convergence-parity.test.ts#materializes its own confirmed commit as a convergence candidate when a winning same-epoch sibling arrives"
        status: pass
    human_judgment: false
  - id: D3
    description: "Dual-ordering: two engine instances fed the same competing commits in opposite delivery order select the same canonical branch (D-16 property 2)"
    requirement: "CONV-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/convergence-parity.test.ts#selects the same branch when two engines receive the same competing commits in opposite delivery order"
        status: pass
    human_judgment: false

# Metrics
duration: 50min
completed: 2026-08-04
status: complete
---

# Phase 3 Plan 3: CONV-04 Convergence Parity Summary

**Verify-first testing found ForkRecovery could not replay a device's own already-applied commit (own branch always lost the fork-candidate race by omission); fixed narrowly by reusing RetainedHistoryStore's already-known resulting state instead of replaying through processMessage.**

## Performance

- **Duration:** ~50 min (across two work sessions; an API transport interruption occurred mid-run and work resumed from the last committed state)
- **Tasks:** 3 (Task 1: analysis + harness; Task 2: D-16 assertions; Task 3: conditional fix)
- **Files modified:** 2 (1 new test file, 1 production file)

## CONV-04 Verdict

**Assumption A1 — "marmot-ts needs no MDK-style own-commit protection because `processMessage` is a pure function over an explicit `ClientState` with no OpenMLS-style reprocessing restriction" — did NOT hold as originally stated, for one of the two D-16 properties.**

**How this was decided (not assumed):** the three tests in `src/engine/__tests__/convergence-parity.test.ts` were run honestly against the unmodified engine before any production change. Result: 2 passed, 1 failed.

- **Property 2 (dual-ordering)** passed cleanly on the unmodified engine. Verified with a 3-member group where the observing engine (`admin`) is a genuine third party to both competing commits (built by two other members) — this isolates the property from the own-commit-replay issue below. `sortPeeledCommits` (`ingest.ts`) canonicalizes commit order before fork-pool classification, so two engines fed the same competing commits in opposite array order apply the same first commit and route the other through the identical fork-resolution path, landing on the same `confirmationTag`. This part of Assumption A1 holds.
- **Property 1 (own commit not rolled back for a losing sibling)** **failed** on first run. The test built a 2-member group, had the local engine `send`+`confirmPublished` its own commit (now the live tip at epoch 2), then constructed a member's competing commit at the same source epoch, searching (via `compareCommitOrderingKeys`) until it deterministically found one whose digest orders strictly after our own commit's — i.e., a sibling that should lose per `compareBranchScores`'s tie-break. Ingesting that losing sibling still produced a `"processed"` result and rewound the engine onto the sibling's branch — the opposite of the required outcome.

**Root cause, confirmed by direct reproduction** (a throwaway probe reproducing the exact call `processMessage(rootState, ownCommitMessage, callback)` outside the test harness): ts-mls throws `InternalError("No overlap between provided private keys and update path")` when a `ClientState` tries to reprocess a commit its **own leaf** authored. This is structural, not a marmot-ts bug in isolation: RFC 9420's `UpdatePath` never encrypts a path secret to the committer's own leaf (the committer already has those secrets in plaintext), so a receiver whose leaf **is** the committer's leaf has no ciphertext to decrypt for its own ancestor nodes. `ForkRecovery#buildBranches`'s `explore()` calls `processMessage` uniformly over every pool candidate — including our own already-applied commit, whenever `resolveFork` needs to rebuild it as a competing candidate — and its `catch { continue }` silently dropped that candidate on this exact throw. Consequence: **our own branch could never be rebuilt once any same-epoch sibling arrived, so the sibling won unconditionally, independent of the deterministic ordering rule** — precisely the constraint MDK's `PrevalidatedOwnCommits` exists to work around in OpenMLS, which ts-mls turned out to share for this one replay path.

Confirming the test (not the production code) was the right thing to trust: the ordering-premise assertion (`compareCommitOrderingKeys(ownKey, siblingKey) < 0`, i.e. our own commit's digest genuinely orders — and therefore should win — before the sibling's) passed every time before the outcome assertion failed, so the sibling's win was not an artifact of a mis-modeled fixture; it was the engine's actual behavior contradicting the digest-decided premise.

**Fix landed — narrow, not a port of MDK's machinery:** `RetainedHistoryStore.record()` already stores the exact resulting state for every applied commit on our own canonical branch (own-authored via `confirmPublished` → `#recordCommitNode`, or inbound via `ctx.recordCommit` → the same `#recordCommitNode` — one recording path, confirmed by `grep -rn "retained.record(" src/engine/` returning exactly 2 call sites, neither branching on commit authorship: `#recordCommitNode` itself, and `#applyForkResolution`'s winner-chain replay, which is built uniformly regardless of authorship too). `ForkRecovery#resolveFork` now builds a `knownNextStates: Map<digestHex, ClientState>` from `ours` (each commit's digest → the already-known resulting state from `retained.stateAt(sourceEpoch + 1)`, cloned via a serialize/deserialize round trip so continued DFS exploration cannot mutate the retained store's actual live object in place), and passes it into `#buildBranches`. `explore()` consults this map before calling `processMessage`; when present, it uses the known state directly instead of replaying. Ordinary peer commits (not in `ours`) still go through the normal `processMessage` replay path unchanged. No `PrevalidatedOwnCommits`/`own_commit_stamp`/committer-priority/consumed-proposal-ref machinery was added; no "prefer own commit" scoring rule was added (`core/convergence.ts` untouched); `tree-convergence.ts` needed no change because `buildTreeBranchSet` (the tree-fed reconvergence path used on load/restart) never replays via `processMessage` at all — it reads already-recorded structural metadata (`commitDigest`, epoch) from the persisted `GroupHistoryTree`, so it never hit this bug.

All three tests, and the full `src/engine` suite, and the full project suite (71 files / 678 tests — the pre-existing 70/675 baseline plus this plan's 3 new tests) pass with the fix in place. `pnpm compile` and a full `tsc --noEmit -p tsconfig.json` (including tests) are both clean.

## Accomplishments

- Added `src/engine/__tests__/convergence-parity.test.ts`: native Vitest coverage for CONV-04's two D-16 properties (own-commit protection + materializability, dual-ordering), no scenario-vector driver or vector fixtures (per D-15; that harness stays Phase 4 / CONF-01)
- Diagnosed and reproduced the exact failure mode (own-commit reprocessing) via a throwaway probe before deciding on a fix
- Landed a minimal, targeted fix in `src/engine/fork-recovery.ts` scoped strictly to what the failing assertion proved broken
- Confirmed the tree-fed reconvergence path (`tree-convergence.ts`) is structurally immune to this bug (no change needed there)
- Marked CONV-04 complete in REQUIREMENTS.md — verified end-to-end, not stubbed

## Task Commits

Each task was committed atomically:

1. **Task 1 + 2: Analysis + D-16 assertions** - `ba16622` (test) — harness + all three assertions, including the file-level doc comment analysis (single recording path confirmed via `retained.record(` grep = 2 call sites, neither authorship-branching; `sortPeeledCommits` covers every path into `forkPool`)
2. **Task 3: Minimal fix** - `5588954` (fix) — `knownNextStates` lookup in `fork-recovery.ts`; test file doc comments updated to record the corrected verdict

**Plan metadata:** (this commit) - `docs(03-03): complete CONV-04 convergence-parity plan`

_Note: Tasks 1 and 2 were combined into one commit since they build the same new file incrementally (harness, then assertions) with no intermediate stable/working state worth a separate commit._

## Files Created/Modified

- `src/engine/__tests__/convergence-parity.test.ts` - Native Vitest tests for CONV-04's two D-16 properties; file-level doc comment records the full verify-first verdict
- `src/engine/fork-recovery.ts` - `resolveFork` computes a `knownNextStates` map from `RetainedHistoryStore`; `#buildBranches`/`explore()` use it to bypass `processMessage` for commits already known to be ours

## Decisions Made

- Assumption A1 (research's expectation of a clean pass) was falsified for property 1; the SUMMARY records this plainly rather than softening it, per the verify-first mandate
- The fix reuses already-retained state rather than replaying via `processMessage` — narrower than MDK's `PrevalidatedOwnCommits` (no committer-priority/consumed-proposal-ref stamping), because ts-mls's `RetainedHistoryStore` already has everything needed without inventing new bookkeeping
- Cloned (`serializeClientState`/`deserializeClientState`) the reused retained state before handing it into the DFS, because continued exploration from a state consumes/derives further secrets on it (per the existing `explore()` comment: "exploring its children would zero this state's consumed secrets in place"), and the original object is shared with `RetainedHistoryStore`/the live engine
- CONV-04 marked complete in `REQUIREMENTS.md` — the tests genuinely verify both D-16 properties end-to-end against the live `MarmotGroupEngine`/`ForkRecovery`, not against stubs
- Did not touch WIRE-03/CONV-01/CONV-02/CONV-03 in `REQUIREMENTS.md` (per explicit instruction — those were reset to Pending in `145e8a2` because earlier plans marked them Complete before their seams were actually wired; that is out of scope for this plan)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ForkRecovery's inability to replay a device's own already-applied commit as a fork candidate**
- **Found during:** Task 2 (writing and honestly running the D-16 assertions)
- **Issue:** `ForkRecovery#buildBranches` called `processMessage` uniformly on every pool candidate, including our own already-applied commit; ts-mls throws when a `ClientState` reprocesses a commit its own leaf authored (RFC 9420: no path secret is ever encrypted to the committer's own leaf). `explore()`'s `catch { continue }` silently dropped that candidate, so a same-epoch sibling always won regardless of the deterministic ordering rule.
- **Fix:** `resolveFork` now supplies `#buildBranches` a `knownNextStates` map (commit digest → already-retained resulting state, cloned) for every commit in `ours`; `explore()` uses the known state directly instead of calling `processMessage` for exactly those commits.
- **Files modified:** `src/engine/fork-recovery.ts`
- **Verification:** All three `convergence-parity.test.ts` assertions pass; full `src/engine` suite (12 files / 45 tests) and full project suite (71 files / 678 tests) pass; `pnpm compile` and `tsc --noEmit -p tsconfig.json` clean.
- **Committed in:** `5588954` (Task 3 commit)

This required diagnosing the failure with a throwaway probe (`processMessage` reproduced outside the harness, reverted before committing anything) to confirm the failing assertion — not a mis-modeled test fixture — was the true source, per the plan's Task 3 gate ("only diagnose and fix the narrowest thing the failing assertion proves broken; do not port MDK's stamping machinery"). The fix chosen is the narrower "reuse already-known retained state" mechanism rather than any committer-priority/consumed-proposal-ref stamping, consistent with that gate.

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug, discovered via verify-first testing per D-15)
**Impact on plan:** The fix is essential for CONV-04 correctness — without it, marmot-ts would silently roll back a device's own confirmed commit in favor of any later-arriving same-epoch sibling, regardless of the spec's deterministic ordering rule, which is a real interop/consistency hazard. No scope creep: `tree-convergence.ts` and `core/convergence.ts` were read and confirmed unaffected, not touched.

## Issues Encountered

- Initial dual-ordering test design (single-admin group, admin authoring both competing commits) was itself confounded by the same own-commit-replay issue being tested for property 1 — both competing commits in a single-leaf group are self-authored from the observing engine's own leaf, so BOTH failed to apply, leaving both engines stuck at epoch 0 instead of advancing. Redesigned with a 3-member group where the observing engine (`admin`) is a genuine third party to both commits (built by two other members), isolating dual-ordering from the own-commit-replay property cleanly. Documented in the test file's doc comments.
- A mid-response API transport interruption occurred after Task 1's commit landed; resumed from the last committed state (`ba16622`) per the coordinator's status report, re-verified the prior commit and test results before continuing into Task 2/3.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CONV-04 is closed with genuine end-to-end verification; Phase 4 (CONF-01)'s scenario-vector parity harness is unblocked to build on a `ForkRecovery` that is now confirmed to handle own-commit replay correctly — worth cross-checking against MDK's own-confirmed-commit conformance vectors when that harness lands, as an independent confirmation.
- No blockers for the rest of Phase 3 (plans 03-04 through 03-07 cover WIRE-03/CONV-01/CONV-02/CONV-03 seam-wiring, per STATE.md's accumulated context).
- Pre-existing, out-of-scope items from earlier plans in this phase remain open (see `deferred-items.md`): stale `exports.test.ts` snapshot risk on future barrel changes, and `pnpm lint` failing repo-wide on `refs/mdk/target/**` (missing `.prettierignore` entry) — neither touched by this plan.

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*
