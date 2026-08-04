---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Phase 1)
current_phase: 03
current_phase_name: commit-integrity-convergence-parity
status: executing
stopped_at: Completed 03-04-PLAN.md
last_updated: "2026-08-04T13:47:30.840Z"
last_activity: 2026-08-04
last_activity_desc: Phase 03 execution started
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 13
  completed_plans: 10
  percent: 40
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-21)

**Core value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte, with any spec-conformant peer (incl. the Rust MDK reference), across every supported runtime.
**Current focus:** Phase 03 — commit-integrity-convergence-parity

## Current Position

Phase: 03 (commit-integrity-convergence-parity) — EXECUTING
Plan: 5 of 7
Status: Ready to execute
Last activity: 2026-08-04 — Phase 03 execution started

Progress: [████░░░░░░] 40%

## Performance Metrics

**Velocity:**

- Total plans completed: 6
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| 01    | 2     | -     | -        |
| 02    | 4     | -     | -        |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

_Updated after each plan completion_
| Phase 01-proof-v2 P01 | 15min | 3 tasks | 3 files |
| Phase 01 P02 | 20min | 3 tasks | 2 files |
| Phase 02 P01 | 6min | 3 tasks | 8 files |
| Phase 02 P02 | 10min | 3 tasks | 10 files |
| Phase 02 P03 | 6min | 3 tasks | 9 files |
| Phase 02 P04 | 12min | 3 tasks | 6 files |
| Phase 03 P01 | 25min | 3 tasks | 3 files |
| Phase 03 P02 | 12min | 3 tasks | 8 files |
| Phase 03 P03 | 50min | 3 tasks | 2 files |
| Phase 03 P04 | 45min | 3 tasks | 4 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Prior v1.0 phases (Exhaustive Gap Audit → Blocker & Security Closure → Wire/Conformance & Docs → Quality Gate) were shelved to the backlog (999.3–999.6); v1.0 was repurposed as "catchup" and the phase sequence restarted at Phase 1
- Catchup review is done (`.planning/research/SUMMARY.md` + PROOF-V2/SPEC-DELTAS/MDK-INTEROP); roadmap derived directly from its 13 v1 requirements — interop-breakers close first (Phase 1–2), then commit-integrity/convergence parity (Phase 3, CONV-04 verify-first), then feature parity + MDK vectors (Phase 4), then the quality gate (Phase 5)
- REQUIREMENTS.md traceability footer corrected from "12 total" to "13 total" — the itemized requirement list (PROOF-01, SEC-01, WIRE-01..04, CONV-01..04, CONF-01, QA-01, QA-02) was always 13; the summary count was a stale undercount
- [Phase 01]: Widened AccountIdentityProofSigner to a union (plain digest function | { signEvent } object) to preserve raw-key compatibility while adding external-signer parity for account-identity-proof v2
- [Phase 01]: mlsSignatureScheme() table already matched Rust ciphersuite.signature_algorithm() as u16 for all 7 ciphersuites; only decimal annotations added
- [Phase 01]: Task 1/2 of plan 01-02 required no code changes: 01-01's core v2 migration already made client re-exporters and all 7 proof-touching test files v2-correct; only a stale .v1 JSDoc needed fixing
- [Phase 01]: Generated a fresh Rust-signed proof-v2 round-trip fixture from refs/mdk cgka-engine via a throwaway, reverted test; pinned in darkmatter-invite-compat.test.ts, closing PROOF-01
- [Phase 02]: Kept createThreeMonthLifetime as a deprecated alias re-export of createDefaultKeyPackageLifetime rather than a hard rename, per CONTEXT's Claude's Discretion
- [Phase 02]: Cap enforcement lives entirely in marmot-ts (isLifetimeWithinCap + a throw guard in generateKeyPackage) rather than ts-mls's LifetimeConfig.maximumTotalLifetime, which is dead code in rc.14
- [Phase 02]: getTagValue in src/utils/nostr.ts left byte-for-byte untouched; new strict getters live in a new sibling module src/utils/tag-cardinality.ts
- [Phase ?]: [Phase 02]: Added safeVerifyEvent() to verify.ts after discovering applesauce's verifyEvent throws (rather than returning false) on a malformed event whose getEventHash/serializeEvent call is outside its own try/catch; wrapped at both the 445 drain and 1059 ingest gates
- [Phase ?]: [Phase 02]: Relaxed getSingletonTagValue/getListTag from a NostrEvent-only signature to a generic <T extends { tags: string[][] }> bound (mirroring getTagValue) so the 444 welcome-rumor's unsigned Rumor callers compile
- [Phase ?]: [Phase 02]: Deferred verifyEvent threading into GroupsManager/InviteManager constructor calls in marmot-client.ts from plan 02-02 Task 1 to Tasks 2/3 respectively, keeping each task's own pnpm compile green
- [Phase ?]: Placed createInviteIntent trust-boundary tests in the existing invite.test.ts rather than key-package-manager.test.ts, matching this codebase's colocated-test convention
- [Phase ?]: track()'s cardinality gate reuses the validated i tag value as the addPublished ref, replacing the prior getKeyPackageReference() read (a migration, not new wiring)
- [Phase ?]: evaluateKeyPackageForGroup reuses the already-decoded keyPackage.leafNode.lifetime rather than re-calling getKeyPackageLifetime, avoiding a redundant decode
- [Phase ?]: [Phase 02]: Introduced an object-identity-keyed rejectedEvents Set alongside the trusted-only id-keyed seen Set in GroupsManager#connectGroup's drain, to close WR-01 (same-id forgery censorship) without regressing existing single-rejection tests under MockNetwork's backfill+subscribe replay of the same malformed event object
- [Phase ?]: requiredIds for validateAppComponentIntegrity MUST be derived from the CURRENT (pre-commit) extensions, never resulting, closing the Pitfall 2 re-derivation bug (mdk#707 class)
- [Phase ?]: validateAdminLeafCoupling evaluates the carried-forward admin set when resulting extensions carry no admin-policy bytes, per Pitfall 3, and deliberately has no SelfRemove carve-out per Pitfall 4
- [Phase ?]: Declared RejectedIngestResult.reason as an inline literal union in src/engine/types.ts rather than importing from src/core/components/integrity.ts, keeping plan 03-02 independent of sibling plan 03-01 per its explicit instruction
- [Phase ?]: group-engine.ts's #emitIngestOutcome (audit emission) guards on stateInvalidated and returns early rather than fabricating an audit msg_id from a non-existent envelope; audit wiring for this variant is deferred to a later seam-wiring plan
- [Phase 03]: CONV-04 verify-first found Assumption A1 falsified for D-16 property 1 (ForkRecovery could not replay a device's own already-applied commit); fixed narrowly by reusing RetainedHistoryStore's already-known resulting state instead of replaying via processMessage, without porting MDK's PrevalidatedOwnCommits stamping machinery
- [Phase 03]: tree-convergence.ts's buildTreeBranchSet needed no change for CONV-04 -- it is structural (reads already-recorded commitDigest/epoch metadata) and never replays via processMessage, so it never shared the own-commit-reprocessing bug
- [Phase ?]: [Phase 03-04]: withCapturedProposals is a pure decorator around IncomingMessageCallback; createAdminCommitPolicyCallback body is byte-for-byte unchanged (verified via git diff --unified=0)
- [Phase ?]: [Phase 03-04]: Both ingest.ts and fork-recovery.ts call validateCommitLegality directly with (parentState, resultingState, proposals) rather than re-deriving requiredIds/resultingMemberAccounts locally, so neither seam can drift from the shared adapter
- [Phase ?]: [Phase 03-04]: fork-recovery.ts's WIRE-03/CONV-01 gate applies only to the processMessage replay branch, not the knownNextStates (CONV-04) own-commit branch, since those commits already passed a legality gate the first time they were applied
- [Phase ?]: [Phase 03-04]: Did not mark WIRE-03/CONV-01 complete in REQUIREMENTS.md -- the send seam (plan 03-05) is the third and final seam, per explicit instruction

### Pending Todos

None yet.

### Blockers/Concerns

- [Resolved in 03-03]: CONV-04 verify-first ran; Assumption A1 was falsified for one of the two D-16 properties (own-commit replay) and fixed narrowly in `fork-recovery.ts` — see 03-03-SUMMARY.md "CONV-04 verdict"
- Pre-existing (from 03-01): src/__tests__/exports.test.ts snapshot stale + pnpm lint fails on refs/mdk/target/ noise — logged in phase deferred-items.md, not fixed in 03-02

## Deferred Items

| Category        | Item                                                                | Status       | Deferred At     |
| --------------- | ------------------------------------------------------------------- | ------------ | --------------- |
| Multi-device    | MIP-06 (ext 0xf2f0, External-Commit, join-PSK, pairing payload)     | Catalog only | Milestone scope |
| Push            | MIP-05 (push-token gossip, #725)                                    | Catalog only | Milestone scope |
| QUIC data plane | Agent text-stream data plane, transport-quic-*                      | Not in scope | Milestone scope |
| App/tooling     | marmot-app, cli, uniffi, forensics, storage backends                | Not in scope | Milestone scope |
| Media           | encrypted-media/Blossom changes (mdk #852)                          | Not in scope | Milestone scope |
| Backlog (999.x) | Group image support, docs review, shelved v1.0 audit/closure phases | Backlog      | Prior milestone |

## Session Continuity

Last session: 2026-08-04T13:47:30.833Z
Stopped at: Completed 03-04-PLAN.md
Resume file:
None
