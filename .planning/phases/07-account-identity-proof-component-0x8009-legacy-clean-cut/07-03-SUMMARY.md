---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 03
subsystem: testing
tags: [mls, key-package, account-identity-proof, vitest, engine]

# Dependency graph
requires:
  - phase: 07-02
    provides: "Core generateKeyPackage's additive signer?: AuthorizationProofSigner option, and src/__tests__/helpers/test-accounts.ts's testAccount(slot) deterministic account helper"
provides:
  - "All 17 engine test files build every KeyPackage with a real testAccount() signer whose pubkey matches the credential identity (D-02)"
  - "No engine test file constructs a proof-less KeyPackage; the signer gate over all 17 files exits 0"
affects: [07-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Engine test fixtures assign testAccount() slots in ascending order matching the original literal pubkeys' lexicographic order, so tie-break-sensitive assertions (admin ordering, same-epoch commit-digest races) keep their original outcome"
    - "A local setup helper taking a bare pubkey string (createTestGroupState) was changed to take the PrivateKeyAccount directly and pass its signer through, per migration rule 6"

key-files:
  created: []
  modified:
    - src/engine/__tests__/commit-legality-seams.test.ts
    - src/engine/__tests__/commit-authorization-seams.test.ts
    - src/engine/__tests__/send-commit-legality.test.ts
    - src/engine/__tests__/group-engine.test.ts
    - src/engine/__tests__/disband-request.test.ts
    - src/engine/__tests__/disband-convergence.test.ts
    - src/engine/__tests__/ingest-deferred.test.ts
    - src/engine/__tests__/message-dedup.test.ts
    - src/engine/__tests__/convergence-status.test.ts
    - src/engine/__tests__/history-tree.test.ts
    - src/engine/__tests__/history-tree-ingest.test.ts
    - src/engine/__tests__/ingestion-pool.test.ts
    - src/engine/__tests__/retained-store.test.ts
    - src/engine/__tests__/self-eviction.test.ts
    - src/engine/__tests__/state-notification-withdrawal.test.ts
    - src/engine/__tests__/convergence-parity.test.ts
    - src/engine/__tests__/convergence-scheduling.test.ts

key-decisions:
  - "Used the plan's default slot mapping throughout (\"2\"->0, \"3\"->1, \"a\"->6, \"d\"->9, \"e\"->11), so every migrated identity kept its original relative lexicographic order across all 17 files without needing to invent new slots"
  - "createTestGroupState (group-engine.test.ts) changed its signature from (adminPubkey: string, ciphersuiteImpl) to (account: PrivateKeyAccount, ciphersuiteImpl), per migration rule 6, rather than adding a parallel signer parameter"
  - "Replaced getPublicKey-only EventSigner stubs (disband-convergence.test.ts, state-notification-withdrawal.test.ts) with the same testAccount's real .signer, and dropped the now-unused EventSigner import from state-notification-withdrawal.test.ts, since these stood for the same account identity a migrated KeyPackage credential elsewhere in the same fixture already used"

patterns-established:
  - "Module-level ADMIN/MEMBER-style constants in an engine test file are now module-level testAccount() instances (e.g. `const ADMIN_ACCOUNT = testAccount(6); const ADMIN = ADMIN_ACCOUNT.pubkey;`) instead of literal repeat(64) strings, so both the pubkey and signer stay in scope wherever the original literal did"

requirements-completed: []

coverage:
  - id: D1
    description: "Every generateKeyPackage call across the 17 engine test files passes a real signer whose pubkey equals the KeyPackage credential identity"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "signer gate (node one-liner from 07-03-PLAN.md context) over all 17 files"
        status: pass
      - kind: unit
        ref: "pnpm vitest run src/engine (132 tests across 21 files)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Identity reassignment in ordering-sensitive files (convergence-parity.test.ts, self-eviction.test.ts, state-notification-withdrawal.test.ts) preserves original tie-break outcomes; no assertion weakened or re-baselined"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "pnpm vitest run src/engine/__tests__/convergence-parity.test.ts (7/7 pass, including the two digest-search own-commit-vs-sibling tests and the dual-ordering test)"
        status: pass
      - kind: unit
        ref: "pnpm vitest run src/engine/__tests__/state-notification-withdrawal.test.ts (14/14 pass, including the two re-drawn-digest-search withdrawal tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "No production file, export, or fixture changed by this plan"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "git diff --stat HEAD -- src ':(exclude)src/**/__tests__/**' ':(exclude)src/__tests__/**' (empty)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full suite and typecheck stay green after the migration"
    verification:
      - kind: unit
        ref: "pnpm vitest run (full suite, 99 files / 1102 tests)"
        status: pass
      - kind: other
        ref: "pnpm exec tsc -p tsconfig.json --noEmit"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-14
status: complete
---

# Phase 07 Plan 03: Engine Test Real-Signer Migration Summary

**All 17 engine test files under `src/engine/__tests__/` now build every KeyPackage with a real `testAccount()` signer matching the credential identity, using order-preserving slots so tie-break-sensitive assertions (admin/member ordering, same-epoch commit-digest races) are unchanged in outcome.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 17 (0 created)

## Accomplishments

- Migrated 9 engine test files (Task 1: commit-legality/authorization seams, send-commit-legality, group-engine, disband-request, disband-convergence, ingest-deferred, message-dedup, convergence-status) to pass `signer: testAccount(slot).signer` on every `generateKeyPackage` call, replacing literal `"a".repeat(64)`-style test pubkeys with deterministic accounts drawn from `src/__tests__/helpers/test-accounts.ts` in the plan's order-preserving slot mapping (`"a"`→6, `"d"`→9, `"e"`→11, `"2"`→0, `"3"`→1).
- Migrated the remaining 8 engine test files (Task 2: history-tree, history-tree-ingest, ingestion-pool, retained-store, self-eviction, state-notification-withdrawal, convergence-parity, convergence-scheduling), including the three files the plan flagged as ordering-sensitive (`convergence-parity.test.ts`, `self-eviction.test.ts`, `state-notification-withdrawal.test.ts`) — every pair of identities that was previously ordered (admin vs. members, member1 vs. member2) kept the same relative order after migration, and all digest-search own-commit / dual-ordering / withdrawal tests still pass on first run with no re-baselining.
- `group-engine.test.ts`'s local `createTestGroupState` helper was changed to take a `PrivateKeyAccount` directly (per migration rule 6) rather than a bare pubkey string, so its one call site threads a real signer through without adding a parallel parameter.
- Left the one hand-built forged-proof test in `group-engine.test.ts` (`rejects a commit that adds a leaf with a forged account identity proof`) unchanged, as instructed — it constructs a leaf by hand via the legacy `account-identity-proof.js` module and never calls `generateKeyPackage`.
- The signer gate from the plan's context — a Node one-liner that flags any `generateKeyPackage({...})` call lacking a `signer` key — prints nothing and exits 0 across all 17 files.

## Task Commits

1. **Task 1: Real signers in commit-legality, authorization, engine, disband, and dedup engine tests** - `435b982` (test)
2. **Task 2: Real signers in history-tree, ingestion-pool, retained-store, eviction, withdrawal, and convergence engine tests** - `adbd61a` (test)

**Plan metadata:** pending (this SUMMARY + STATE/ROADMAP update commit)

## Files Created/Modified

- `src/engine/__tests__/commit-legality-seams.test.ts` - `fourPartyEpoch1Group` fixture, the send-after-removal test's `actorPubkey`, and the non-admin-add test's third identity now use `testAccount()` slots 6/0/1/9/11
- `src/engine/__tests__/commit-authorization-seams.test.ts` - `memberGroup` fixture (admin/member/sibling) migrated; the unrelated-leaf-credential test destructures `adminPubkey` from the fixture instead of a module-scope literal
- `src/engine/__tests__/send-commit-legality.test.ts` - `twoAdminGroup`, `twoLeafAdminGroup`, and `twoAdminGroupWithJoin` fixtures migrated (22 tests span these three fixtures)
- `src/engine/__tests__/group-engine.test.ts` - `createTestGroupState` retyped to take a `PrivateKeyAccount`; six inline fixtures (lifecycle, own-echo dedup, admin verification x2, retained-history pruning, content-dedup `twoMemberGroup`) migrated; forged-proof test left untouched
- `src/engine/__tests__/disband-request.test.ts` - `engineFixture`'s admin identity and the demoted-admin test's admin-policy rewrite migrated
- `src/engine/__tests__/disband-convergence.test.ts` - Four tests' `admin`/`member` locals migrated; the write-ahead-crash test's `getPublicKey`-only `EventSigner` stub replaced with the real account signer, dropping the now-unused `EventSigner` import
- `src/engine/__tests__/ingest-deferred.test.ts` - Single admin fixture migrated
- `src/engine/__tests__/message-dedup.test.ts` - Single admin fixture migrated
- `src/engine/__tests__/convergence-status.test.ts` - Single admin fixture migrated
- `src/engine/__tests__/history-tree.test.ts` - Module-level `ADMIN`/`MEMBER` constants now derive from `testAccount(6)`/`testAccount(11)`
- `src/engine/__tests__/history-tree-ingest.test.ts` - Same module-level constant migration
- `src/engine/__tests__/ingestion-pool.test.ts` - Same module-level constant migration, applied at both call sites
- `src/engine/__tests__/retained-store.test.ts` - `buildStoreWithHistory` fixture migrated
- `src/engine/__tests__/self-eviction.test.ts` - Module-level `ADMIN_ACCOUNT`/`D_ACCOUNT`/`E_ACCOUNT` constants back `buildRemovalFixture`, `arbitraryEnvelope`'s sender pubkey, and the removed-member `send()` test's `actorPubkey`
- `src/engine/__tests__/state-notification-withdrawal.test.ts` - `twoMemberEpoch1Group` and two inline three-party fixtures migrated; two `getPublicKey`-only `EventSigner` stubs replaced with `testAccount(11).signer`, dropping the now-unused `EventSigner` import
- `src/engine/__tests__/convergence-parity.test.ts` - `threeMemberEpoch1Group`, `twoMemberEpoch1Group`, and the two-link-own-branch test's `joiningKp` migrated
- `src/engine/__tests__/convergence-scheduling.test.ts` - Single admin fixture migrated

## Decisions Made

- Used the plan's default slot mapping everywhere a literal appeared, so no new slot choices were needed beyond the ones the plan enumerated.
- `createTestGroupState`'s signature change (pubkey string → `PrivateKeyAccount`) is a minimal, single-call-site change per migration rule 6, not a new parallel option.
- Two `getPublicKey`-only `EventSigner` stubs (disband-convergence.test.ts, state-notification-withdrawal.test.ts) were replaced with the corresponding real `testAccount` signer rather than left as-is, since they stood for the same account identity already migrated elsewhere in the same fixture (migration rule 3: "use that same variable everywhere the literal meant the same identity").

## Deviations from Plan

None - plan executed exactly as written. No assertion was weakened, deleted, or re-baselined; no assertion needed its expected value changed because none encoded a bare literal pubkey value independent of the fixture's own derived identity.

## Issues Encountered

None - all 17 files migrated cleanly on first pass; the two digest-search tests in `convergence-parity.test.ts` and the two in `state-notification-withdrawal.test.ts` (which search up to 25 attempts for a desired commit-ordering outcome) passed without needing extra attempts or investigation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 07-06 has a clean, verified precondition: the signer gate over all 17 engine test files exits 0, so making core `generateKeyPackage`'s `signer` required and removing the legacy `accountProofSigner` path will not break the engine suite.
- Full suite green: `pnpm vitest run` (99 files / 1102 tests), `pnpm vitest run src/engine` (21 files / 132 tests), and `pnpm exec tsc -p tsconfig.json --noEmit` all pass.
- Plans 07-04 and 07-05 (sibling test migrations for core/client and integration/conformance) can proceed independently on this same tree; this plan touched only the 17 files listed above.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

- FOUND: src/engine/__tests__/commit-legality-seams.test.ts
- FOUND: src/engine/__tests__/commit-authorization-seams.test.ts
- FOUND: src/engine/__tests__/send-commit-legality.test.ts
- FOUND: src/engine/__tests__/group-engine.test.ts
- FOUND: src/engine/__tests__/disband-request.test.ts
- FOUND: src/engine/__tests__/disband-convergence.test.ts
- FOUND: src/engine/__tests__/ingest-deferred.test.ts
- FOUND: src/engine/__tests__/message-dedup.test.ts
- FOUND: src/engine/__tests__/convergence-status.test.ts
- FOUND: src/engine/__tests__/history-tree.test.ts
- FOUND: src/engine/__tests__/history-tree-ingest.test.ts
- FOUND: src/engine/__tests__/ingestion-pool.test.ts
- FOUND: src/engine/__tests__/retained-store.test.ts
- FOUND: src/engine/__tests__/self-eviction.test.ts
- FOUND: src/engine/__tests__/state-notification-withdrawal.test.ts
- FOUND: src/engine/__tests__/convergence-parity.test.ts
- FOUND: src/engine/__tests__/convergence-scheduling.test.ts
- FOUND: 435b982 (test commit, Task 1)
- FOUND: adbd61a (test commit, Task 2)
