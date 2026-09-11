---
phase: 03-commit-integrity-convergence-parity
verified: 2026-09-01T21:48:08Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 0/5
  gaps_closed:
    - "Load-time removal realization now occurs after GroupRegistry forwarding listeners attach, with a real concurrent GroupsManager load regression."
    - "Locally confirmed commit and selfUpdate notifications are digest-attributed, consumer-visible, ledger-recorded, and withdrawable on rewind."
    - "Parent-bound retained applied links preserve chained own-confirmed branches containing by-reference proposals."
    - "commit and selfUpdate now authorize the exact by-value plus by-reference proposal union before MLS construction."
  gaps_remaining: []
  regressions: []
deferred:
  - truth: "Execute the permanent cross-implementation MDK convergence scenario-vector harness rather than native MDK-derived focused regressions."
    addressed_in: "Phase 4"
    evidence: "Phase 4 success criterion 3 explicitly requires the convergence/admin-policy/fork-recovery scenario vectors to run as an automated parity harness; CONF-01 is mapped to Phase 4."
  - truth: "Replace deprecated MIP-NN citations in Phase 3-touched source with current topic-organized specification paths."
    addressed_in: "Phase 03.1"
    evidence: "Phase 03.1 success criterion 6 explicitly owns removal of all MIP-NN citations from Phase 3-touched source."
---

# Phase 3: Commit Integrity & Convergence Parity Verification Report

**Phase Goal:** Staged commits and membership/convergence handling match MDK's legality and rewind semantics so the two implementations never silently fork on a component-mutating or membership-changing commit.
**Verified:** 2026-09-01T21:48:08Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Component-integrity violations are rejected pre-merge identically on send, inbound, and convergence/replay paths. | ✓ VERIFIED | `validateCommitLegality` is shared by `group-engine.ts`, `ingest.ts`, and `fork-recovery.ts`. Independent focused execution passed `integrity.test.ts` (22), `commit-legality-seams.test.ts` (5), and `send-commit-legality.test.ts` (20), including exact-union outbound authorization. |
| 2 | Every membership-changing commit preserves admin ⊆ resulting member accounts or is rejected identically. | ✓ VERIFIED | The shared validator derives resulting membership from the resulting state. The focused legality suites pass inbound, replay, send, selected-reference, implicit-reference, selfUpdate, auto-coupling, and admin-control cases. |
| 3 | Removal is consumer-visible, durable, outbound-blocking, and subsequent input is SelfEvicted/stale. | ✓ VERIFIED | `GroupRegistry.track()` installs `removed` forwarding before awaiting `realizeRemovalIfNeeded()`. `MarmotGroup.fromClientState()` is side-effect free. The real `GroupsManager` concurrent-load/restart test and engine self-eviction suite passed (15 tests combined). |
| 4 | Every accepted commit's state notifications are digest-attributed and withdrawn, including marker clearing, when superseded on rewind. | ✓ VERIFIED | `confirmPublished()` hashes the encoded commit, derives notifications from exact parent/resulting states, records them in `StateNotificationLedger`, and returns them through session/runtime. The real locally-confirmed-branch rewind regression proves exact-digest withdrawal; marker-clear and publish-result tests also pass. |
| 5 | A device's own published+confirmed commit is not incorrectly rolled back for a same-epoch sibling, including a chained branch consuming an exact-parent proposal reference. | ✓ VERIFIED | `RetainedHistoryStore.appliedLinksBetween()` supplies parent-bound message/resulting-state evidence to `ForkRecovery`. Five native MDK-derived tests pass: losing sibling retention, winning sibling materialization, no same-epoch graft, opposite-order determinism, and the depth-two by-reference branch regression. The permanent external vector harness is explicitly deferred to Phase 4/CONF-01 below. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|---|---|---|
| 1 | Permanent execution of MDK's cross-implementation convergence scenario-vector files | Phase 4 | Phase 4 SC3 owns the automated convergence/admin-policy/fork-recovery vector harness, and REQUIREMENTS maps CONF-01 there. Phase 3 verifies the required own-confirmed behavior with native tests translated from the MDK semantics. |
| 2 | Replace deprecated MIP-NN citations in Phase 3-touched source | Phase 03.1 | Phase 03.1 SC6 explicitly assigns all 21 citation replacements to review closure. This is documentation debt and does not alter the verified runtime behavior. |

This deferral covers vector infrastructure, not the Phase 3 runtime invariant: the own-confirmed behavior and the prior chained-reference defect both execute and pass in Phase 3 tests.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/core/components/integrity.ts` | Pure shared WIRE-03/CONV-01 legality adapter | ✓ VERIFIED | Substantive, exported, and called at send, inbound, replay, and tree-fed seams. |
| `src/core/components/__tests__/integrity.test.ts` | Pure validator behavior | ✓ VERIFIED | 22 tests passed independently. |
| `src/engine/__tests__/commit-legality-seams.test.ts` | Inbound/replay parity | ✓ VERIFIED | 5 tests passed independently. |
| `src/engine/__tests__/send-commit-legality.test.ts` | Outbound legality and exact proposal-union authorization | ✓ VERIFIED | 20 tests passed independently. |
| `src/client/group-registry.ts` | Listener-first persisted removal realization | ✓ VERIFIED | `track()` attaches forwarders before realization; manager callers await tracking. |
| `src/__tests__/groups-manager.test.ts` | Public consumer removal regression | ✓ VERIFIED | Concurrent load emits once, restart does not duplicate, outbound remains blocked. |
| `src/engine/state-notifications.ts` | Digest-keyed derivation and withdrawal ledger | ✓ VERIFIED | Substantive and wired for inbound, rewind-landed, and locally confirmed paths. |
| `src/engine/__tests__/state-notification-withdrawal.test.ts` | Attribution and real-rewind withdrawal | ✓ VERIFIED | 13 tests passed, including `confirmPublished` withdrawal by exact digest. |
| `src/engine/retained-store.ts` | Parent-bound applied-link retention | ✓ VERIFIED | Stores exact parent, message, and resulting state; refreshes preceding resulting state with proposal-bearing parent evidence. |
| `src/engine/fork-recovery.ts` | Structural own-branch materialization | ✓ VERIFIED | Consumes `appliedLinksBetween()` and binds each known next state to its actual parent confirmation tag. |
| `src/engine/__tests__/convergence-parity.test.ts` | Own-confirmed convergence regressions | ✓ VERIFIED | 5 tests passed, including depth-two by-reference and opposite-delivery-order cases. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `integrity.ts` | send/inbound/replay/tree-fed seams | `validateCommitLegality` | ✓ WIRED | Direct production calls exist in engine send, ingest, fork recovery, and persisted-tree adoption. |
| `GroupRegistry.track` | `MarmotGroup.realizeRemovalIfNeeded` | listener attachment then awaited realization | ✓ WIRED | Forwarder is registered before the only load-time realization call. |
| `GroupRuntime` | engine notification ledger | `confirmPublished` return → `GroupPublishResult.notifications` | ✓ WIRED | Notifications are returned only after publish confirmation; failure tests assert no exposure. |
| `confirmPublished` | `StateNotificationLedger` | derive, record, prune | ✓ WIRED | Exact encoded commit digest is used for both commit and selfUpdate. |
| `RetainedHistoryStore` | `ForkRecovery` | `appliedLinksBetween` | ✓ WIRED | Fork recovery consumes structural links, with compatibility fallback only for custom retained views. |
| outbound commit preparation | inbound admin policy | one normalized `ProposalWithSender[]` | ✓ WIRED | All unapplied references plus true by-value/coupled proposals are authorized once before `createCommit`; selected refs are not duplicated. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `MarmotGroup` removal event | persisted group active state + marker | loaded `ClientState`, `removedMarkerStore`, registry listener | Yes | ✓ FLOWING |
| local state notifications | `StateNotification[]` | exact pending parent/new state and encoded MLS commit digest | Yes | ✓ FLOWING |
| rewind invalidations | withdrawn notification list | digest-keyed ledger queried against canonical digests/fork epoch | Yes | ✓ FLOWING |
| own-branch candidates | retained applied links | actual confirmed/inbound commits recorded with exact parent/resulting state | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| All Phase 3 goal behaviors | `PNPM_CONFIG_FROZEN_LOCKFILE=true PNPM_CONFIG_OFFLINE=true pnpm vitest run` with the 8 focused Phase 3 files | 8 files passed; 93/93 tests passed in 4.31s | ✓ PASS |
| Full repository regression | Orchestrator run after commit `22428e0` | 78 files, 740 tests green | ✓ PASS |
| Library build | Orchestrator run after commit `22428e0` | `pnpm build` green | ✓ PASS |
| Lockfile integrity | `sha256sum pnpm-lock.yaml` after focused run | `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` | ✓ PASS |

### Probe Execution

No phase probe scripts are declared. The phase's executable evidence is the named Vitest behavior suite above.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|---|---|---|---|---|
| WIRE-03 | 03-01, 03-02, 03-04, 03-05, 03-08, 03-11 | Reject invalid app-component mutations before merge across every seam | ✓ SATISFIED | Pure/inbound/replay/send tests pass; production seams share `validateCommitLegality`. |
| CONV-01 | 03-01, 03-02, 03-04, 03-05, 03-08, 03-11 | Enforce resulting admin/leaf coupling and peer-equivalent authorization | ✓ SATISFIED | Exact-union matrix and legality suites pass for commit and selfUpdate. |
| CONV-02 | 03-02, 03-06, 03-09 | SelfEvicted classification, durable removal, public notification, outbound block | ✓ SATISFIED | Listener-first public concurrent-load/restart regression and engine self-eviction tests pass. |
| CONV-03 | 03-02, 03-07, 03-09 | Commit-digest attribution and rewind withdrawal, including markers | ✓ SATISFIED | Local and inbound attribution plus real-rewind withdrawal and marker-clear tests pass. |
| CONV-04 | 03-03, 03-10 | Own-confirmed convergence protection | ✓ SATISFIED | Five focused MDK-derived scenarios pass, including chained by-reference and order independence. Permanent vector-file harness is Phase 4 CONF-01 scope. |

All five Phase 3 requirement IDs are declared in plans and mapped to Phase 3 in `REQUIREMENTS.md`. No additional Phase 3 requirement is orphaned.

### Anti-Patterns Found

No unreferenced `TBD`, `FIXME`, or `XXX` debt marker, placeholder implementation, empty handler, or console-only implementation was found in the Phase 3 production files checked.

| File | Line | Pattern | Severity | Impact |
|---|---:|---|---|---|
| `src/engine/group-engine.ts` | 676, 927 | Deprecated `MIP-02` citation | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |
| `src/engine/fork-recovery.ts` | 274, 282 | Deprecated `MIP-03` citation | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |
| `src/engine/admin-policy.ts` | 23, 137 | Deprecated `MIP-03` citation | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |
| `src/engine/wire-format.ts` | 105 | Deprecated `MIP-03` citation | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |
| `src/client/group/marmot-group.ts` | 561, 743 | Deprecated `MIP-02`/`MIP-03` citations | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |
| `src/client/marmot-client.ts` | 425 | Deprecated `MIP-02` citation | ⚠️ Warning | Documentation convention drift; explicitly assigned to Phase 03.1 SC6. |

### Human Verification Required

None. The phase is a runtime-agnostic TypeScript library phase, and each state-transition/ordering invariant is exercised by a focused passing behavioral test. No visual or external-service behavior is involved.

### Re-verification Gap Closure

The prior four blockers are closed:

1. Removal delivery is listener-first and proven through the real public manager path.
2. Local confirmations now enter notification delivery and withdrawal accounting.
3. Own-confirmed convergence uses structural parent-bound evidence and passes the chained proposal-reference regression.
4. Both local commit-producing intents authorize the exact proposal union peers evaluate inbound.

The two formerly behavior-unverified legality truths now have executable evidence. No regression was found in the quick sanity checks for previously passing artifacts and links.

### Gaps Summary

No actionable Phase 3 gap remains. The only deferred item is the permanent cross-implementation scenario-vector harness, specifically and unambiguously assigned to Phase 4/CONF-01 by the current roadmap. Phase 3's underlying own-confirmed convergence invariant is implemented and behaviorally verified now.

---

_Verified: 2026-09-01T21:48:08Z_
_Verifier: Codex (gsd-verifier)_
