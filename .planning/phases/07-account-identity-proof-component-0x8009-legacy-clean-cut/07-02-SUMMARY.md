---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 02
subsystem: auth
tags: [mls, key-package, account-identity-proof, applesauce, vitest]

# Dependency graph
requires:
  - phase: 06-shared-authorization-proof-envelope-primitive
    provides: "src/core/authorization-proof.ts AuthorizationProofSigner (Pick<EventSigner, 'signEvent'>) type"
  - phase: 07-01
    provides: "0x8009 account identity proof component primitives (not yet wired into this plan's leaf format)"
provides:
  - "Core generateKeyPackage signer?: AuthorizationProofSigner option, tried ahead of the legacy accountProofSigner option"
  - "Every client-built leaf/KeyPackage (KeyPackagePublisher, GroupFactory, GroupsManager, KeyPackageManager, MarmotClient) proven with the client's own identity signer — no separate proof-signer option"
  - "Deterministic, pubkey-ordered test-account helper (src/__tests__/helpers/test-accounts.ts) for wave-2 plans"
  - "Raw-key proof-signer test helper deleted from both src/__tests__/helpers and the OpenTUI example"
affects: [07-03, 07-04, 07-05, 07-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client layer always threads its identity EventSigner into core generateKeyPackage's new signer option, rather than requiring a caller-supplied opt-in proof signer"
    - "Deterministic ascending-pubkey test-account slots (testAccount(slot)) replace ad hoc PrivateKeyAccount.fromKey literals in new/updated tests"

key-files:
  created:
    - src/__tests__/helpers/test-accounts.ts
    - src/__tests__/helpers/test-accounts.test.ts
  modified:
    - src/core/key-package.ts
    - src/client/key-package-publisher.ts
    - src/client/group-factory.ts
    - src/client/groups-manager.ts
    - src/client/key-package-manager.ts
    - src/client/marmot-client.ts
    - src/__tests__/conformance/named-vectors.test.ts
    - src/core/__tests__/welcome.test.ts
    - src/client/group/__tests__/invite.test.ts
    - src/client/__tests__/leave-group.test.ts
    - src/__tests__/integration/send-chat-message.test.ts
    - src/__tests__/integration/key-package-eligibility.test.ts
    - src/__tests__/integration/end-to-end-invite-join-message.test.ts
    - src/__tests__/integration/invite-listen-ensure.test.ts
    - src/__tests__/integration/group-connect.test.ts
    - src/__tests__/integration/invite-preview-canjoin.test.ts
    - examples/opentui/src/marmot/setup.ts
    - src/__tests__/groups-manager.test.ts

key-decisions:
  - "Kept the legacy accountProofSigner option and its import in core/key-package.ts (effectiveProofSigner = signer ?? accountProofSigner); only 07-06 removes it and switches the leaf format"
  - "Deleted both copies of the raw-key proof-signer helper (src/__tests__/helpers/account-proof.ts, examples/opentui/src/helpers/account-proof.ts) rather than keeping either as a deprecated shim"
  - "Committed once after both tasks, per the plan's explicit sequencing note, since Task 1 alone leaves stale option literals only the root test typecheck reports"
  - "Switched src/__tests__/groups-manager.test.ts's ADMIN fixture from a synthetic 'a'.repeat(64) pubkey + getPublicKey-only signer stub to testAccount(0) — a real signer was required once GroupsManager.create() started unconditionally threading the identity signer into generateKeyPackage"

patterns-established:
  - "Test files needing a real, deterministic Nostr identity should use src/__tests__/helpers/test-accounts.ts's testAccount(slot) rather than hand-rolled PrivateKeyAccount.fromKey literals or getPublicKey-only signer stubs"

requirements-completed: []

coverage:
  - id: D1
    description: "Core generateKeyPackage accepts signer?: AuthorizationProofSigner, tried ahead of the legacy accountProofSigner option, with no change to the emitted leaf format"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "src/core/__tests__/key-package.test.ts (existing suite, unaffected by the additive option)"
        status: pass
      - kind: integration
        ref: "src/__tests__/integration/end-to-end-invite-join-message.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "MarmotClient, GroupsManager, GroupFactory, KeyPackageManager, and KeyPackagePublisher no longer accept a separate proof-signer option; every client-built leaf is proven with the client's own identity signer"
    requirement: "CUT-01"
    verification:
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts (18 tests, including group creation through GroupsManager.create())"
        status: pass
      - kind: integration
        ref: "src/client/group/__tests__/invite.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Raw-key proof-signer test helper and its OpenTUI example copy are deleted; ten dependent test files and the example pass the account's EventSigner directly"
    requirement: "CUT-01"
    verification:
      - kind: unit
        ref: "grep -rn accountProofSignerFor src examples/opentui/src (no matches)"
        status: pass
      - kind: unit
        ref: "pnpm vitest run (full suite, 99 files / 1102 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Deterministic, pubkey-ordered test-account helper (TEST_ACCOUNT_SECRET_KEYS, testAccount(slot)) exists and is pinned for wave-2 plans"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "src/__tests__/helpers/test-accounts.test.ts (5 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The OpenTUI example still typechecks against the built package after the client option-surface narrowing"
    verification:
      - kind: other
        ref: "cd examples/opentui && ./node_modules/.bin/tsc --noEmit (after pnpm build)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-09-14
status: complete
---

# Phase 07 Plan 02: Client Identity-Signer Threading + Raw-Key Helper Cut Summary

**Every client-built KeyPackage/leaf is now proven with the client's own `signer: EventSigner` (no separate proof-signer option), via a new additive `signer` option on core `generateKeyPackage`; the raw-key test helper is deleted in favor of a deterministic, pubkey-ordered `testAccount()` fixture.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 22 (2 created, 2 deleted, 18 modified)

## Accomplishments

- `src/core/key-package.ts`'s `GenerateKeyPackageOptions` gained `signer?: AuthorizationProofSigner` (`Pick<EventSigner, "signEvent">`), tried ahead of the legacy `accountProofSigner` option inside `generateKeyPackage` via `effectiveProofSigner = signer ?? accountProofSigner`. The emitted leaf format is unchanged — this plan is wire-neutral by design.
- Removed the separate proof-signer option end to end from `KeyPackagePublisher`, `GroupFactory`, `GroupsManager` (including its public `accountProofSigner` field), `KeyPackageManager`, and `MarmotClient`. Each now passes `signer: this.#signer` (or `this.signer`) straight into `generateKeyPackage`, so every client-built leaf/KeyPackage always carries a valid account identity proof.
- Deleted `src/__tests__/helpers/account-proof.ts` and `examples/opentui/src/helpers/account-proof.ts` (the raw-key `accountProofSignerFor` adapter), per D-04.
- Added `src/__tests__/helpers/test-accounts.ts` (`TEST_ACCOUNT_SECRET_KEYS`, `testAccount(slot)`) — 16 deterministic secrets in ascending x-only-pubkey order, verified byte-exact against the plan's pinned pubkey list with `@noble/curves/secp256k1` before committing to the fixture — plus `test-accounts.test.ts` pinning slot 5 (generator-point pubkey) and slot 14 (spec vector secret key 3), strict ordering, and `RangeError` on out-of-range/non-integer slots.
- Migrated the nine test files (welcome, invite, leave-group, six integration tests, named-vectors) and the OpenTUI example off the deleted helper, passing the relevant account's `.signer` directly.

## Task Commits

Both tasks landed in a single commit, per the plan's explicit sequencing note (Task 1 alone leaves stale option literals in tests that only the root test typecheck reports):

1. **Task 1 + Task 2: Core signer option, client-wide option removal, helper deletion, test-account helper, dependent-file migration** - `1f6cdac` (feat)

**Plan metadata:** pending (this SUMMARY + STATE/ROADMAP update commit)

## Files Created/Modified

- `src/core/key-package.ts` - Added `signer?: AuthorizationProofSigner`; `effectiveProofSigner = signer ?? accountProofSigner` feeds the existing proof-extension branch
- `src/client/key-package-publisher.ts` - Removed `accountProofSigner` option/field; `generate()` now passes `signer: this.#signer`
- `src/client/group-factory.ts` - Removed `accountProofSigner` option/field; `create()` now passes `signer: this.#signer`; updated class JSDoc
- `src/client/groups-manager.ts` - Removed `accountProofSigner` option, public field, constructor assignment, and factory pass-through; updated `#factory` field comment
- `src/client/key-package-manager.ts` - Removed `accountProofSigner` option and its pass-through into `KeyPackagePublisher`
- `src/client/marmot-client.ts` - Removed `accountProofSigner` option and both pass-throughs; extended `signer` JSDoc to note it also signs the kind-450 proof
- `src/__tests__/helpers/test-accounts.ts` (new) - `TEST_ACCOUNT_SECRET_KEYS`, `testAccount(slot)`
- `src/__tests__/helpers/test-accounts.test.ts` (new) - Pins ordering and known pubkeys
- `src/__tests__/helpers/account-proof.ts` (deleted) - Raw-key `accountProofSignerFor` adapter
- `examples/opentui/src/helpers/account-proof.ts` (deleted) - Same, example copy
- `src/core/__tests__/welcome.test.ts` - Dropped helper import; `generateKeyPackage`/`MarmotClient` calls now pass `signer:`; `wrongKeyPackage` keeps its generated account in a variable and passes its signer
- `src/client/group/__tests__/invite.test.ts` - Dropped helper import; three `generateKeyPackage` calls now pass `signer: invitee.signer`
- `src/client/__tests__/leave-group.test.ts` - Dropped helper import; three `MarmotClient` constructions dropped the now-redundant `accountProofSigner` line
- `src/__tests__/integration/{send-chat-message,key-package-eligibility,end-to-end-invite-join-message,invite-listen-ensure,group-connect,invite-preview-canjoin}.test.ts` - Dropped helper import and the `accountProofSigner:` line from each `MarmotClient` construction
- `src/__tests__/conformance/named-vectors.test.ts` - Renamed the `generateKeyPackage` option key from `accountProofSigner` to `signer` (same value: `accounts.get(actor)!.signer`)
- `examples/opentui/src/marmot/setup.ts` - Dropped helper import and the `accountProofSigner:` line from the `MarmotClient` construction
- `src/__tests__/groups-manager.test.ts` - Deviation fix (see below): `ADMIN` fixture switched from a synthetic pubkey + `getPublicKey`-only signer stub to `testAccount(0)`

## Decisions Made

- Kept the legacy `accountProofSigner` option and its `account-identity-proof.js` import in `core/key-package.ts`. Per D-01/D-02 sequencing, only plan 07-06 removes both and makes `signer` required, swapping the leaf format atomically with the verifier seams.
- Verified all 16 `TEST_ACCOUNT_SECRET_KEYS` against the plan's pinned expected pubkeys with a throwaway `@noble/curves/secp256k1` script before writing the fixture, rather than trusting transcription by eye.
- Single commit after both tasks (plan's explicit instruction): Task 1's client-wide option removal alone would leave test files with stale `accountProofSigner:` object-literal properties that only the root `tsconfig.json` typecheck (not `pnpm compile`, which excludes tests) would report.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed `src/__tests__/groups-manager.test.ts`'s ADMIN signer stub, which broke once GroupsManager.create() started always requiring a working signEvent**
- **Found during:** Task 2 full-suite verification (`pnpm vitest run`)
- **Issue:** This file (not in the plan's `files_modified` list) built its `ADMIN` identity as `"a".repeat(64)` with a `{ getPublicKey: async () => ADMIN } as EventSigner` stub — no real keypair, no `signEvent`. Before this plan, `GroupFactory.create()` only called into the account-identity-proof branch when a caller-supplied `accountProofSigner` was present, so the stub was never exercised. After Task 1 (D-01: the client always threads its identity signer into `generateKeyPackage`), every `GroupsManager.create()` call unconditionally attempts to build a real BIP-340 account identity proof, so `signer.signEvent` is now always invoked — 16 tests failed with `params.signer.signEvent is not a function`.
- **Fix:** Replaced the synthetic `ADMIN` pubkey and stub signer with `testAccount(0)` (a real `PrivateKeyAccount` from this plan's new deterministic helper): `const ADMIN_ACCOUNT = testAccount(0); const ADMIN = ADMIN_ACCOUNT.pubkey;`, and swapped every `{ getPublicKey: async () => ADMIN } as EventSigner` occurrence for `ADMIN_ACCOUNT.signer`. `ADMIN`'s string value is still used identically elsewhere in the file (e.g. `actorPubkey: ADMIN` in a disband-tombstone fixture), so no other assertions changed.
- **Files modified:** src/__tests__/groups-manager.test.ts
- **Verification:** `pnpm exec tsc -p tsconfig.json --noEmit` exits 0; `pnpm vitest run src/__tests__/groups-manager.test.ts` — 18/18 pass; full `pnpm vitest run` — 99 files / 1102 tests pass.
- **Committed in:** `1f6cdac` (same commit as both plan tasks)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the full test suite green per the plan's own verification gate (`pnpm vitest run` exits 0); no scope creep — used the plan's own new `testAccount()` infrastructure rather than inventing a parallel fixture.

## Issues Encountered

- The Task 2 acceptance-criteria grep (`grep -rln "accountProofSigner" src/__tests__/integration src/__tests__/conformance src/client examples/opentui/src src/core/__tests__/welcome.test.ts`) also matches `src/client/group/proposals/__tests__/invite-user.test.ts`, which is outside this plan's declared scope (not in `files_modified`, not among the nine files the CONTEXT explicitly enumerates as importing the deleted helper). That file calls core `generateKeyPackage` directly with the legacy digest-function form of `accountProofSigner` (`(request) => signAccountIdentityProof(request, secretKey)`), which core still supports in this plan by design (removed only in 07-06). Left unmodified as correctly out of scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 07-03, 07-04, and 07-05 (wave 2, parallel) can now use `testAccount(slot)` from `src/__tests__/helpers/test-accounts.ts` to replace literal test pubkeys with real signers, per D-02 groundwork.
- Plan 07-06 has a clean seam to remove the legacy `accountProofSigner` option and its import from `src/core/key-package.ts`, make `signer` required, and swap the leaf format together with the verifier seams — no other file in the client layer references the legacy option anymore.
- Full suite green: `pnpm compile`, `pnpm exec tsc -p tsconfig.json --noEmit`, `pnpm build && (cd examples/opentui && ./node_modules/.bin/tsc --noEmit)`, and `pnpm vitest run` (99 files / 1102 tests) all pass.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*
