---
phase: 04-feature-parity-conformance-vectors
verified: 2026-09-05T17:32:00Z
status: passed
score: 13/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 10/13
  gaps_closed:
    - "Fault fixtures now exercise their production persistence and rollback seams."
    - "The isolated offline-catchup fixture passes repeatedly with deterministic actors and canonical output batches."
    - "Named fixtures derive the expected winner before recovery and assert exact branch, digest, committer, rule, quorum, score, membership, and profile evidence."
  gaps_remaining: []
  regressions: []
---

# Phase 4: Feature Parity & Conformance Vectors Verification Report

**Phase Goal:** Match MDK SafeAAD bytes, execute MDK conformance vectors as cross-implementation checks, and structurally close own-commit convergence recovery defects with confirm-time evidence.
**Verified:** 2026-09-05T17:32:00Z
**Status:** passed
**Re-verification:** Yes — after gap-fix commits through 29eb4e9

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Leaf/KeyPackage app-components advertise `0x0001` plus empty SafeAAD `0x0002`, while group state rejects SafeAAD. | ✓ VERIFIED | `makeLeafAppComponentsExtension()` emits both entries in `src/core/components/dictionary.ts`; `generateKeyPackage()` wires it into real LeafNodes. Dictionary tests include byte-exact real-KeyPackage and rejection cases and passed independently. |
| 2 | All three pinned `nostr-routing-v1` byte fixtures execute against production codecs, including duplicate rejection. | ✓ VERIFIED | `src/core/components/__tests__/nostr-routing.test.ts` imports the three MDK JSON fixtures and invokes production decode/encode; 3/3 passed. |
| 3 | Named convergence/admin/fork MDK vectors execute as automated parity scenarios. | ✓ VERIFIED | All six run through deterministic real actors and production fork recovery. Candidate branch tag, wire digest, authenticated committer, membership, and profile are captured before recovery. The expected winner is independently derived from fixture witness semantics or authenticated-committer ordering and compared with production telemetry; swapped loser telemetry fails the real fixture oracle. |
| 4 | Rust-signed proof-v2 is a permanent automated production-code verification. | ✓ VERIFIED | Repository fixture `src/__tests__/fixtures/proof-v2-rust.json` is exercised by production proof decoding/signature verification and mutation rejection in `darkmatter-invite-compat.test.ts`; 9/9 file tests passed. |
| 5 | Confirmed own commits persist authenticated committer, authorization-aware priority, sorted consumed references, and exact wire bytes without recovery-time proposal reconstruction. | ✓ VERIFIED | `group-engine.ts` creates the stamp before confirmation; `confirmPublished()` records it; `own-commit-stamp.ts` version-encodes/sorts it and identities remain SHA-256 of wire bytes; history upgrades bare observed edges safely. Own-stamp and convergence-parity tests passed. The only `framedCommitProposalsWithSender` call remains in general wire-format parsing, not the own-commit recovery path. |
| 6 | Missing-parent commits defer within the authenticated epoch horizon and expire only when `tip - source > maxRewindCommits`, including Infinity; retryable capacity is not consumed. | ✓ VERIFIED | `IngestionPool.evictStale()` uses the exact strict epoch predicate and retains unknown epochs; source epochs feed pruning pins. Focused boundary, Infinity, capacity, parent-resolution, and anchor tests passed. |
| 7 | Restart-delivery and both publish-failure JSON vectors execute as automated fault tests. | ✓ VERIFIED | The restart fixture drives a real three-member MLS state through persisted reload plus duplicate delivery and asserts one processing result. Both publish fixtures drive GroupRuntime failure paths, assert rollback instead of confirmation/save, and prevent Welcome delivery. Focused tests passed. |
| 8 | Cross-implementation comparison uses the canonical snapshot projection. | ✓ VERIFIED | `snapshot.ts` projects group id, epoch, SHA-256 GroupContext, domain-bound exporter commitment, indexed leaves/capabilities, required capabilities, app dictionary, lifecycle, convergence status, gates, unresolved publications, dispositions, and outputs; strict deep validation and live-MLS adapter tests passed. |
| 9 | Policy v1 has a fixed 5000 ms monotonic pass deadline, unsafe lifecycle admission gates, retained continuation, and one-attempt local-intent fairness. | ✓ VERIFIED | `src/core/convergence.ts`, pass state in `types.ts`, and scheduler wiring in `group-engine.ts`/`marmot-group.ts` are substantive. Nine scheduling tests covering immutable deadline, exact boundary, PendingPublish/Merging, continuation, liveness, and fairness passed. |
| 10 | Terminal wrapper identity and withdrawal/re-adoption effects survive restart with explicit persistence capability. | ✓ VERIFIED | V3 prepared/applied evidence in `wrapper-ledger.ts` is wired through session/group/client construction; restart replay and exactly-once effect tests passed. |
| 11 | Manifest loading is strict, fixture paths cannot escape the pinned vector root, and unsupported capabilities are explicit. | ✓ VERIFIED | `manifest.ts` validates exact record shapes and root containment; adapter tests cover absolute/traversal rejection and typed capability reporting. |
| 12 | Every portable manifest entry is represented; none silently disappears. | ✓ VERIFIED | Smoke generates cases for all 31 portable manifest entries and a count-equality assertion; 33/33 smoke tests passed. This representation does not satisfy Truths 3 or 7's stronger execution requirement. |
| 13 | Offline-catchup pressure is deterministic in its isolated extended suite. | ✓ VERIFIED | Actors use fixed keys and subject outputs are canonicalized within each ingest batch. The verifier ran the isolated suite three consecutive times in fresh Vitest processes; all three passed. |

**Score:** 13/13 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/core/components/ids.ts` / `dictionary.ts` | SafeAAD ID and reference leaf dictionary | ✓ VERIFIED | Present, substantive, exported, consumed by KeyPackage creation, byte-tested. |
| `src/engine/own-commit-stamp.ts` | Versioned evidence codec and stable wire identity | ✓ VERIFIED | Present, strict decoder, wired through history and fork recovery. |
| `src/engine/ingestion-pool.ts` / `fork-recovery.ts` | Epoch-aware deferral and unified recovery | ✓ VERIFIED | Present and exercised by focused real-MLS recovery tests. |
| `src/client/group/wrapper-ledger.ts` | Durable terminal/prepared wrapper and effect evidence | ✓ VERIFIED | Present, V1/V2 compatibility plus V3 exact-result evidence, wired to session persistence. |
| `src/engine/__tests__/convergence-scheduling.test.ts` | Bounded pass and fairness coverage | ✓ VERIFIED | Nine passing behavior tests. |
| `src/__tests__/conformance/{manifest,snapshot,subject,runner}.ts` | Reusable canonical scenario boundary | ✓ VERIFIED | Strict loader, canonical snapshot, production subject actions, explicit capability handling, and scenario runner are substantive and exercised. |
| `src/__tests__/conformance/smoke.test.ts` | Portable manifest smoke and explicit capability inventory | ✓ VERIFIED | All 31 portable entries are represented; executable byte fixtures run and unsupported operations remain explicit while named semantic execution is covered separately. |
| `src/__tests__/conformance/named-vectors.test.ts` | Executed named semantic vectors | ✓ VERIFIED | Real actors, ordered steps, recovery telemetry, independently captured candidate identities, exhaustive outcome checks, and a real-fixture swapped-loser negative regression. |
| `src/__tests__/conformance/extended.spec.ts` | Deterministic offline pressure | ✓ VERIFIED | Full pinned fixture, four fixed-key production actors, terminal comparison, and three consecutive independent passes. |
| `src/__tests__/fixtures/proof-v2-rust.json` | Permanent Rust proof fixture | ✓ VERIFIED | Present and verified through production functions. |
| `vitest.extended.config.ts` | Isolated extended discovery | ✓ VERIFIED | Includes only `extended.spec.ts`; root config includes only `src/**/*.test.ts`. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| Leaf dictionary | production KeyPackage LeafNode | `makeLeafAppComponentsExtension()` in `generateKeyPackage()` | ✓ WIRED | Real-KeyPackage byte test passes. |
| Confirmed pending state | durable own-commit record | `confirmPublished()` → `#recordCommitNode()` → history store | ✓ WIRED | Stamp upgrade/reload and recovery tests pass. |
| Deferred authenticated input | horizon pins/retry | pool `sourceEpoch` → active epochs/pruning and re-ingest | ✓ WIRED | Boundary/Infinity/capacity tests pass. |
| Outer event ID | terminal wrapper ledger | GroupSession prepared/applied/terminal journal | ✓ WIRED | Crash-boundary restart tests pass. |
| Policy | immutable pass | normalized policy → open/refresh pass → drive continuation | ✓ WIRED | Scheduling tests pass. |
| MDK named scenarios | production subject/fork recovery | parse all steps → mutate real actors → compare snapshots/decision | ✓ WIRED | Expected winner evidence is captured before recovery and independently selected; actual branch, digest, committer, rule, quorum, score, membership, and profile evidence are checked. |
| Fault fixtures | production persistence/rollback | pinned inputs → GroupRuntime/MarmotGroup → fault assertions | ✓ WIRED | Focused restart and publish-failure tests pass. |
| Offline fixture | four production actors | sequential subject execution → expected outcomes | ✓ WIRED | Full fixture executes and passed three consecutive fresh processes. |

### Data-Flow Trace (Level 4)

Not applicable to rendered UI. Protocol data flows from all six fixtures through deterministic accounts, real MLS/Marmot state, fault delivery, retained witnesses, fork recovery, audit telemetry, and canonical snapshots. Expected branch, digest, committer, membership, and profile evidence are captured before recovery; fixture semantics select the expected candidate independently of production telemetry.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Six named fixtures plus real-fixture swapped telemetry regression | `CI=true npx --yes pnpm@10.18.3 vitest run src/__tests__/conformance/named-vectors.test.ts` | 7/7 passed | ✓ PASS |
| Named, convergence, scheduling, and adapter regression | Pinned pnpm Vitest over four files | 4 files, 27 tests passed | ✓ PASS |
| Offline pressure determinism | `CI=true npx --yes pnpm@10.18.3 exec vitest run --config vitest.extended.config.ts` repeated three times | 3/3 independent runs passed | ✓ PASS |
| Strict library compilation | `CI=true npx --yes pnpm@10.18.3 compile` | Exit 0 | ✓ PASS |

### Probe Execution

No phase-declared shell probes were found. The conformance Vitest suites are the executable checks and were run directly.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WIRE-04 | 04-01, 04-07 | SafeAAD reference advertisement bytes | ✓ SATISFIED | Production wiring and byte-exact focused tests pass. |
| CONF-01 | 04-01 through 04-07 | MDK routing and portable scenario vectors plus proof-v2 cross-implementation tests | ✓ SATISFIED | Routing, proof, faults, offline pressure, and the six named semantic fixtures all execute; exact convergence winner and telemetry are checked against independently captured evidence. |

No orphaned Phase 04 requirements were found: ROADMAP and REQUIREMENTS map exactly WIRE-04 and CONF-01 to this phase.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | — | No blocking anti-pattern found | — | The prior tautological identity assertion is replaced by pre-recovery candidate evidence and a swapped-loser negative regression. |

No unreferenced `TBD`, `FIXME`, or `XXX` debt markers were found in the inspected Phase 04 production and conformance files. No UI, terminal-disbanding, or runtime-matrix implementation was introduced by this phase.

### Human Verification Required

None. The blocking discrepancies are directly observable in code and reproducible tests.

### Gaps Summary

All Phase 04 gaps are closed. Commit 29eb4e9 records authored candidate evidence before recovery, derives the expected winner independently from fixture witness semantics or authenticated-committer ordering, and compares actual branch ID, wire digest, committer, rule, quorum, score, membership, and profile evidence. Its swapped-loser regression mutates telemetry from a real committer fixture and is rejected by the same oracle. WIRE-04 and CONF-01 are satisfied.

---

_Verified: 2026-09-05T17:32:00Z_
_Verifier: the agent (gsd-verifier)_
