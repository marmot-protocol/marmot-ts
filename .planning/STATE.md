---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Phase 1)
current_phase: 04
current_phase_name: Feature Parity & Conformance Vectors
status: executing
stopped_at: Phase 4 UI-SPEC approved
last_updated: "2026-09-05T14:31:03.706Z"
last_activity: 2026-09-02
last_activity_desc: Phase 03.1 complete, transitioned to Phase 04
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 39
  completed_plans: 32
  percent: 57
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-21)

**Core value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte, with any spec-conformant peer (incl. the Rust MDK reference), across every supported runtime.
**Current focus:** Phase 03.1 — Phase 3 Review Closure

## Current Position

Phase: 04 — Feature Parity & Conformance Vectors
Plan: Not started
Status: Ready to execute
Last activity: 2026-09-02 — Phase 03.1 complete, transitioned to Phase 04

Progress: [██████████] 100% (7 phases)

**Next recommended run:** `/gsd-execute-phase 03.1`

## Performance Metrics

**Velocity:**

- Total plans completed: 32
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| 01    | 2     | -     | -        |
| 02    | 4     | -     | -        |
| 03 | 11 | - | - |
| 03.1 | 15 | - | - |

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
| Phase 03 P05 | 70min | 3 tasks | 2 files |
| Phase 03 P06 | 20min | 3 tasks | 6 files |
| Phase 03 P07 | 95min | 3 tasks | 5 files |
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 03 P08 | 6h | 2 tasks | 0 files |
| Phase 03 P09 | 7min | 3 tasks | 10 files |
| Phase 03 P10 | 5min | 2 tasks | 3 files |
| Phase 03 P11 | 4min | 2 tasks | 2 files |
| Phase 03.1 P01 | 5min | 2 tasks | 3 files |
| Phase 03.1 P04 | 4min | 2 tasks | 7 files |
| Phase 03.1 P02 | 5min | 2 tasks | 3 files |
| Phase 03.1 P06 | 7min | 2 tasks | 4 files |
| Phase 03.1 P03 | 10min | 3 tasks | 9 files |
| Phase 03.1 P05 | 10min | 2 tasks | 8 files |
| Phase 03.1 P07 | 4min | 1 tasks | 4 files |
| Phase 03.1 P09 | 8min | 2 tasks | 10 files |
| Phase 03.1 P10 | 7min | 2 tasks | 8 files |
| Phase 03.1 P08 | 2min | 1 tasks | 3 files |
| Phase 03.1 P11 | 4min | 1 tasks | 14 files |
| Phase 03.1 P12 | 4min | 1 tasks | 2 files |
| Phase 03.1 P14 | 3min | 1 tasks | 2 files |
| Phase 03.1 P13 | 6min | 2 tasks | 4 files |

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
- [Phase ?]: [Phase 03-05]: Auto-coupling and the D-07 depletion guard live in #sendInner's case commit, never in proposeRemoveUser -- send() must catch every removal proposal landing in the commit, including unapplied proposals bundled by reference
- [Phase ?]: [Phase 03-05]: Tree-fed re-convergence test fixtures must replay a competing committer's raw commits through a third party's own state before recordEdge -- recording the committer's own createCommit result directly hits ts-mls's RFC 9420 own-commit-replay constraint on later replay
- [Phase ?]: [Phase 03-06]: D-13 self-evicted short-circuit is the first statement in ingestEnvelopes, ahead of even the retry-count check, so both fresh batches and internal retry recursion are covered uniformly
- [Phase ?]: [Phase 03-06]: AppliedForkResolution gained tipCommitMessage so a rewind-landed removal attributes its selfRemoved notification to the winning chain's own tip commit, not an arbitrary forkPool entry
- [Phase ?]: [Phase 03-06]: removedMarkerStore is a sibling GenericKeyValueStore<boolean> keyed by group-id hex, never grafted onto serialized ClientState; #realizeRemovalIfNeeded is the single idempotent funnel shared by fromClientState (load) and the ingest removed branch
- [Phase ?]: [Phase 03-06]: Did not thread removedMarkerStore through GroupRegistry/GroupFactory/GroupsManager options -- checked every MarmotGroup construction site and found no load-time realization gap (fromClientState is the only loader path); logged as a deferred item
- [Phase ?]: [Phase 03-06]: Loosened a third toHaveLength(1) rejection-count assertion beyond the two the plan named, since MockNetwork's subscription() replay-on-subscribe produces the same backfill-then-subscribe double delivery the plan itself documents as an accepted consequence
- [Phase ?]: Tasks 1+2 combined into one commit for 03-07 (mutually-dependent interfaces cannot compile independently)
- [Phase ?]: 03-07: extended notification derivation to the forkPool rewind site's own winning commit (Rule 2), not just the direct branch, so a rewind-landed commit can itself be superseded later
- [Phase ?]: 03-07: CONV-03 marker-clearing tested at the MarmotGroup wiring boundary; a fully organic removed-then-un-removed engine scenario is currently unreachable due to ForkRecovery's confirmationTag-based candidate dedup and the direct removal branch skipping tree/retained recording (logged in deferred-items.md)
- [Phase ?]: [Phase 03-08]: Treat the user-restored pnpm-lock.yaml hash as authoritative and verify it after every pnpm command.
- [Phase ?]: [Phase 03-08]: Existing validateCommitLegality suites provide executable WIRE-03/CONV-01 evidence without production edits.
- [Phase ?]: [Phase 03-09]: Persisted removal realization is invoked by GroupRegistry only after lifecycle forwarding listeners attach.
- [Phase ?]: [Phase 03-09]: Local confirmed notifications travel on GroupPublishResult and are attributed from encoded MLS commit bytes.
- [Phase ?]: [Phase 03-10]: Retain each applied commit as an exact parent/message/resulting-state link instead of reconstructing own links from digest plus epoch lookups.
- [Phase ?]: [Phase 03-10]: Refresh the preceding retained link when its resulting epoch becomes the next commit parent, preserving staged proposal-reference evidence.
- [Phase ?]: [Phase 03-11]: Keep unapplied proposals as MLS references and add only true caller/coupled proposals by value.
- [Phase ?]: [Phase 03-11]: Run the shared admin callback over one normalized outbound proposal-with-sender union before createCommit.
- [Phase ?]: [Phase 03.1]: Keep GroupRegistry.load hydration-only and activate persisted forks only after registry listeners attach.
- [Phase ?]: [Phase 03.1]: Serialize the complete removal-realization transaction with a retry-safe instance-owned Promise.
- [Phase ?]: [Phase 03.1-04]: Outbound commit authorization is a pure typed core decision over the exact proposal union, with actor identity derived from the local MLS leaf.
- [Phase ?]: [Phase 03.1-04]: Malformed basic credentials are skipped uniformly by all member enumeration helpers while valid siblings remain visible.
- [Phase ?]: [Phase 03.1-02]: Model post-confirm persistence and Welcome failures as independent discriminated GroupPublishResult outcomes.
- [Phase ?]: [Phase 03.1-02]: Keep publishFailed exclusive to pre-confirm relay failures and mark acknowledged work retryPublication false.
- [Phase ?]: Validate each delivery before consulting rejected-id history so bounded caches cannot censor a later valid same-id event.
- [Phase ?]: Store removal realization only under the group-scoped groupId/removed key.
- [Phase ?]: 03.1-03: Applied state changes use a named envelope-less ingest result rather than extending autoCommit or SendResult.
- [Phase ?]: 03.1-03: Winner-chain notifications are grouped by commit digest and emitted before withdrawals.
- [Phase ?]: Plan 03.1-05 keys payload records by branch state and exact MLS message identity for deterministic, idempotent withdrawal.
- [Phase ?]: Plan 03.1-05 prunes ledgers at min(retained anchor, oldest tree-node epoch); an unpruned tree intentionally implies unbounded retention.
- [Phase ?]: [Phase 03.1-07]: CommitLegalityError retains the complete structured violation; inbound audit reasons normalize the exact typed reason to underscore form.
- [Phase ?]: [Phase 03.1-09]: Derive every session ingest variant from the engine union and rename only envelope to event at the Nostr boundary.
- [Phase ?]: [Phase 03.1-09]: Keep getGroupMembers as a deprecated alias while making getGroupMemberPubkeys canonical for production callers.
- [Phase ?]: [Phase 03.1-09]: Preserve the existing removed-state send guard and regression-pin it as the D-12 lifecycle disposition.
- [Phase ?]: [Phase 03.1-10]: Wrap commit envelopes before PendingPublish and terminate post-acknowledgement Merging in finally.
- [Phase ?]: [Phase 03.1-10]: Project confirmation bookkeeping errors as typed persistence failures without republication.
- [Phase ?]: [Phase 03.1-10]: Emit local historyChanged only after confirmation grows the tree.
- [Phase ?]: [Phase 03.1-10]: Delete groupId/removed before shared serialized state and omit obsolete bare rewind deletion.
- [Phase ?]: [Phase 03.1-08]: Expose only engine symbols named by root public signatures while keeping unrelated internals on ./engine.
- [Phase ?]: [Phase 03.1-08]: Pin BoundedIdCache, decideCommitAuthorization, and getGroupMemberPubkeys as intended root runtime API.
- [Phase ?]: [Phase 03.1-11]: Keep the D-16 citation gate scoped to the exact ten-file Phase-3-touched manifest.
- [Phase ?]: [Phase 03.1-11]: Map Welcome rotation citations to protocol-core/joining.md and admin/commit citations to protocol-core/group-messaging.md.
- [Phase ?]: Complete auto-commit publication and confirmation or rollback before yielding autoCommit to the consumer.
- [Phase ?]: Retain confirmed notifications locally so successful delivery remains autoCommit followed immediately by appliedNotifications.
- [Phase ?]: [Phase 03.1-14]: Route publishEffects and legacy publishProposal through one proposal result helper so acknowledgement semantics cannot drift.
- [Phase ?]: [Phase 03.1-14]: Invoke publishFailed only before relay acknowledgement; confirmation and persistence failures remain inspectable and non-retryable afterward.
- [Phase ?]: [Phase 03.1-13]: Failed activation cleanup is guarded by exact group and listener identity before cache eviction.
- [Phase ?]: [Phase 03.1-13]: Durable removal completes internal cancellation before independently isolated application callbacks.

### Pending Todos

None yet.

### Blockers/Concerns

- [Resolved in 03-03]: CONV-04 verify-first ran; Assumption A1 was falsified for one of the two D-16 properties (own-commit replay) and fixed narrowly in `fork-recovery.ts` — see 03-03-SUMMARY.md "CONV-04 verdict"
- Pre-existing (from 03-01): src/__tests__/exports.test.ts snapshot stale + pnpm lint fails on refs/mdk/target/ noise — logged in phase deferred-items.md, not fixed in 03-02

### Roadmap Evolution

- Phase 03.1 inserted after Phase 3: Phase 3 Review Closure - close round-3 findings as planned work (URGENT)
- Phase 04.1 inserted after Phase 4: Terminal Group Disbanding - new marmot.group.lifecycle.v1 spec scope

## Quick Tasks Completed

| Date       | Slug                       | Summary                                                                                          |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| 2026-08-06 | reference-findings-phase-4 | Rolled marmot/mdk submodule findings into Phase 4; added standing per-phase reference-check rule |

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

Last session: 2026-09-04T14:00:05.182Z
Stopped at: Phase 4 UI-SPEC approved
Resume file:
.planning/phases/04-feature-parity-conformance-vectors/04-UI-SPEC.md
