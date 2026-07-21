# Phase 2: Inbound Trust & Wire Boundary - Context

**Gathered:** 2026-07-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Tighten the inbound Nostr path and KeyPackage/tag wire boundary to the post-split
`#236` rules so a conformant peer no longer silently accepts malformed input or
forges trust in unverified fields. Closes three requirements:

- **SEC-01** — verify a Nostr event's NIP-01 id + BIP-340 Schnorr signature at the
  transport boundary **before** trusting any `h`/`p` routing tag or attempting
  decryption; unverifiable events are rejected, not processed.
- **WIRE-01** — cap published KeyPackage MLS `Lifetime` at ≤ 7,261,200 s (84 days +
  1 h); reject inbound KeyPackages whose Lifetime is over-long, missing, or not current.
- **WIRE-02** — enforce required-tag cardinality: reject events with repeated, empty,
  or duplicate required tags (445 `h`; 1059 `p`; 444 `e`/`relays`; 30443 `d`/`i`/
  `mls_protocol_version`) instead of silently taking the first match.

**In scope:** the three inbound entry points (445 group messages, 1059 gift-wrapped
welcomes, 30443 KeyPackage discovery); the produce-side KeyPackage lifetime helper;
inbound KeyPackage lifetime validation; a shared tag-cardinality validator.

**Out of scope (own phases):** app-component integrity on staged commits (WIRE-03),
admin/leaf coupling and SelfEvicted/notification-withdrawal (CONV-01..04) — Phase 3.
Wiring MDK conformance vectors as automated cross-impl tests (CONF-01) and SafeAAD
advertisement (WIRE-04) — Phase 4. No multi-device / push work.

**Wire format is authoritative from the MDK Rust reference, not the lagging spec
prose** (carried forward from Phase 1). Cap values, the cardinality table, and
rejection semantics track MDK where it is ahead.
</domain>

<decisions>
## Implementation Decisions

### Event verification (SEC-01)

- **D-01 (LOCKED):** Verification runs at a **central boundary** applied at all three
  inbound entry points (445 drain in `groups-manager.ts #connectGroup`, the 1059
  welcome/inbox path, and 30443 KeyPackage discovery) **before any `h`/`p`/tag is
  read**. Verification is Nostr-specific and MUST live in the Nostr/client layer — the
  engine is transport-agnostic (`GroupPeeler<TEnvelope>`) and never does Schnorr; the
  1059/30443 paths never reach the engine at all.
- **D-02 (LOCKED):** **Follow applesauce's verification convention exactly.** The
  verifier is applesauce's **`VerifyEventMethod`** type —
  `(event: NostrEvent) => event is VerifiedEvent` (import from
  `applesauce-core/helpers`). It is **synchronous** and a **type-predicate**; do NOT
  widen it to `Promise<boolean>`. The method owns both id-recompute and signature check
  (as applesauce's default does) — we do not split id vs sig.
- **D-03 (LOCKED):** The verifier is **injectable/pluggable** (this was the user's
  driving requirement — allow a more performant native/WASM implementation). Default =
  applesauce's built-in `verifyEvent`. Performance for repeated/known events is handled
  the applesauce way via the cached **`verified`** flag on events (no bespoke batching).
- **D-04 (LOCKED):** "Trust the relay/caller" delegation is expressed by injecting
  applesauce's **`fakeVerifyEvent`** (sets `verified` without checking) — NOT a separate
  boolean opt-out flag. Verification is always structurally applied; a trusting caller
  swaps the method.

### Rejection surfacing

- **D-05 (LOCKED):** A rejected inbound event surfaces as a **typed `rejected` outcome
  carrying a `reason`** — taxonomy: `'invalid-signature'` (id or sig verification
  failed), `'lifetime-cap'` (KeyPackage lifetime over-long/missing/not-current),
  `'tag-cardinality'` (repeated/empty/duplicate required tag) — **plus a manager-level
  `rejected` event** mirroring the existing `unreadable` emit.
- **D-06 (LOCKED, planning note):** This transport-boundary `rejected` is **distinct
  from** the engine's existing MLS-level `kind: "rejected"` IngestResult (post-decrypt
  commit rejection in `src/engine/types.ts:94` / `ingest.ts`). Because verification is
  pre-decrypt and Nostr-specific, surface transport rejection at the **client/manager
  layer**. For 445, the per-group `#h` subscription supplies group context even without
  trusting the event's `h`, so `emit('rejected', group.id, event, reason)` works; for
  1059/30443 there is no group, so emit at client scope. Planner reconciles exact shape;
  the reason taxonomy above is the contract.

### KeyPackage lifetime (WIRE-01)

- **D-07 (LOCKED, produce side):** Produced lifetime duration = **84 days
  (7,257,600 s)** — deliberately ~1 h under the 7,261,200 cap for headroom — with
  `not_before` **backdated ~1 h** (`now - 3600`) so a peer's minor clock skew does not
  reject a just-published KeyPackage as not-yet-valid.
- **D-08 (LOCKED, inbound side):** **Strict cap, lenient current.** Reject
  (`reason: 'lifetime-cap'`) if Lifetime is missing OR `not_after - not_before >
7,261,200`. Apply a **symmetric ~1 h grace** on the current-check: reject only if
  `now < not_before - 3600` (not yet valid) or `now > not_after + 3600` (expired).
- **D-09 (produce path):** Apply the cap wherever KeyPackages are produced —
  `createThreeMonthLifetime()` (`src/utils/timestamp.ts:53`), `defaultLifetimeConfig`,
  and its use in `src/core/key-package.ts` / `client-state.ts`.

### Tag cardinality (WIRE-02)

- **D-10 (LOCKED):** **Shared, table-driven validator** encoding the `#236`
  singleton-vs-list table as data, plus **new strict getters** (e.g.
  `getSingletonTagValue` rejecting repeat/empty; `getListTag` rejecting empty/duplicate
  values). **Leave existing `getTagValue` (`src/utils/nostr.ts:10`) untouched** so
  unrelated call sites keep their current behavior; migrate **only the required-tag
  reads** on 445/1059/444/30443 to the strict getters.
- **D-11 (table contents):** Singleton (exactly one tag, exactly one value): 445 `h`;
  1059 `p`; 444 `e`; 30443 `d`/`i`/`mls_protocol_version`. List (exactly one tag,
  non-empty, no duplicate values): 444 `relays`; 30443 `mls_ciphersuite`/
  `mls_extensions`/`mls_proposals`/`app_components`. (Producer side already conforms —
  see SPEC-DELTAS finding 3; this phase is the read/reject side.)

### Claude's Discretion

- Exact injection point and option name for the pluggable `VerifyEventMethod` (leaning
  `MarmotClient` constructor option threaded to the three entry points).
- **Helper naming:** `createThreeMonthLifetime()` becomes a misnomer at 84 days. Lean =
  rename to an accurate name (e.g. `createDefaultKeyPackageLifetime` / `createMaxLifetime`)
  **and keep a deprecated alias re-export** so downstream does not break. Only hard-rename
  if the user later says so.
- Exact names/shapes of the strict getters and the validator module location.
- Precise wiring of the manager `rejected` emit (event name, payload) consistent with the
  existing `unreadable` emit shape.
- Whether to confirm the MDK Rust reference's own lifetime/grace numbers during research
  as a cross-check (produce/inbound values above stand regardless).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase research (authoritative for this phase)

- `.planning/research/SPEC-DELTAS.md` — findings **1** (KeyPackage Lifetime cap /
  WIRE-01), **2** (verify-before-trust / SEC-01), **3** (required-tag cardinality /
  WIRE-02): exact rules, per-file/line divergence list, and conforming spot-checks.
- `.planning/research/SUMMARY.md` — catchup review overview and severity ordering.
- `.planning/research/MDK-INTEROP.md` — MDK crate map / interop reference.

### Spec (source rules, post-split `#236`)

- `refs/marmot/transports/nostr.md` — verify-before-trust (§ event verification) and the
  "Event identity and tag cardinality" table (#236); "Malformed transport input"
  classifier bullets.
- `refs/marmot/foundation/key-packages.md` — KeyPackage MUST carry a current `Lifetime`
  with `not_after - not_before <= 7,261,200 s`; `last_resort` does not relax it (#236).

### MDK Rust reference (authoritative for wire format where ahead)

- `refs/mdk/crates/transport-nostr-adapter/` + `transport-nostr-peeler/` — inbound
  verification + tag handling parity (mdk #727).
- `refs/mdk/crates/` KeyPackage builder / validation — confirm produced lifetime + grace
  and inbound current-check tolerance for cross-check.

### marmot-ts source to change

- `src/client/groups-manager.ts` (`#connectGroup` drain ~L448-473) — 445 inbound entry
  point; add boundary verify + `rejected` emit.
- `src/client/group/nostr-peeler.ts` — 445 peel path (verify happens before/at this
  boundary).
- 1059 welcome/inbox path + 30443 KeyPackage discovery path — the other two entry points
  (planner to locate: welcome delivery + `key-package` discovery in `groups-manager` /
  invite/key-package managers).
- `src/utils/nostr.ts` — `getTagValue` (leave as-is); add strict getters + validator.
- `src/utils/timestamp.ts` — `createThreeMonthLifetime()` (cap + backdate), `isLifetimeValid`-style current-check.
- `src/core/key-package-event-decode.ts`, `src/core/key-package-eligibility.ts` — inbound
  KeyPackage lifetime validation + cardinality on 30443 id-list reads.
- `src/core/welcome-event.ts` — 444 `e`/`relays` cardinality on the read side.
- `src/engine/types.ts` / `src/engine/ingest.ts` — existing IngestResult union (do NOT
  conflate transport `rejected` with the engine's MLS `rejected`).

### applesauce (verification convention to follow)

- `applesauce-core/helpers` — `VerifyEventMethod`, default `verifyEvent`, `fakeVerifyEvent`,
  `VerifiedEvent`, `verifyWrappedEvent` (and the cached `verified` flag pattern).

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- **applesauce `VerifyEventMethod` + `verifyEvent` + `fakeVerifyEvent`**: the entire
  SEC-01 verifier contract is already an applesauce primitive — inject the type, default
  to the built-in, use `fakeVerifyEvent` for trust-upstream. Cached `verified` flag gives
  the performance path for free.
- **Discriminated-union IngestResult** (`src/engine/types.ts` — `rejected`/`skipped`/
  `unreadable`) and the manager's existing **`unreadable` emit** (`groups-manager.ts`
  `#connectGroup` drain): the `rejected` outcome + emit mirrors this proven shape.
- **`getTagValue`** (`src/utils/nostr.ts:10`): the first-match helper the strict getters
  sit beside (not replace).
- **`createThreeMonthLifetime` / `defaultLifetimeConfig`** (`src/utils/timestamp.ts`): the
  single produce-side lifetime source to cap.

### Established Patterns

- Engine is transport-agnostic (`GroupPeeler<TEnvelope>`); Nostr-specific concerns
  (Schnorr, NIP-01 id) belong in `src/client`/`src/utils`, never `src/engine`.
- Named exports, `.js` import extensions, `Uint8Array` binary, SCREAMING_SNAKE_CASE
  protocol constants — match surrounding code.
- Reject-via-typed-result (not throw) for inbound multi-outcome flows.

### Integration Points

- 445: `groups-manager.ts #connectGroup` drain → `group.ingest` → `NostrGroupPeeler`.
- 1059: welcome/gift-wrap inbox delivery path.
- 30443: KeyPackage discovery / eligibility path.
- All three consume `NostrEvent`s from `network.request` / `network.subscription`.

</code_context>

<specifics>
## Specific Ideas

- Success criteria to satisfy (ROADMAP Phase 2):
  1. An inbound event with an invalid Nostr id or Schnorr signature is rejected before
     any `h`/`p` routing tag is trusted or any decryption is attempted.
  2. Published KeyPackages cap MLS Lifetime at ≤ 7,261,200 s (84 days); an inbound
     KeyPackage with an over-long or expired Lifetime is rejected.
  3. An event with a repeated, empty, or duplicate required tag (445 `h`; 1059 `p`; 444
     `e`/`relays`; 30443 `d`/`i`/`mls_protocol_version`) is rejected, not first-match-resolved.
- The user's guiding constraints, verbatim intent: verification must be **pluggable for
  performance**, and we **follow applesauce for event verification** (hence the
  `VerifyEventMethod` type-predicate + `fakeVerifyEvent` delegation, not a home-grown
  async boolean or opt-out flag).

</specifics>

<deferred>
## Deferred Ideas

- Wiring the KeyPackage-lifetime and tag-cardinality behaviors as **automated MDK
  conformance-vector cross-checks** is **CONF-01 / Phase 4** — this phase adds unit-level
  rejection tests, not the parity harness.
- Recording byte-exact MDK cross-checks for the cap value is **QA-02 / Phase 5**.
- App-component integrity, admin/leaf coupling, SelfEvicted, notification withdrawal are
  **Phase 3** (WIRE-03, CONV-01..04) — explicitly not touched here.
- None of the discussion raised out-of-phase capabilities — scope stayed within Phase 2.

</deferred>

---

_Phase: 02-inbound-trust-wire-boundary_
_Context gathered: 2026-07-21_
