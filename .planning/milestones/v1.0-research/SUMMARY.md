# Catchup Review — Synthesis (refs/marmot + refs/mdk vs marmot-ts)

**Date:** 2026-07-21
**Sources:** [PROOF-V2.md](./PROOF-V2.md), [SPEC-DELTAS.md](./SPEC-DELTAS.md), [MDK-INTEROP.md](./MDK-INTEROP.md)
**Baseline:** marmot-ts last audited ~mdk `v0.2.0`; upstream now `refs/mdk` `marmotkit-v0.9.4`, `refs/marmot` post-split (`…64-g7f2f5fa`).
**Scope:** single-device wire interop + library-scope parity. Multi-device (MIP-06), push (MIP-05/#725), QUIC data-plane/agent-stream, encrypted-media/Blossom, and app/tooling crates are **cataloged & deferred**.

## Headline

The Rust reference moved far ahead and tightened several wire boundaries. There are **5 interop-breaking gaps** (a conformant MDK peer will reject marmot-ts output, or the two will silently fork), **4 additive convergence/feature gaps**, and **2 parity items needing a targeted verify**. Proof v2 is the known breaker and is confirmed.

## Interop-breaking (close first — a conformant peer rejects us or we fork)

| #      | Gap                                                                                                                                                                                                                                                                                              | marmot-ts target                                                                         | Source                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **B1** | **Proof v2** — account-identity-proof v1→v2: version byte `2`, and the 64-byte Schnorr sig now signs a **canonical Nostr kind-450 event id**, not the old SHA-256 domain preimage. Ext `0xf2f1`; layout otherwise unchanged.                                                                     | `src/core/account-identity-proof.ts` (+ `key-package-manager.ts:127`, proof tests)       | mdk `cf780a1` #755 (Rust-ahead-of-spec)                                    |
| **B2** | **KeyPackage lifetime 84-day cap** — `createThreeMonthLifetime()` emits 90 days (7,776,000 s) > cap 7,261,200 s → every published KeyPackage is rejectable. No inbound Lifetime validation either.                                                                                               | `src/utils/timestamp.ts:53`, `key-package-event-decode.ts`, `key-package-eligibility.ts` | `foundation/key-packages.md` #236                                          |
| **B3** | **NIP-01 verify-before-trust** — inbound path performs no event id/Schnorr verification before trusting `h`/`p` tags and decrypting. (MDK #727 hardens the same boundary.)                                                                                                                       | inbound: `groups-manager.ts:428`, `nostr-peeler.ts`, `group-message-crypto.ts`           | `transports/nostr.md` #236 (CRITICAL) + mdk #727                           |
| **B4** | **Required-tag cardinality** — no rejection of repeated/empty/duplicate required tags (445 `h`; 1059 `p`; 444 `e`/`relays`; 30443 `d`/`i`/`mls_protocol_version`). `getTagValue` takes first match silently.                                                                                     | `src/utils/nostr.ts:14`, `key-package-event-decode.ts:76`, `welcome-event.ts:127`        | `transports/nostr.md` #236                                                 |
| **B5** | **App-component integrity on staged commits** — must reject pre-merge any commit that drops `app_data_dictionary`, drops a required component, or rewrites required-component bytes outside a validated `AppDataUpdate`. marmot-ts accepts commits MDK rejects → silent fork / admin-less group. | `src/engine/ingest.ts` (+ send + convergence)                                            | mdk `validate_app_component_integrity_for_staged_commit`, cgka-engine #704 |

## Additive — convergence & feature parity (byte/behaviour divergence, not immediately join-breaking)

| #      | Gap                                                                                                                                                                                                                                          | marmot-ts target                                                    | Source                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| **A1** | **Admin/leaf coupling invariant** — validate admin ⊆ member-leaves as a _resulting-epoch_ invariant on every membership-changing commit (send + validate). Send/validate may disagree with MDK on legality of removal-without-policy-update. | `src/core/components/admin-policy.ts`, `src/engine/admin-policy.ts` | `admin-policy-v1.md`+`convergence.md` #171; mdk #701 |
| **A2** | **SelfEvicted / Realizing removal** — emit self-removed notification, mark group removed-inactive, classify later input as SelfEvicted/stale.                                                                                                | new (zero matches in src)                                           | `member-departure.md` #171                           |
| **A3** | **State-notification withdrawal on supersession** — attribute group-state-change notifications to `commit_digest`; withdraw on rewind. (App-payload invalidation exists; group-state withdrawal does not.)                                   | `src/engine/…` convergence, cf. `delivered-payloads.ts`             | `convergence.md` #171; mdk removed-marker clear #724 |
| **A4** | **SafeAAD component (0x0002) + leaf dict advertisement** — add `SAFE_AAD_COMPONENT_ID=0x0002`, advertise `0x0001` in leaf `app_components`, emit empty safe_aad entry. Diverges KeyPackage/LeafNode bytes from reference.                    | `src/core/components/ids.ts`, `dictionary.ts:129`                   | mdk `b9ae3ce`                                        |

## Parity — targeted verify (may already hold; confirm with vectors)

| #      | Item                                                                                                                                                                               | marmot-ts target                                     | Source             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ |
| **P1** | **Own-confirmed-commit convergence protection** — never roll back a device's own published+confirmed commit for a same-epoch sibling. Divergent winner selection forks cross-impl. | `src/engine/fork-recovery.ts`, `tree-convergence.ts` | mdk #706/#723/#702 |
| **P2** | **removed-marker clear on supersession (#724)** — overlaps A3; verify marmot-ts clears removal markers when a commit is superseded.                                                | `src/engine/admin-policy.ts`                         | mdk #724           |

**Confirmed parity (no action):** malformed group messages → terminal-stale, not ingest abort (already `unreadable`/invalidEncoding in `src/engine/ingest.ts`); kind-30443/444 MLSMessage framing (#438); commit ordering by epoch + low digest; kind-445 ≥28-byte check.

## Test vectors available (MDK)

- **Directly consumable now:** `refs/mdk/…/vectors/byte-fixtures/nostr-routing-v1-*.json` → `src/core/components/nostr-routing.ts` (incl. a duplicate-relay reject case → supports **B4**).
- **Convergence-parity harness** (supports A1/P1/P2): `convergence-*`, `admin-policy-update`, `*-fork-recovery` scenario vectors.
- **Proof v2:** no shared fixture exists; needs a Rust-signed → TS-verified round-trip (fit for a `darkmatter-invite-compat`-style test).

## Open questions to resolve during execution

1. **Proof v2 signature scheme values** — confirm marmot-ts `mlsSignatureScheme()` equals Rust `ciphersuite.signature_algorithm() as u16` per ciphersuite (they become decimal tag strings; must match byte-for-byte).
2. **External-signer parity** — decide whether to reshape `AccountIdentityProofSigner` to "sign a Nostr event" (true NIP-07/46 external-signer parity, the reason v2 exists) vs. the minimal digest-only change.
3. **Spec-vs-Rust authority** — proof v2 and several tightenings are Rust-ahead-of-spec; per project constraint, treat the Rust reference as authoritative for wire format.

## Suggested closure order (drives the roadmap)

1. **Review already done** (this document).
2. **Interop-breakers**: B1 Proof v2 → B2 lifetime → B3 verify-before-trust → B4 tag cardinality → B5 app-component integrity.
3. **Convergence & parity**: A1 admin/leaf coupling, A2 SelfEvicted, A3 notification withdrawal, P1/P2 verify; A4 SafeAAD.
4. **Quality gate**: wire up MDK vectors + green suite on Node 20/22/24, Deno 2, Bun latest/1.1.
