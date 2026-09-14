# Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-14
**Phase:** 07-account-identity-proof-component-0x8009-legacy-clean-cut
**Areas discussed:** Proof signer in client API, Phase 7 vs 8 boundary, Legacy local state, Validator shape & errors

Start-of-phase upstream check: `refs/marmot` had no new commits. `refs/mdk` was 15 commits behind, and none touch
proof or engine validation code. It was fast-forwarded to `17496e98` in commit `86fdd2b`.

---

## Proof signer in client API

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `signer` | Delete `accountProofSigner` everywhere; sign kind-450 with the identity `signer.signEvent` | ✓ |
| Optional override | Default to `signer`, accept an optional `{ signEvent }` override | |

| Option | Description | Selected |
|--------|-------------|----------|
| Required | `generateKeyPackage` requires a signer; no proof-less path | ✓ |
| Optional, test-only | Keep a non-conformant proof-less path for fixtures | |

| Option | Description | Selected |
|--------|-------------|----------|
| Wall clock, injectable | Default `Date.now()`, injectable at core `generateKeyPackage` only | ✓ |
| Expose on client too | Also thread a clock through `MarmotClient` options | |

| Option | Description | Selected |
|--------|-------------|----------|
| Delete both | Delete the test and opentui raw-key helpers; pass the account EventSigner | ✓ |
| Keep a test helper | Replace with a `{ signEvent }` zero-aux helper | |
| You decide | Planner minimizes churn | |

**User's choice:** All recommended options.

---

## Phase 7 vs 8 boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, creation side now | New groups require `0x8009`; drop `0xf2f1` from required caps in the same change | ✓ |
| Strictly Phase 8 | Created groups temporarily require no proof profile | |

| Option | Description | Selected |
|--------|-------------|----------|
| Strict swap now | Reject any Add lacking valid `0x8009` in admin-policy | |
| Like-for-like | Swap the id and keep the proof-less skip; Phase 8 makes it strict | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Shared helper + join | Pure GroupContext profile classifier, called at join now | ✓ |
| Helper only | Build and test the helper; no call sites until Phase 8 | |
| All seams now | Wire into join, load, ingest, and convergence in Phase 7 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Validators + existing hooks | Put wrong-container rejection into existing dictionary/SafeAAD validators | ✓ |
| Pure helpers only | Predicates only; wire in Phase 8 | |
| You decide | Planner decides | |

**User's choice:** Recommended options, except admin-policy: like-for-like (not the recommended strict swap).
**Notes:** The proof-less-Add skip is recorded as a known gap Phase 8 must close.

---

## Legacy local state

| Option | Description | Selected |
|--------|-------------|----------|
| Skip as non-current | `ensurePublished` ignores legacy KeyPackages; `list()` flags them; no auto-delete | ✓ |
| Auto-purge on startup | Delete legacy local material and kind-5 published events | |
| Leave to apps | No change; document in migration notes | |

| Option | Description | Selected |
|--------|-------------|----------|
| Load untouched | No load-time check; Phase 8 seams reject | ✓ |
| Refuse at load | Profile check during load; skip or throw with an event | |

| Option | Description | Selected |
|--------|-------------|----------|
| Major changeset + migration doc | Breaking changeset plus a short docs migration section | ✓ |
| Changeset only | Defer docs to backlog 999.2 | |

**User's choice:** All recommended options.

---

## Validator shape & errors

| Option | Description | Selected |
|--------|-------------|----------|
| components/ + delete legacy | New `src/core/components/account-identity-proof.ts`; delete the legacy file | ✓ |
| Rewrite in place | Keep the `src/core/account-identity-proof.ts` path | |

| Option | Description | Selected |
|--------|-------------|----------|
| New class error, wraps envelope | `AccountIdentityProofError` with class reasons; envelope error as `cause` | ✓ |
| One flat union | Class and envelope reasons in one union | |
| Extend AuthorizationProofError | Add account reasons to the generic primitive | |

| Option | Description | Selected |
|--------|-------------|----------|
| Throwing validators | Match the Phase 6 throw model; Phase 8 maps to `{ kind }` | ✓ |
| Result unions now | Return `{ kind }` results directly | |

| Option | Description | Selected |
|--------|-------------|----------|
| One builder | Single leaf `app_data_dictionary` builder including the `0x8009` entry | ✓ |
| You decide | Planner picks | |

**User's choice:** All recommended options.

---

## Claude's Discretion

- Exported symbol names; exact reason spelling beyond the minimum set; how the legacy flag on `list()` is surfaced;
  where the migration doc section lives.

## Deferred Ideas

- Phase 8: close admin-policy's proof-less-Add skip; wire the profile classifier and validators into every seam.
- Rejecting legacy stored groups at load time.
- Automatic purge or rotation of legacy published KeyPackages (out of v2.0 scope).
- Injectable proof clock on `MarmotClient`.
