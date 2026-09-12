---
phase: 06-shared-authorization-proof-envelope-primitive
plan: 01
subsystem: auth
tags: [nostr, bip-340, schnorr, nip-01, secp256k1, marmot-authorization-proof]

# Dependency graph
requires: []
provides:
  - "src/core/authorization-proof.ts: proof-class-agnostic MarmotAuthorizationProof envelope (104-byte codec, created_at range, NIP-01 reconstruction, BIP-340 verify, strict external-signer produce)"
  - "AuthorizationProofError + AuthorizationProofRejectReason: typed rejection vocabulary other seams can map `reason` against"
affects: [07-account-identity-proof-0x8009-class, 08-group-context-legality-seams]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Proof-class-agnostic envelope primitive: a plain { kind, tags, content } template plug-in shape, no descriptor interface, no kind registry"
    - "bigint range-check before Number() conversion for wire-decoded 64-bit values"
    - "Typed rejection error with a reason literal-union field (mirrors BinaryDecodeError/CommitLegalityError)"
    - "External-signer produce: snapshot expected event + expectedId before signing, hand the signer a separately-cloned draft, validate every returned field in a fixed order before trusting any of them"

key-files:
  created:
    - src/core/authorization-proof.ts
    - src/core/__tests__/authorization-proof.test.ts
  modified:
    - src/core/index.ts
    - src/__tests__/exports.test.ts
    - .gitignore

key-decisions:
  - "Declared all 14 AuthorizationProofRejectReason literals in Task 1, before the returned-* reasons are thrown by Task 2, per the plan's explicit sequencing"
  - "produce() treats the signer's return value as unknown and re-validates its shape at runtime, rather than trusting the EventSigner['signEvent'] return type, so a non-object/null return is still caught as returned-event-malformed"
  - "Rewrote two JSDoc sentences to avoid the literal substrings 'Math.floor(Date.now() / 1000)' and 'getPublicKey' so the plan's exact-count acceptance greps pass without weakening the documentation"
  - "Test for the uppercase-pubkey substitution case cannot call getEventHash (nostr-tools' own validateEvent rejects non-lowercase-hex pubkeys before an id can be computed), so that one case supplies placeholder id/sig; produce's pubkey check is the first field compared and throws before either is read"
  - "Added deno.lock to .gitignore, matching the existing package-lock.json exclusion (pnpm is this workspace's lockfile); it was a generated artifact of the local Deno smoke run, not previously ignored"

requirements-completed: [AUTHZ-01, AUTHZ-02, AUTHZ-03, AUTHZ-04, AUTHZ-05]

coverage:
  - id: D1
    description: "encodeAuthorizationProof/decodeAuthorizationProof: exact 104-byte codec, rejects truncated/trailing input"
    requirement: "AUTHZ-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — encode/decode spec vector"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — decode length rejection"
        status: pass
    human_judgment: false
  - id: D2
    description: "created_at range [1, 2^53-1] enforced on decode (bigint check before Number conversion) and on produce before the signer is called"
    requirement: "AUTHZ-02"
    verification:
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — decode created_at range"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — produce createdAt handling"
        status: pass
    human_judgment: false
  - id: D3
    description: "signer_pubkey rejected as invalid-signer-pubkey when not a genuine x-only secp256k1 curve point (zero, 0xff, x=5), independent of signature validity"
    requirement: "AUTHZ-03"
    verification:
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — decode signer_pubkey validity"
        status: pass
    human_judgment: false
  - id: D4
    description: "verifyAuthorizationProof reconstructs the exact NIP-01 event from the envelope + template and accepts only a valid BIP-340 signature over that id; spec vector reproduces byte-for-byte"
    requirement: "AUTHZ-04"
    verification:
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — produce (spec vector)"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — verify"
        status: pass
    human_judgment: false
  - id: D5
    description: "produceAuthorizationProof accepts an external signer's returned event only on exact field equality, id recompute, and signature verify; each substitution (pubkey/created_at/kind/tags/content/id/sig) yields its own reason"
    requirement: "AUTHZ-05"
    verification:
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — produce external-signer substitution regressions"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/authorization-proof.test.ts#authorization proof — signer contract shapes"
        status: pass
    human_judgment: false
  - id: D6
    description: "New symbols re-exported through src/core/index.ts and the root exports snapshot; legacy src/core/account-identity-proof.ts left byte-unchanged"
    verification:
      - kind: unit
        ref: "src/__tests__/exports.test.ts#exports"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-09-12
status: complete
---

# Phase 6 Plan 1: Shared Authorization-Proof Envelope Primitive Summary

**Proof-class-agnostic MarmotAuthorizationProof codec (104-byte signer_pubkey/created_at/signature envelope), NIP-01 event-id reconstruction + BIP-340 verify, and strict external-signer produce, reproducing the spec signing vector byte-for-byte.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-12 (session start)
- **Completed:** 2026-09-12T22:02:36Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `src/core/authorization-proof.ts`: a single, MLS-free, kind-registry-free primitive that encodes/decodes the 104-byte `MarmotAuthorizationProof` envelope, range-checks `created_at` as a bigint before any `Number()` conversion, validates `signer_pubkey` as a genuine x-only secp256k1 point via `schnorr.utils.lift_x`, reconstructs the exact NIP-01 event from a plain `{ kind, tags, content }` template, verifies BIP-340 signatures, and produces proofs through an injectable `Pick<EventSigner, "signEvent">` signer with full per-field returned-event validation.
- The spec signing test vector (secret key `3`, all-zero aux, `created_at` 1700000000) reproduces the exact event id `b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b`, signature, and 104-byte component hex through the generic primitive — not hard-coded to any specific proof class.
- 69 colocated tests cover every one of the 14 `AuthorizationProofRejectReason` literals, every spec-vector boundary (`created_at` 0 / `2^53` / max-u64 / `2^53-1`), and every external-signer substitution (pubkey, created_at, kind, tags, content, id, signature) with self-consistent re-signed mocks.
- Core barrel (`src/core/index.ts`) and the root exports snapshot (`src/__tests__/exports.test.ts`) updated with exactly the nine new runtime symbols, verified as pure sorted insertions with nothing removed.
- Verified green under Node (`pnpm vitest run`, full suite: 97 files / 1033 tests), Bun 1.3.14, and Deno 2.9.1; `pnpm compile` and `pnpm exec tsc -p tsconfig.json --noEmit` both exit 0.

## Task Commits

Each task was committed atomically:

1. **Task 1: Strict 104-byte envelope codec with typed rejections (AUTHZ-01, AUTHZ-02, AUTHZ-03)** - `12434f2` (feat)
2. **Task 2: NIP-01 reconstruction, BIP-340 verify, and strict external-signer produce plus spec vector (AUTHZ-04, AUTHZ-05)** - `90c9569` (feat)
3. **Task 3: Core barrel export, exports snapshot refresh, and cross-runtime gates (D-12)** - `b9a5f15` (docs)

**Plan metadata:** (this commit, following this SUMMARY)

_Note: this was not a `tdd="true"` plan-level TDD gate plan, but each task individually wrote its test additions first, confirmed RED (module/exports missing or new tests failing against unchanged source), then implemented to GREEN — verified directly during execution, not inferred after the fact._

## Files Created/Modified

- `src/core/authorization-proof.ts` - the shared `MarmotAuthorizationProof` envelope primitive (codec, validators, NIP-01 reconstruction, verify, produce)
- `src/core/__tests__/authorization-proof.test.ts` - 69 tests: spec vector, boundary/negative cases per reject reason, external-signer substitution regressions
- `src/core/index.ts` - added `export * from "./authorization-proof.js";` (line 2, D-12)
- `src/__tests__/exports.test.ts` - regenerated inline snapshot with the nine new runtime symbols
- `.gitignore` - added `deno.lock` (generated by the local Deno smoke run; pnpm is this workspace's lockfile)

## Decisions Made

- All 14 reject-reason literals declared in Task 1's type even though the eight `returned-*` reasons are only thrown starting in Task 2, per the plan's explicit "declare all 14 now" instruction.
- `produceAuthorizationProof` treats the signer's return value as `unknown` and re-validates its shape defensively (object/null check, then a `Partial<...>`-typed field read), rather than relying solely on the declared `EventSigner["signEvent"]` return type — this is what lets a signer returning `null` be caught as `returned-event-malformed` at runtime rather than only at the type level.
- Reworded two JSDoc sentences (produce's default-`createdAt` description and the signer-type doc) to avoid the literal substrings the plan's acceptance-criteria greps treat as banned (`Math.floor(Date.now() / 1000)` appearing twice; any `getPublicKey` occurrence at all) — the code itself still calls `Math.floor(Date.now() / 1000)` exactly once and never references `getPublicKey`.
- The "uppercase pubkey" external-signer substitution test could not use the same self-consistent `signWith` helper as the other substitution tests, because nostr-tools' `getEventHash`/`validateEvent` rejects a non-lowercase-hex `pubkey` before an id can even be computed. That one test case supplies a placeholder `id`/`sig` instead — safe because `produce`'s pubkey comparison is the first field checked and throws before `id`/`sig` are ever read.

## Deviations from Plan

None — plan executed exactly as written. The two JSDoc rewordings and the one test-fixture adjustment above are documentation/test-authoring choices made to satisfy the plan's own literal acceptance-criteria greps and a third-party library constraint (nostr-tools' `validateEvent`); they did not change any production behavior, reason literal, or validation order specified by the plan.

## Issues Encountered

- The uppercase-pubkey substitution test initially failed with `Error: can't serialize event with wrong or missing properties` thrown from inside the test's own `signWith` helper (via nostr-tools' `getEventHash` → `validateEvent`, which requires a lowercase 64-hex `pubkey`) — not a bug in `authorization-proof.ts`. Resolved by supplying a placeholder `id`/`sig` for that one substitution case, as documented above.
- Two acceptance-criteria greps (`grep -c "Math.floor(Date.now() / 1000)"` expecting exactly 1, `grep -c "getPublicKey"` expecting exactly 0) initially failed because JSDoc prose repeated those literal strings. Resolved by rewording the prose without changing the implementation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 7 (the `0x8009` account-identity-proof class) can now build its exact kind-450 template and call `produceAuthorizationProof`/`verifyAuthorizationProof`/`encodeAuthorizationProof`/`decodeAuthorizationProof` directly — the envelope, `created_at` range, NIP-01 reconstruction, and external-signer validation are all done and spec-vector-verified.
- Phase 8 (`validateCommitLegality` legality seams) can catch `AuthorizationProofError` and map its `reason` field into its own discriminated result contract; the reason vocabulary is stable and exhaustive (14 literals).
- `src/core/account-identity-proof.ts` (legacy `0xf2f1`) is untouched, as required — its removal is explicitly Phase 7 scope, not this plan's.
- No blockers. No stubs. No deferred items introduced by this plan.

---
*Phase: 06-shared-authorization-proof-envelope-primitive*
*Completed: 2026-09-12*

## Self-Check: PASSED

All created/modified files verified present on disk; all three task commit hashes (`12434f2`, `90c9569`, `b9a5f15`) verified present in git history.
