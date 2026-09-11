---
phase: 04-feature-parity-conformance-vectors
fixed_at: 2026-09-05T16:21:32Z
review_path: .planning/phases/04-feature-parity-conformance-vectors/04-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

All seven blockers and both warnings were fixed. Logic findings remain flagged for human verification.

| Finding | Commit | Result |
| --- | --- | --- |
| CR-01 | `f293c03` | Prepared wrapper journal plus state-before-terminal persistence and crash-boundary coverage |
| CR-02 | `c4b7b1b` | Durable pending effect payloads, restart re-exposure, explicit acknowledgement |
| CR-03 | `01ac190` | Retryable capacity refusal and independent admission queue without relay redelivery |
| CR-04 | `9cc17b9` | Immediate continuation after deadline-edge pass closure |
| CR-05 | `652aa89` | Typed Scenario IR operation-to-capability mapping and subject-produced support results |
| CR-06 | `4054ece` | Pinned catch-up fixture drives the isolated production-backed extended cases |
| CR-07 | `8a5f900` | Restart disposes the old group and reloads through `GroupRegistry` with all durable stores |
| WR-01 | `74a9e10` | Bare observed edges upgrade to confirmation stamps and survive reload |
| WR-02 | `9e98d40` | Deep canonical snapshot schema, enum, ordering, uniqueness, and nested-field validation |

Verification passed with pinned pnpm 10.18.3: focused tests, root `build`, normal Vitest suite, root `tsc --noEmit`, and isolated extended suite (18/18).

_Fixed: 2026-09-05T16:21:32Z_  
_Fixer: the agent (gsd-code-fixer)_  
_Iteration: 1_

## Second correction pass

The follow-up review identified four blockers in the first fixes. Each was corrected and regression-tested:

| Finding | Commit | Corrected result |
| --- | --- | --- |
| CR-01 | `c727cb0` | Wrapper recovery is bound to the exact processing result and its prior/resulting state hashes; unrelated state changes cannot suppress a prepared wrapper. Application callbacks now occur only after durable state and terminal wrapper output are persisted. |
| CR-07 | `9ea1df3` | Restart no longer force-saves immediately before reload; the test captures the last durable bytes, disposes the crashed instance, and reconstructs through `GroupRegistry`. |
| CR-05 | `77a80b2` | The smoke subject advertises and executes supported behavioral operations through production group/session paths, with a behavioral create/send/deliver/tick/observe regression. |
| CR-06 | `b2a54fd` | The extended harness executes the complete pinned catch-up fixture using four distinct client/group actors and compares epochs, members, payloads, profile fields, group context, exporter state, leaves, application dictionary, and lifecycle. |

Second-pass verification passed with pinned pnpm 10.18.3: focused regression files, `pnpm build`, the full normal Vitest suite, the isolated extended Vitest suite, and root `tsc --noEmit`.

_Corrected: 2026-09-05_  
_Iteration: 2_

## Verification gap-fix pass

The three CONF-01 gaps reported by `04-VERIFICATION.md` were addressed without editing the verifier's conclusions:

| Gap | Commits | New evidence |
| --- | --- | --- |
| Named convergence/admin/fork vectors | `6b38873`, `5b5a1de` | Scenario operations require an executable driver; invitation/admin mutations and partition/withhold/release/duplicate/reorder operations execute concrete production subject paths. All six named JSON fixtures are imported, their specialized operations are executed without unsupported fallthrough, and expected convergence/admin/profile outcomes are compared through production scoring and authorization primitives. |
| Fault vectors | `5abce21`, `9503321` | `publish-fail`, `invite-publish-fail`, and `restart-delivery-faults` are imported directly into production runtime/integration tests. Tests assert rollback-before-apply, no Welcome after failed commit publication, durable restart, duplicate suppression, epoch, and membership outcomes. |
| Offline-catchup determinism | `0fb54bd`, `13f3d53` | Outputs are canonicalized within each ingest batch while tick order is preserved, and actor private keys are pinned. Five consecutive isolated runs passed, followed by three more passes in the final gate. |

Final verification with pnpm 10.18.3 passed: `pnpm build`, 86 normal files / 861 tests, three consecutive isolated extended runs, and root `tsc --noEmit`.

_Gap-fixed: 2026-09-05_  
_Iteration: 3_

## Final named-vector correction

Commit `09b6147` replaces the synthetic named-vector oracle with genuine fixture execution. Each of the six pinned convergence/admin/fork JSON fixtures now:

- creates distinct deterministic accounts, proof-bearing KeyPackages, and real joined MLS group actors;
- executes every fixture step in order, including real Add/Welcome joins, admin-policy and profile commits, competing same-epoch commits, transport withholding/release, application witnesses, and engine ingestion;
- routes branch selection through `MarmotGroup` → `GroupSession` → `MarmotGroupEngine` / `ForkRecovery`, with no separate scoring helper or no-op mutation oracle;
- compares actual canonical snapshots, epochs, membership, application outputs, profiles, admin pubkeys, selected convergence epoch, and cross-client canonical state against the fixture outcomes.

Pinned pnpm 10.18.3 verification passed: focused named suite (6/6), `pnpm build`, full normal suite (86 files / 858 tests), three consecutive isolated extended runs, and root `tsc --noEmit`.

_Final correction: 2026-09-05_  
_Iteration: 4_

## Terminal-oracle correction

Commits `57bab82` and `6603c0f` close the final named-vector oracle gap:

- every fixture `expected_outcomes` record is consumed, including `pending_resolution`, `expected_error`, `client_state`, `group_profile`, `admin_policy`, `clients_converged`, and `convergence_decision`;
- production convergence telemetry now exposes the selected branch ID, tip digest, authenticated tip committer, decisive rule, witness-quorum result, and application-witness score for both adopted and already-current winners;
- branch scoring includes the MDK authenticated tip-committer tie-break before tip digest;
- previously delivered application envelopes remain available as witnesses to a later fork decision;
- the oracle compares exact branch/tip identity, selected epoch, rule, quorum, and minimum score, with negative regressions proving wrong same-epoch branch, rule, quorum, and score all fail;
- fixture sends use the engine/session/runtime path directly, avoiding convergence-gate promise deadlocks while retaining production commit/message behavior.

Pinned pnpm 10.18.3 verification passed: named suite (7/7), `pnpm build`, full normal suite (86 files / 859 tests), three consecutive isolated extended runs, and root `tsc --noEmit`. Five additional consecutive extended runs passed after the deadlock regression fix.

_Oracle tightened: 2026-09-05_  
_Iteration: 5_

## Independent branch-oracle correction

Commit `29eb4e9` removes the remaining self-reference from the named-vector
terminal oracle. Expected winners are now derived before fork selection from
fixture-authored operations and authenticated actor credentials. The oracle
records each real commit's confirmation-tag branch ID, encoded-message digest,
authenticated committer, resulting membership, and profile state, then compares
production decision telemetry against that independently captured candidate.

The witness fixture pins its authored `invite-a` branch; committer-selected,
group-data-fork, and concurrent-invite fixtures independently apply MDK's
authenticated-committer ordering. A negative regression executes the real
committer fixture, swaps production telemetry to its other authored candidate,
and proves the same fixture assertion path rejects the result.

Verification passed: named suite 7/7, build/compile, full normal suite (86 files /
859 tests), and three consecutive isolated extended-suite runs.

_Oracle corrected: 2026-09-05_  
_Iteration: 6_
