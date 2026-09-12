# Phase 6: Shared Authorization-Proof Envelope Primitive - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-12
**Phase:** 06-shared-authorization-proof-envelope-primitive
**Areas discussed:** Proof-class plug-in shape, Rejection/error model, created_at in the public API, Signer contract & rollout

---

## Proof-class plug-in shape

| Option | Description | Selected |
|--------|-------------|----------|
| Plain template | Primitive takes `{ kind, tags, content }` + envelope; per-class builder function | ✓ |
| ProofClass descriptor | Typed `ProofClass<TContext>` interface the primitive calls | |
| You decide | Claude picks | |

**User's choice:** Plain template

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal checks | Integer kind, `string[][]` tags, string content | ✓ |
| Kind registry | Reject unregistered proof-class kinds | |
| No checks | Template is trusted | |

**User's choice:** Minimal checks

| Option | Description | Selected |
|--------|-------------|----------|
| Single file | `src/core/authorization-proof.ts` | ✓ |
| Folder | `src/core/authorization-proofs/{envelope,produce,verify,index}.ts` | |

**User's choice:** Single file

---

## Rejection/error model

| Option | Description | Selected |
|--------|-------------|----------|
| Typed throw | `AuthorizationProofError` with `reason` literal union | ✓ |
| Discriminated result | `{ kind: 'valid' } \| { kind: 'invalid', reason }` | |
| Both | Result-returning core + throwing assert wrapper | |

**User's choice:** Typed throw

| Option | Description | Selected |
|--------|-------------|----------|
| One per spec step | Distinct reason per validation step and per substituted signer field | ✓ |
| Coarse | malformed / out-of-range / bad-signature | |

**User's choice:** One per spec step

---

## created_at in the public API

| Option | Description | Selected |
|--------|-------------|----------|
| number | bigint range check on decode, then exact Number | ✓ |
| bigint | bigint end-to-end | |

**User's choice:** number

| Option | Description | Selected |
|--------|-------------|----------|
| Optional injected clock | Optional `createdAt`/clock, default `Date.now()/1000` | ✓ |
| Caller always supplies | Required input | |
| Primitive reads clock | No override; fake timers in tests | |

**User's choice:** Optional injected clock

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, reject | `Number.isSafeInteger` + range | ✓ |
| Floor it | Silently truncate | |

**User's choice:** Yes, reject

---

## Signer contract & rollout

| Option | Description | Selected |
|--------|-------------|----------|
| Generic union | `(eventId) => sig` \| `{ signEvent }` | |
| EventSigner only | Only `{ signEvent }`; raw keys wrapped | ✓ |
| Keep legacy union as-is | Reuse request-typed `AccountIdentityProofSigner` | |

**User's choice:** EventSigner only
**Notes:** Reverses v1.0 Phase 01's digest-function path decision.

| Option | Description | Selected |
|--------|-------------|----------|
| Full NostrEvent | Compare every field per AUTHZ-05 | ✓ |
| Partial + recompute | `{ id, pubkey, sig }` + id recompute | |

**User's choice:** Full NostrEvent

| Option | Description | Selected |
|--------|-------------|----------|
| Export via core barrel now | Barrel + exports snapshot updated in Phase 6 | ✓ |
| Internal until Phase 7 | Export once 0x8009 class uses it | |

**User's choice:** Export via core barrel now

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, inline template | Byte-exact spec vector through generic primitive in Phase 6 | ✓ |
| Synthetic only | Vector waits for Phase 7 | |

**User's choice:** Yes, inline template

Follow-up on EventSigner-only:

| Option | Description | Selected |
|--------|-------------|----------|
| Pick-type signEvent | `Pick<EventSigner, "signEvent">`; tests hand-roll zero-aux signer | ✓ |
| Full EventSigner + core helper | Ship `privateKeyProofSigner(secretKey)` in core | |
| Full EventSigner, no helper | Raw-key callers use applesauce-signers `PrivateKeySigner` | |

**User's choice:** Pick-type signEvent

| Option | Description | Selected |
|--------|-------------|----------|
| No | Caller supplies expected pubkey; returned-event check catches mismatch | ✓ |
| Yes, pre-flight | Call `getPublicKey()` before signing | |

**User's choice:** No

---

## Claude's Discretion

- Exported symbol names, reason string spelling, verify input shape (decoded proof vs bytes)
- x-only validity mechanism (explicit `lift_x` vs inside verify), provided a distinct decode-time reason exists

## Deferred Ideas

- Phase 7: migrate legacy digest-function signer call sites to `{ signEvent }` with the `0xf2f1` clean cut
- Kind-registry enforcement — revisit with multi-device/push proof classes
