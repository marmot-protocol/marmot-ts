# Spec Conformance Deltas — marmot-ts vs `refs/marmot`

Audit scope: **single-device wire interop + protocol conformance**. Multi-device (MIP-06),
push (MIP-05), QUIC/agent-stream data-plane, and app/tooling concerns are out of scope
(catalogued as Deferred). Proof v1/v2 is owned by a separate audit and only referenced here.

## Post-split spec commits reviewed

Darkmatter import boundary: `cc73aa8` / `c47436a`. Genuinely-new spec work after that:

| SHA       | PR   | Substance                                                                                                                                                   |
| --------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3f2520e` | #170 | Mark spec "adopted", drop draft/v2 framing (prose only; no wire change)                                                                                     |
| `0b9e74c` | #171 | Admin/leaf coupling as resulting-epoch invariant; candidate-edge = full commit validity; state-notification withdrawal; `SelfEvicted` / "Realizing removal" |
| `7f2f5fa` | #236 | Tighten wire-boundary validation: NIP-01 verify-before-trust, tag cardinality table, KeyPackage `Lifetime` cap (7,261,200 s)                                |

Older imported rules still binding and worth spot-checking: #551 (`e10a7c4`, MLS proposal
ordering & departure), #457 (`2f7ba6f`, NIP-40 expiration on app messages), #438 (`a7e374c`,
kind-30443 MLSMessage framing — CONFORMS, see below).

---

## Findings (interop-breaking first)

### 1. KeyPackage `Lifetime` exceeds 84-day cap — INTEROP-BREAKING

- **Spec:** `foundation/key-packages.md` (#236): a KeyPackage MUST carry a `Lifetime`, be
  current, and have `not_after - not_before <= 7,261,200 s` (84 days + 1 h). `last_resort`
  does not relax it.
- **marmot-ts:** `src/utils/timestamp.ts:53-64` `createThreeMonthLifetime()` uses
  `90 * 24 * 60 * 60 = 7,776,000 s` (90 days). This is the default lifetime for every
  published KeyPackage (`src/core/key-package.ts:105`, `client-state.ts:59` uses
  `defaultLifetimeConfig`). **7,776,000 > 7,261,200** → every marmot-ts KeyPackage is
  rejectable by a conformant peer, so invites fail.
- **Verdict:** DIVERGES · **interop-breaking**
- **Change:** Cap created lifetime at ≤ 7,261,200 s (e.g. 84 days). Also there is **no
  inbound validation**: `getKeyPackage` (`key-package-event-decode.ts:28-48`) and
  `evaluateKeyPackageForGroup` (`key-package-eligibility.ts:81`) never check `Lifetime`
  present / current / range — add rejection per the new bullet in key-packages.md.

### 2. No NIP-01 id/signature verification before trusting event fields — INTEROP-BREAKING (security)

- **Spec:** `transports/nostr.md` (#236, **CRITICAL**): a receiver MUST verify a signed
  event's id and signature before treating `id/pubkey/created_at/kind/tags/content` as
  authenticated transport metadata (routing, replay, KeyPackage evidence).
- **marmot-ts:** No signature/id verification anywhere in the inbound path — grep for
  `verifyEvent`/`hasValidSignature`/`schnorr` finds only account-identity-proof
  (`account-identity-proof.ts`), not event verification. Inbound events flow
  `groups-manager.ts:428-473` → `MarmotGroup.ingest` → `NostrGroupPeeler`
  (`nostr-peeler.ts`) → `decryptGroupMessageEvent` and `h`/`p` tags are read as trusted
  without verification.
- **Verdict:** MISSING · **interop-breaking / security**
- **Change:** Verify id + Schnorr sig at the transport boundary before using any field
  (or, if delegated to the caller/relay, make that contract explicit and enforce it in
  the peeler/classifier). `applesauce` provides `verifyEvent`.

### 3. Required-tag cardinality not enforced — INTEROP-BREAKING (accepts malformed)

- **Spec:** `transports/nostr.md` (#236) new "Event identity and tag cardinality" table:
  singleton tags (445 `h`; 1059 `p`; 444 `e`; 30443 `d`,`i`,`mls_protocol_version`) MUST
  appear exactly once with exactly one value; list tags (444 `relays`; 30443
  `mls_ciphersuite`/`mls_extensions`/`mls_proposals`/`app_components`) MUST be exactly one
  tag, non-empty, with no duplicate values. A receiver MUST NOT read only the first match.
- **marmot-ts:** `getTagValue` (`src/utils/nostr.ts:14`) returns the _first_ match — no
  reject on repeat/extra-value/empty. Used for `h`, `i`, `mls_protocol_version`, `d`, `e`.
  KeyPackage id-list reads (`key-package-event-decode.ts:76-96`) take the first matching
  tag, never reject a second same-name tag, and don't reject intra-tag duplicate values.
  `getWelcome` (`welcome-event.ts:127-156`) validates `e`/`relays` _presence_ but not
  "exactly one `e`" / no duplicate relays. (Producer side is fine: encode emits
  `0x%04x` lowercase and dedups — `key-package-event-encode.ts:83-103`.)
- **Verdict:** DIVERGES · **interop-breaking**
- **Change:** Add a cardinality validator matching the #236 table; reject
  missing/repeated/empty/duplicate for each required tag on 445/1059/444/30443 before use.
  Note the outer-event classifier bullets in nostr.md ("Malformed transport input") now
  reference these rules; `decryptGroupMessageEvent`'s `< 28 bytes` check
  (`group-message-crypto.ts:79`) already covers the 445 content-length rule.

### 4. Admin/leaf coupling not validated as a resulting-epoch invariant — DIVERGES

- **Spec:** `app-components/admin-policy-v1.md` + `convergence.md` (#171): on **every**
  commit that changes the member leaf set (even one carrying no admin-policy bytes), the
  resulting epoch's admin set (carried forward when unchanged) MUST have a member leaf for
  every listed admin key. Candidate-edge validation is _full commit validity_ including
  this cross-component check, so no branch may carry a violating commit.
- **marmot-ts:** `src/core/components/admin-policy.ts` is codec-only. No resulting-epoch
  check that every admin key has a member leaf; grep finds no coupling/orphan-admin logic.
  `admin-policy.ts` engine callback (`src/engine/admin-policy.ts`) gates _who may commit_,
  not the resulting-epoch admin⊆leaves invariant. No explicit full-commit-validity gate at
  candidate-edge construction in the engine.
- **Verdict:** MISSING · **additive** (interop-relevant: a peer's convergence could diverge
  if marmot-ts accepts a commit that removes an admin's last leaf without re-couple)
- **Change:** After applying any membership-changing commit, validate resulting-epoch
  admin set ⊆ member-leaf accounts (carried-forward admin set); treat failure as invalid
  commit / no candidate edge.

### 5. `SelfEvicted` / "Realizing removal" flow — MISSING

- **Spec:** `member-departure.md` "Realizing removal" + `inbound-processing.md` +
  `errors.md` + `group-state.md` (#171): both departure paths end with the removed member
  realizing its own removal (state-derived, idempotent), emitting a self-removed state
  notification, marking the group a removed-inactive copy (no outbound), and classifying
  later input as `SelfEvicted` (`stale` / `stale_epoch`).
- **marmot-ts:** Zero matches for `SelfEvicted`/realiz/self-removed/removed-inactive.
  Not implemented.
- **Verdict:** MISSING · **additive** (single-device relevant)
- **Change:** On a commit removing the local leaf, emit self-removed notification + mark
  group removed-inactive and block outbound; on later input for such a group, return a
  `SelfEvicted` stale disposition and realize removal if not already done.

### 6. State-notification withdrawal on branch supersession — MISSING

- **Spec:** `convergence.md` + `inbound-processing.md` (#171): state notifications are
  attributed to a commit's `commit_digest`; when branch selection supersedes a previously
  applied commit (incl. the client's own), the client MUST emit a group-state-change
  invalidation naming it and withdraw its notifications — symmetric with app-payload
  invalidation.
- **marmot-ts:** App-_payload_ invalidation exists (`src/engine/delivered-payloads.ts`
  `invalidatedByRewind`), but there is no state-notification withdrawal / group-state-change
  invalidation path. No `commit_digest`-attributed notification bookkeeping.
- **Verdict:** MISSING · **additive**
- **Change:** Attribute emitted state notifications to their commit digest; on rewind/branch
  switch, emit a group-state-change invalidation and withdraw notifications of superseded
  commits.

### 7. "Adopted" framing / stale MIP + v2 references — ADDITIVE (cosmetic)

- **Spec:** #170 drops draft/v2 labels; the repo is now the adopted protocol text.
- **marmot-ts:** Source comments still cite "MIP-03", "MIP-00", "Marmot v2 spec" (e.g.
  `admin-policy.ts:19`, `key-package-event-decode.ts:143-148`, `group-message-crypto.ts`
  header, `key-package-eligibility.ts:23`). No wire impact.
- **Verdict:** DIVERGES (docs) · **additive** — update doc references opportunistically; not
  required for interop.

---

## Spot-checks that CONFORM (no action)

- **kind-30443 content = MLSMessage framed as `mls_key_package`** (#438): enforced on both
  encode (`key-package-event-encode.ts:73-79`) and decode
  (`key-package-event-decode.ts:40-45`). CONFORMS.
- **Welcome content = MLSMessage `mls_welcome`**: `welcome-event.ts:149-154`. CONFORMS.
- **Welcome rumor requires `e` + non-empty `relays`** (create side): `welcome-event.ts:47-54`.
  CONFORMS (but read-side cardinality gap — finding 3).
- **Commit convergence ordering by source epoch then low `commit_digest`**
  (`group-message-classify.ts:30-48`, `convergence.ts`). CONFORMS.
- **kind-445 content ≥ 28 bytes** (`group-message-crypto.ts:79`). CONFORMS.
- **id-list producer format `0x%04x` lowercase, deduped** (`key-package-event-encode.ts`).
  CONFORMS.

---

## Deferred (catalogued, out of scope)

- **Multi-device (MIP-06)** — `features/multi-device.md` (still draft even in adopted spec).
- **Push notifications (MIP-05)** — `features/push-notifications.md`, spec #456/#305/#725
  (owner-authenticated push token gossip). Kind 10050 inbox fallback also push-adjacent.
- **QUIC data-plane / agent-text-stream** — `app-components/agent-text-stream-quic-v1.md`,
  `transports/quic.md`, spec #344/#303/#323 (stream policy caps, crypto inputs, role
  capability ids).
- **Encrypted media / Blossom images** — `app-components/group-encrypted-media-v1.md`,
  `group-blossom-image-v1.md`, `group-avatar-url-v1.md` (backlog item 999.1).
- **App-message NIP-40 expiration metadata** (#457) — app/tooling-adjacent; verify separately
  if app-message send path is in interop scope.

---

## Top changes marmot-ts most likely must make

1. **Cap KeyPackage lifetime ≤ 7,261,200 s** and reject over-long/expired inbound ones
   (`src/utils/timestamp.ts`, key-package decode/eligibility). _Interop-breaking._
2. **Verify Nostr id + signature** at the transport boundary before trusting any field. _Security/interop._
3. **Enforce required-tag cardinality** per the #236 table on 445/1059/444/30443. _Interop-breaking._
4. **Validate admin/leaf coupling** as a resulting-epoch invariant on every membership-changing commit. _Convergence divergence risk._
5. **Implement `SelfEvicted` / Realizing removal** and **state-notification withdrawal** on supersession. _New required behaviors (#171)._
