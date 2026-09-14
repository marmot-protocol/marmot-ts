---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 05
subsystem: testing
tags: [mls, key-package, account-identity-proof, applesauce, vitest, conformance]

# Dependency graph
requires:
  - phase: 07-02
    provides: "Core generateKeyPackage signer?: AuthorizationProofSigner option; deterministic testAccount(slot) helper (src/__tests__/helpers/test-accounts.ts)"
provides:
  - "Every generateKeyPackage call in the nine heaviest integration test files (commit races, removal, self-remove, convergence, persistence, replay) and three conformance runners (adapter, smoke, extended) passes a real signer whose pubkey equals the credential identity"
  - "Race, removal, and convergence identity ordering preserved via the plan's order-preserving slot mapping (a->6, d->9, e->11)"
affects: [07-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level ADMIN/MEMBER string constants converted to ADMIN_ACCOUNT/MEMBER_ACCOUNT testAccount(slot) pairs, with the pubkey derived as a const so every downstream reference (including unrelated getPublicKey-only EventSigner stubs) stays consistent without further edits"
    - "Local setup helpers (createTestGroupState, buildRemovalFixture, buildForkScenario, buildMemberState) retyped to take an account/PrivateKeyAccount rather than a bare pubkey string, per migration rule 6"

key-files:
  created: []
  modified:
    - src/__tests__/integration/ingest-commit-race.test.ts
    - src/__tests__/integration/removed.test.ts
    - src/__tests__/integration/self-remove.test.ts
    - src/__tests__/integration/convergence-status.test.ts
    - src/__tests__/integration/own-proposal-snapshot.test.ts
    - src/__tests__/integration/history-tree-persistence.test.ts
    - src/__tests__/integration/app-message-replay-restart.test.ts
    - src/__tests__/integration/rewind-persistence.test.ts
    - src/__tests__/integration/self-update-persistence.test.ts
    - src/__tests__/conformance/adapter.test.ts
    - src/__tests__/conformance/smoke.test.ts
    - src/__tests__/conformance/extended.spec.ts

key-decisions:
  - "ingest-commit-race.test.ts's shared createTestGroupState(adminPubkey, impl) helper was retyped to createTestGroupState(adminAccount, impl), deriving adminPubkey internally, since every one of its 8 call sites needed the same account-carrying signature (migration rule 6)"
  - "Left existing getPublicKey-only EventSigner stubs (e.g. `{ getPublicKey: async () => memberPubkey } as EventSigner` used to construct MarmotGroup/GroupsManager in these files) untouched beyond swapping the underlying literal for the derived account pubkey — those stubs represent the local client's own identity for message-signing paths this plan does not touch, not the generateKeyPackage credential signer"
  - "app-message-replay-restart.test.ts's alice/bob/carol scenario already used PrivateKeyAccount.generateNew() (random, not literal-pubkey) accounts; only added the missing signer: <account>.signer to their three generateKeyPackage calls rather than introducing testAccount slots"
  - "adapter.test.ts and smoke.test.ts's single-member scenarios (no ordering constraint with other identities) both use testAccount(6), matching the plan's 'a' -> slot 6 mapping used throughout"

patterns-established: []

requirements-completed: []

coverage:
  - id: D1
    description: "Every generateKeyPackage call in the nine integration test files and three conformance files passes a real signer whose pubkey equals the credential identity"
    requirement: "PROOF-03"
    verification:
      - kind: other
        ref: "Signer gate (node one-liner from 07-05-PLAN.md) over all 12 files_modified — exits 0, no output"
        status: pass
      - kind: unit
        ref: "pnpm vitest run (full suite) — 99 files / 1102 tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "Signers are PrivateKeyAccount.signer instances passed directly, drawn from accounts already in scope or testAccount(slot)"
    requirement: "PROOF-03"
    verification:
      - kind: other
        ref: "git diff review of all 12 files_modified — every signer: value is <account>.signer where account is testAccount(N), PrivateKeyAccount.generateNew(), or accounts.get(client)! (extended.spec.ts's pre-existing accounts map)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Identity order used by race, removal, and convergence scenarios is preserved, and no assertion is weakened or re-baselined"
    verification:
      - kind: unit
        ref: "src/__tests__/integration/ingest-commit-race.test.ts, removed.test.ts, self-remove.test.ts, convergence-status.test.ts (24 tests, unchanged assertions)"
        status: pass
      - kind: other
        ref: "grep for repeat(64) inside toBe/toEqual/expect() across all 12 files — no matches (no assertion encodes a literal pubkey)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The root Vitest suite and the extended conformance suite (pnpm conformance:extended) both pass with production code untouched"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "pnpm vitest run — 99 files / 1102 tests passed"
        status: pass
      - kind: integration
        ref: "pnpm conformance:extended — 1 file / 1 test passed"
        status: pass
      - kind: other
        ref: "pnpm exec tsc -p tsconfig.json --noEmit — exits 0"
        status: pass
      - kind: other
        ref: "git diff --stat HEAD -- src ':(exclude)src/**/__tests__/**' ':(exclude)src/__tests__/**' — empty (no production file changed)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-14
status: complete
---

# Phase 07 Plan 05: Real Signers in Race, Removal, Convergence, Persistence, and Conformance Tests Summary

**Every `generateKeyPackage` call across the heaviest 12 integration/conformance test files (commit races, removal, convergence, restart persistence, adapter/smoke/extended conformance runners) now passes a real `PrivateKeyAccount.signer` matching its credential identity, using the plan's deterministic order-preserving `testAccount(slot)` mapping — no wire behavior, production file, or assertion changed.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 12 (0 created, 12 modified)

## Accomplishments

- **Task 1** (commit-race, removal, self-remove, convergence-status): migrated 4 files covering the heaviest multi-scenario race/removal/convergence integration suites. `ingest-commit-race.test.ts`'s shared `createTestGroupState` helper now takes a `PrivateKeyAccount` and threads its `.signer` into `generateKeyPackage`; all 8 per-scenario `adminPubkey`/`memberPubkey`/`cPub`/`dPub`/`member1Pubkey`/`member2Pubkey` declarations now derive from `testAccount(6)` ("a"), `testAccount(9)` ("d"), and `testAccount(11)` ("e") per the plan's slot mapping. `removed.test.ts`, `self-remove.test.ts`, and `convergence-status.test.ts` got the same treatment in their single/shared fixture-building functions.
- **Task 2** (persistence, replay, conformance runners): migrated the remaining 5 integration files (own-proposal-snapshot, history-tree-persistence, app-message-replay-restart, rewind-persistence, self-update-persistence) and 3 conformance files (adapter, smoke, extended). Module-level `ADMIN`/`MEMBER`/`MEMBER_PUBKEY` string constants were converted to `<NAME>_ACCOUNT = testAccount(slot)` pairs with the pubkey derived as `<NAME>_ACCOUNT.pubkey`, so every existing reference elsewhere in each file (including unrelated `getPublicKey`-only `EventSigner` stubs used to construct `MarmotGroup`) picked up the real derived pubkey automatically. `extended.spec.ts` gained `signer: accounts.get(client)!.signer` on its single `generateKeyPackage` call site, reusing the file's pre-existing `accounts` map. `app-message-replay-restart.test.ts`'s alice/bob/carol scenario already used `PrivateKeyAccount.generateNew()`; only the missing `signer:` lines were added.
- Signer gate (the plan's Node one-liner) run over all 12 `files_modified` prints nothing and exits 0.
- Full `pnpm vitest run` (99 files / 1102 tests), `pnpm conformance:extended` (1/1), and `pnpm exec tsc -p tsconfig.json --noEmit` all pass with zero production `src/` files touched.

## Task Commits

1. **Task 1: Real signers in commit-race, removal, self-remove, and convergence-status integration scenarios** - `c860e4d` (test)
2. **Task 2: Real signers in persistence and replay integration tests and the conformance runners** - `5d2dd9c` (test)

**Plan metadata:** pending (this SUMMARY + STATE/ROADMAP update commit)

## Files Created/Modified

- `src/__tests__/integration/ingest-commit-race.test.ts` - `createTestGroupState` retyped to take a `PrivateKeyAccount`; all 8 scenarios' admin/member/cPub/dPub/member1/member2 identities derived from `testAccount(6/9/11)` with `signer:` on every `generateKeyPackage` call
- `src/__tests__/integration/removed.test.ts` - `buildRemovalFixture`'s admin/d/e identities derived from `testAccount(6/9/11)`, threaded as `signer:` into the 3-member group's KeyPackages
- `src/__tests__/integration/self-remove.test.ts` - Same 3-member admin/d/e pattern in the single self-remove scenario
- `src/__tests__/integration/convergence-status.test.ts` - Both 2-member scenarios' admin/d identities derived from `testAccount(6/9)`
- `src/__tests__/integration/own-proposal-snapshot.test.ts` - Module-level `ADMIN`/`MEMBER` converted to `ADMIN_ACCOUNT`/`MEMBER_ACCOUNT` (`testAccount(6/9)`)
- `src/__tests__/integration/history-tree-persistence.test.ts` - Module-level `MEMBER` converted to `MEMBER_ACCOUNT` (`testAccount(11)`); inline admin literal converted to a local `testAccount(6)` account
- `src/__tests__/integration/app-message-replay-restart.test.ts` - alice/bob/carol scenario's 3 `generateKeyPackage` calls gained `signer: <account>.signer`; second scenario's admin/member literals converted to `testAccount(6/9)`
- `src/__tests__/integration/rewind-persistence.test.ts` - Module-level `MEMBER_PUBKEY` converted to `MEMBER_ACCOUNT` (`testAccount(11)`); `buildForkScenario`'s admin identity converted to `testAccount(6)`
- `src/__tests__/integration/self-update-persistence.test.ts` - Module-level `MEMBER`/`ADMIN` converted to `MEMBER_ACCOUNT`/`ADMIN_ACCOUNT` (`testAccount(11/6)`)
- `src/__tests__/conformance/adapter.test.ts` - Two independent single-member scenarios' inline pubkey literals converted to `testAccount(6)`
- `src/__tests__/conformance/smoke.test.ts` - Single-member scenario's inline pubkey literal converted to `testAccount(6)`
- `src/__tests__/conformance/extended.spec.ts` - Added `signer: accounts.get(client)!.signer` to the existing `generateKeyPackage` call inside the `packages` map construction

## Decisions Made

- Kept every existing `getPublicKey`-only `EventSigner` stub used for `MarmotGroup`/`GroupsManager` construction as-is (not converted to a real `.signer`), since these tests' `group.ingest(...)` paths in this plan's scope never invoke `signEvent` on that identity — only the underlying pubkey literal was replaced with the account-derived value for consistency (migration rule 3). Converting these stubs to full signers is out of this plan's scope (`generateKeyPackage` calls only).
- `ingest-commit-race.test.ts`'s `createTestGroupState` helper signature change (bare pubkey string -> `PrivateKeyAccount`) is the only non-mechanical structural edit in this plan; it was necessary because the helper itself calls `generateKeyPackage` internally and is called from all 8 scenarios (migration rule 6).
- Left `adapter.test.ts`/`smoke.test.ts`'s independent single-member scenarios on the same `testAccount(6)` slot ("a") rather than inventing new slots, since neither scenario has a second identity in the same test to order against.

## Deviations from Plan

None - plan executed exactly as written. No assertion was weakened, deleted, or re-baselined; none encoded a literal pubkey value that needed updating (verified via grep across all 12 files for `repeat(64)` inside `expect(...)`/`toBe`/`toEqual`).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 07-06 can now make core `generateKeyPackage`'s `signer` option required and remove the legacy `accountProofSigner` option/import, since every `generateKeyPackage` call across the full test suite (this plan's 12 files, plus 07-02/07-03/07-04's files) now passes a real signer.
- Full suite green: `pnpm vitest run` (99 files / 1102 tests), `pnpm exec tsc -p tsconfig.json --noEmit`, and `pnpm conformance:extended` (1/1) all pass.
- No production `src/` file was touched by this plan (wire-neutral groundwork, per its objective).

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

- FOUND: all 12 files_modified (ingest-commit-race, removed, self-remove, convergence-status, own-proposal-snapshot, history-tree-persistence, app-message-replay-restart, rewind-persistence, self-update-persistence, adapter, smoke, extended.spec)
- FOUND: c860e4d (test commit, Task 1)
- FOUND: 5d2dd9c (test commit, Task 2)
