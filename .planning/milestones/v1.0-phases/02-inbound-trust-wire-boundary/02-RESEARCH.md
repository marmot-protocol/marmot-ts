# Phase 2: Inbound Trust & Wire Boundary - Research

**Researched:** 2026-07-22
**Domain:** Nostr transport-boundary trust (event verification), MLS KeyPackage Lifetime policy, Nostr tag-cardinality validation
**Confidence:** HIGH

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)

- Wiring the KeyPackage-lifetime and tag-cardinality behaviors as **automated MDK
  conformance-vector cross-checks** is **CONF-01 / Phase 4** — this phase adds unit-level
  rejection tests, not the parity harness.
- Recording byte-exact MDK cross-checks for the cap value is **QA-02 / Phase 5**.
- App-component integrity, admin/leaf coupling, SelfEvicted, notification withdrawal are
  **Phase 3** (WIRE-03, CONV-01..04) — explicitly not touched here.
- None of the discussion raised out-of-phase capabilities — scope stayed within Phase 2.
  </user_constraints>

<phase_requirements>

## Phase Requirements

| ID                    | Description                                                                                                                                                                                 | Research Support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01                | The inbound Nostr path verifies event id + Schnorr signature at the boundary BEFORE trusting `h`/`p` routing tags or attempting decryption; unverifiable events are rejected, not processed | Exact three entry points located with file:line (445 `#connectGroup` drain, 1059 `InviteManager.ingestEvent`, 30443 `KeyPackageStore.addPublished`/`KeyPackageManager.track`/`createInviteIntent`); applesauce `VerifyEventMethod`/`verifyEvent`/`fakeVerifyEvent`/cached-flag pattern confirmed present and matching CONTEXT's D-02/D-03/D-04 exactly; the 1059 "seal-only, not outer-event" verification gap in `applesauce-common`'s `unlockGiftWrap` is documented as the key thing this phase must close |
| WIRE-01               | Published KeyPackages cap MLS Lifetime at ≤ 7,261,200 s (84 days); inbound KeyPackages with an over-long or expired Lifetime are rejected                                                   | Sole produce-side call site confirmed (`createThreeMonthLifetime()` → `generateKeyPackage()`, single chain, no other lifetime-generation path); the `ts-mls` `LifetimeConfig.maximumTotalLifetime` dead-weight pitfall documented so the planner doesn't rely on it; two inbound-side plug-in points identified (`key-package-eligibility.ts` soft-reject path, `key-package-event-decode.ts`/`KeyPackageStore.addPublished` hard-reject boundary)                                                            |
| WIRE-02               | Required-tag cardinality is enforced — events with repeated, empty, or duplicate required tags are rejected (445 `h`; 1059 `p`; 444 `e`/`relays`; 30443 `d`/`i`/`mls_protocol_version`)     | Full table-driven validator design provided, cross-checked verbatim against `refs/marmot/transports/nostr.md`'s cardinality table (exact match, no divergence); every required-tag read site mapped file:line, including the finding that `mls_protocol_version` and the 30443 `d`/`i` cardinality checks have **no existing internal read site** (new wiring, not a migration)                                                                                                                               |
| </phase_requirements> |

## Summary

This phase closes three tightened wire-boundary rules from spec commit #236 (`refs/marmot/transports/nostr.md`,
`refs/marmot/foundation/key-packages.md`). All three gaps are real and were confirmed by directly reading the current
source, not inferred: **(1)** zero Nostr event id/signature verification exists anywhere in marmot-ts's inbound path
today — grep and direct reads confirm this; **(2)** the produced KeyPackage lifetime is 90 days
(`createThreeMonthLifetime()`, `src/utils/timestamp.ts:53-64`), 514,800 s over the 7,261,200 s (84-day) cap, and there
is no inbound lifetime validation anywhere (`getKeyPackage` and `evaluateKeyPackageForGroup` never read `Lifetime`);
**(3)** every required-tag read in the 445/1059/444/30443 paths goes through `getTagValue` (`src/utils/nostr.ts:10`),
a first-match helper with no cardinality/duplicate/empty checking, and two of the six required-tag reads
(`mls_protocol_version`, and 30443's `d`/`i` cardinality) have **no existing internal call site at all** — the
validator for those tags is new wiring, not a migration.

The applesauce verification surface CONTEXT assumed exists exactly as described: `VerifyEventMethod`,
`verifyEvent`, `fakeVerifyEvent`, `VerifiedEvent`, and the cached `verifiedSymbol` flag all live in
`applesauce-core/helpers` (re-exported from `nostr-tools/pure`), and `verifyWrappedEvent`/`setVerifyWrappedEventMethod`
live in the same module, consumed internally by `applesauce-common`'s gift-wrap helpers. Critically:
`unlockGiftWrap()` (used by `InviteManager.decryptGiftWrap`) verifies the **seal** (kind 13) via `verifyWrappedEvent`
internally, but **never verifies the outer kind-1059 gift-wrap event itself** — that is a gap this phase must close
explicitly in `InviteManager.ingestEvent()`, before storing/decrypting.

**Primary recommendation:** Inject a single `VerifyEventMethod` (default `verifyEvent`, overridable to
`fakeVerifyEvent` or a custom implementation) through `MarmotClientOptions` down into `GroupsManagerOptions`,
`InviteManagerOptions`, and `KeyPackageManagerOptions`; call it as the very first gate at each of the three inbound
entry points identified below (with exact file:line); add a table-driven tag-cardinality validator in `src/utils/`
that sits beside (not replaces) `getTagValue`; and fix `createThreeMonthLifetime()` + add a new inbound lifetime
check in `key-package-eligibility.ts`/`key-package-event-decode.ts`.

## Architectural Responsibility Map

| Capability                                                  | Primary Tier              | Secondary Tier                         | Rationale                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nostr event id/signature verification (SEC-01)              | Client (Nostr-specific)   | —                                      | Engine is transport-agnostic (`GroupPeeler<TEnvelope>`); Schnorr/NIP-01 verification is Nostr-only and must never enter `src/engine` or `src/core`. All three entry points live in `src/client/**`.                                                                                            |
| KeyPackage Lifetime cap enforcement (WIRE-01, produce side) | Core (protocol logic)     | —                                      | `generateKeyPackage()`/`createThreeMonthLifetime()` are pure protocol helpers with no I/O — `src/core`/`src/utils`.                                                                                                                                                                            |
| KeyPackage Lifetime rejection (WIRE-01, inbound side)       | Core (decode/eligibility) | Client (where the event first arrives) | Decoding + lifetime-range/current checks are pure functions over `NostrEvent`/`KeyPackage` bytes (`src/core/key-package-event-decode.ts`, `key-package-eligibility.ts`); the client layer is where the event is first observed and is responsible for calling the boundary before trusting it. |
| Tag-cardinality validation (WIRE-02)                        | Core/Utils (validator)    | Client (call sites)                    | The validator itself is transport-format logic with no I/O (`src/utils/`); the call sites that must migrate live in both `src/core` (decode functions) and `src/client` (managers).                                                                                                            |
| Rejected-outcome surfacing (`rejected` emit)                | Client                    | —                                      | `EventEmitter`-based managers (`GroupsManager`, `InviteManager`, `KeyPackageManager`) already own the `unreadable`/`error` emit pattern this mirrors.                                                                                                                                          |

## Standard Stack

### Core

| Library             | Version                                                            | Purpose                                                                                                                                                               | Why Standard                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applesauce-core`   | ^6.2.0 (installed; verified 6.2.0 present in `node_modules/.pnpm`) | `VerifyEventMethod`, `verifyEvent`, `fakeVerifyEvent`, `VerifiedEvent`, `verifyWrappedEvent`, `setVerifyWrappedEventMethod` — the entire SEC-01 verification contract | Already a direct dependency; CONTEXT's D-02/D-03/D-04 mandate following its convention exactly; confirmed present and matching in `node_modules/.pnpm/applesauce-core@6.2.0.../dist/helpers/event.d.ts` |
| `applesauce-common` | ^6.2.0 (installed)                                                 | `unlockGiftWrap`, `isRumor` — the 1059 gift-wrap unwrap path that internally calls `verifyWrappedEvent` on the seal                                                   | Already a direct dependency; no new package needed                                                                                                                                                      |
| `nostr-tools`       | 2.19.4 (transitive, verified via `node_modules/.pnpm`)             | Actual `verifyEvent`/`schnorr.verify` implementation applesauce re-exports                                                                                            | Transitive through `applesauce-core`; not a direct project dependency, do not import from it directly — always go through `applesauce-core/helpers`                                                     |

No new npm packages are required for this phase — every primitive needed (verification, gift-wrap unwrap, tag
reading) is already an installed dependency. **Package Legitimacy Audit is not applicable**: no new external packages
are introduced.

### Supporting

| Library              | Version                        | Purpose                                                                    | When to Use                                                                                                                      |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ts-mls` (workspace) | 2.0.0-rc.14 (local `./ts-mls`) | `Lifetime`, `LifetimeConfig`, `defaultLifetime()`, `defaultLifetimeConfig` | KeyPackage lifetime type + the (currently too-permissive, currently-unused-for-the-cap) engine-side config — see Pitfall 3 below |

### Alternatives Considered

| Instead of                                  | Could Use                                   | Tradeoff                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| applesauce's `VerifyEventMethod` convention | A bespoke async `Promise<boolean>` verifier | Rejected by CONTEXT D-02 — breaks the synchronous type-predicate contract and the cached-`verified`-flag performance path applesauce's own helpers (gift-wrap, zaps) already rely on internally |
| Injectable verifier                         | A boolean `skipVerification` opt-out flag   | Rejected by CONTEXT D-04 — `fakeVerifyEvent` is the applesauce-idiomatic way to express "trust the caller" without a second code path                                                           |

**Installation:** None — no new dependencies.

**Version verification performed:**

```
$ ls node_modules/.pnpm | grep applesauce-core
applesauce-core@6.2.0_typescript@6.0.3
$ ls node_modules/.pnpm | grep applesauce-common
applesauce-common@6.2.0_typescript@6.0.3
$ ls node_modules/.pnpm | grep nostr-tools
nostr-tools@2.19.4_typescript@6.0.3
```

`[VERIFIED: node_modules/.pnpm listing]`

## Package Legitimacy Audit

**Not applicable — no new external packages are introduced by this phase.** All verification primitives
(`VerifyEventMethod`, `verifyEvent`, `fakeVerifyEvent`, `verifyWrappedEvent`) are already exported by
`applesauce-core`/`applesauce-common`, both existing direct dependencies (`package.json` lines 116-117).

## Architecture Patterns

### System Architecture Diagram

```text
                         ┌─────────────────────────────────────────────┐
                         │              MarmotClientOptions             │
                         │   verifyEvent?: VerifyEventMethod (NEW)      │
                         └───────────────┬───────────────────────────────┘
                                          │ threaded to all three managers
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   ┌─────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐
   │   GroupsManager      │   │     InviteManager        │   │   KeyPackageManager      │
   │ #connectGroup drain   │   │     ingestEvent()         │   │     track() /             │
   │ (445 group messages)  │   │     (1059 gift wraps)     │   │     KeyPackageStore       │
   │                        │   │                            │   │     .addPublished()       │
   │ 1. verify(event)  NEW  │   │ 1. verify(event)  NEW      │   │     (30443 KeyPackages)   │
   │    reject invalid-sig  │   │    reject invalid-sig      │   │ 1. verify(event)  NEW     │
   │ 2. tag-cardinality: h  │   │ 2. tag-cardinality: p       │   │ 2. tag-cardinality:       │
   │    NEW (strict getter) │   │    (subscription-level;    │   │    d / i / mls_protocol_  │
   │ 3. group.ingest(fresh) │   │    verify on the raw event  │   │    version  NEW           │
   │    → NostrGroupPeeler  │   │    before store+decrypt)    │   │ 3. KeyPackage Lifetime    │
   │    → decryptGroup      │   │ 3. unlockGiftWrap()          │   │    cap+current check      │
   │    MessageEvent        │   │    (verifies the SEAL only, │   │    NEW (key-package-      │
   │ 4. emit('rejected',    │   │    NOT the outer 1059 —     │   │    eligibility.ts /        │
   │    groupId, event,     │   │    applesauce-common gap)   │   │    -event-decode.ts)       │
   │    reason)  NEW        │   │ 4. getWelcome() (444 e/     │   │ 4. emit('rejected', event, │
   │                        │   │    relays cardinality        │   │    reason)  NEW            │
   │                        │   │    already partial — needs  │   │                            │
   │                        │   │    strict-getter migration) │   │                            │
   │                        │   │ 5. emit('rejected', event,  │   │                            │
   │                        │   │    reason)  NEW              │   │                            │
   └─────────────────────┘   └─────────────────────────┘   └─────────────────────────┘
              │                           │                           │
              ▼                           ▼                           ▼
     src/engine/* (MLS state    src/core/welcome-event.ts    src/core/key-package-event-
     machine — NEVER touches    (444 rumor decode)            decode.ts, key-package-
     Nostr verification)                                       eligibility.ts
```

### Recommended Project Structure

```
src/
├── utils/
│   ├── nostr.ts              # getTagValue (UNTOUCHED) + NEW strict getters
│   │                          #   (getSingletonTagValue, getListTag)
│   ├── tag-cardinality.ts     # NEW: table-driven validator (D-10/D-11 table as data)
│   └── timestamp.ts           # createThreeMonthLifetime() → cap fix + backdate
├── client/
│   ├── verify.ts              # NEW (suggested): shared RejectReason type +
│   │                          #   default-verifier wiring helpers, OR inline in
│   │                          #   nostr-interface.ts — planner's discretion (CONTEXT)
│   ├── groups-manager.ts      # #connectGroup drain — verify + reject (445)
│   ├── invite-manager.ts      # ingestEvent() — verify + reject (1059)
│   └── key-package-manager.ts # track() / KeyPackageStore.addPublished() — verify + reject (30443)
└── core/
    ├── key-package-event-decode.ts  # inbound Lifetime read/validate (NEW)
    ├── key-package-eligibility.ts   # inbound Lifetime reject wired into eligibility (NEW)
    └── welcome-event.ts             # 444 e/relays → migrate to strict getters
```

### Pattern 1: Injectable synchronous verifier (applesauce convention)

**What:** A `VerifyEventMethod` type-predicate `(event: NostrEvent) => event is VerifiedEvent`, defaulting to
applesauce's `verifyEvent` (which recomputes the NIP-01 id via SHA-256 and checks the BIP-340 Schnorr signature, then
caches the boolean result on `event[verifiedSymbol]` so repeat calls on the same event object are free).
**When to use:** As the first check at every one of the three inbound entry points, before any tag is read.
**Example (verified from installed package source, not the network):**

```typescript
// Source: node_modules/.pnpm/applesauce-core@6.2.0.../dist/helpers/event.d.ts (lines 50-57)
// and node_modules/.pnpm/nostr-tools@2.19.4.../dist/lib/esm/pure.js (verifyEvent impl)
export type VerifyEventMethod = (event: NostrEvent) => event is VerifiedEvent;
export declare function setVerifyWrappedEventMethod(method: VerifyEventMethod): void;
export declare function verifyWrappedEvent(event: NostrEvent): event is VerifiedEvent;
export declare function fakeVerifyEvent(event: NostrEvent): event is VerifiedEvent;

// nostr-tools/pure.js — the real check, and the cached-flag behavior D-03 relies on:
verifyEvent(event) {
  if (typeof event[verifiedSymbol] === "boolean") return event[verifiedSymbol]; // cache
  const hash = getEventHash(event);           // NIP-01 id recompute
  if (hash !== event.id) { event[verifiedSymbol] = false; return false; }
  try {
    const valid = schnorr.verify(event.sig, hash, event.pubkey); // BIP-340
    event[verifiedSymbol] = valid;
    return valid;
  } catch { event[verifiedSymbol] = false; return false; }
}
```

`[VERIFIED: node_modules/.pnpm/applesauce-core@6.2.0_typescript@6.0.3, nostr-tools@2.19.4_typescript@6.0.3]`

### Pattern 2: Table-driven tag-cardinality validator

**What:** Encode the #236 cardinality table (`refs/marmot/transports/nostr.md` lines 68-80) as data — a map from
`(kind, tagName) → "singleton" | "list"` — with two strict getters:

- `getSingletonTagValue(event, name)`: returns the value only if exactly one tag with that name exists and it has
  exactly one value; otherwise `undefined`/throws (planner decides throw-vs-undefined convention to match
  `getTagValue`'s existing `undefined`-on-absent style, but MUST additionally reject on "present-but-invalid" where
  `getTagValue` today silently succeeds).
- `getListTag(event, name)`: returns the tag's values only if exactly one tag with that name exists, it has ≥ 1
  value, and no duplicate values; otherwise reject.

**When to use:** At every required-tag read on 445 (`h`), 1059 (`p`), 444 (`e`, `relays`), 30443 (`d`, `i`,
`mls_protocol_version` as singleton; `mls_ciphersuite`, `mls_extensions`, `mls_proposals`, `app_components` as list).

**Spec text (verbatim source of the table), confirms CONTEXT's D-11 numbers exactly:**

```text
# Source: refs/marmot/transports/nostr.md lines 63-80
**CRITICAL:** Required Marmot transport tags have exact cardinality. If a required singleton tag is missing, repeated,
has no value, or has extra values beyond the one defined here, the event is malformed. If a required list tag is
missing, repeated, empty, or contains duplicate values after validation, the event is malformed. A receiver MUST NOT
read only the first matching tag and ignore later duplicates.

| Event shape | Tag | Cardinality and value rule |
| kind 445 group message | h | exactly one tag, exactly one value |
| kind 1059 welcome gift wrap | p | exactly one tag, exactly one value |
| kind 444 welcome rumor | e | exactly one tag, exactly one value |
| kind 444 welcome rumor | relays | exactly one tag, one or more relay URL values |
| kind 30443 KeyPackage | d | exactly one tag, exactly one non-empty slot id value |
| kind 30443 KeyPackage | mls_protocol_version | exactly one tag, exactly one value: "1.0" |
| kind 30443 KeyPackage | i | exactly one tag, exactly one value |
| kind 30443 KeyPackage | mls_ciphersuite / mls_extensions / mls_proposals / app_components | exactly one id-list tag |
```

`[CITED: refs/marmot/transports/nostr.md]` — matches CONTEXT D-11 verbatim; no divergence found.

### Anti-Patterns to Avoid

- **Verifying only the 1059 seal, not the outer gift wrap:** `unlockGiftWrap()` (`applesauce-common`) calls
  `verifyWrappedEvent(seal)` internally on the kind-13 seal (`node_modules/.pnpm/applesauce-common@6.2.0.../dist/helpers/gift-wrap.js:138`),
  but the outer kind-1059 event's own id/sig is **never checked by applesauce**. Relying on `unlockGiftWrap` alone
  leaves the 1059 envelope itself unverified — the `p` tag used for the inbox subscription filter and the event's own
  authenticity are unverified metadata until the client verifies them explicitly.
- **Conflating the new transport `rejected` with the engine's MLS-level `rejected`:** `src/engine/types.ts:93-98`
  already defines `RejectedIngestResult` (`kind: "rejected"`, post-decrypt admin-policy rejection). The new
  transport-boundary rejection (SEC-01/WIRE-01/WIRE-02) is pre-decrypt/pre-decode and Nostr-specific; per D-06 it
  must be a **separate** manager-level event, never merged into `IngestResult`.
- **Mutating `defaultLifetimeConfig` from `ts-mls`:** it is an imported `const` object (`ts-mls/src/lifetimeConfig.ts:8-11`);
  marmot-ts must construct its own `LifetimeConfig` override object for `defaultMarmotClientConfig.lifetimeConfig`
  rather than trying to mutate the shared import (see Pitfall 3).

## Don't Hand-Roll

| Problem                                      | Don't Build                                                         | Use Instead                                                                                                  | Why                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NIP-01 id recompute + BIP-340 Schnorr verify | A custom `sha256(serializeEvent(...))` + `schnorr.verify(...)` pair | `verifyEvent` from `applesauce-core/helpers` (re-exports `nostr-tools/pure`)                                 | Already installed, already the cached-flag pattern the rest of the ecosystem (zaps, gift-wraps) relies on; a hand-rolled version would diverge from applesauce's own internal `verifyWrappedEvent` default and produce two verification code paths to keep in sync |
| Gift-wrap/seal unwrap + verify               | A custom NIP-59 unwrap                                              | `unlockGiftWrap` (`applesauce-common/helpers/gift-wrap`) — already in use in `InviteManager.decryptGiftWrap` | Already handles seal verification, rumor/seal pubkey-match check (throws `"Seal author does not match rumor author"`), and caching                                                                                                                                 |

**Key insight:** Every primitive this phase needs already exists in an installed dependency; the actual work is
_wiring_ (call the existing verifier at the right boundary, before the right fields are trusted) and _new validation
logic_ (the tag-cardinality table and the Lifetime cap/current check), neither of which applesauce or ts-mls provides
out of the box.

## Common Pitfalls

### Pitfall 1: `mls_protocol_version`, and 30443 `d`/`i` cardinality have no existing internal read site to "migrate"

**What goes wrong:** CONTEXT frames this as "migrate the required-tag reads" — but `getKeyPackageMLSVersion()`
(`src/core/key-package-event-decode.ts:51-56`) is exported and covered by an export-surface test
(`src/__tests__/exports.test.ts:190`) but **has zero internal call sites** in `src/**` outside its own definition and
that test. Grepping the whole `src/` tree for `getKeyPackageMLSVersion` confirms this.
**Why it happens:** The tag was added to the public decode API for downstream consumers but marmot-ts itself never
reads it before accepting a KeyPackage.
**How to avoid:** Treat `mls_protocol_version` cardinality/value ("1.0") checking as **new** validation wired into
the KeyPackage inbound boundary (`KeyPackageStore.addPublished()` or `KeyPackageManager.track()`), not a migration of
an existing call. `d` (`getKeyPackageIdentifier`, read at `src/client/key-package-store.ts:218` and
`src/client/key-package-events.ts:11`) and `i` (`getKeyPackageReference`, read at
`src/client/key-package-manager.ts:421`) **do** have existing call sites and are true migrations.
**Warning signs:** A plan task that says "migrate the mls_protocol_version read" without first adding the read.

### Pitfall 2: The 445/1059 outer event is never independently verified against a group id — only filtered by the relay

**What goes wrong:** `#connectGroup`'s drain (`src/client/groups-manager.ts:449-473`) subscribes with
`{ kinds: [445], "#h": [h] }` and trusts the relay's filter to only deliver matching events; the local code never
re-reads the `h` tag to confirm it matches before decrypting (`decryptGroupMessageEvent`,
`src/core/group-message-crypto.ts:71-117`, never touches `h` at all). A misbehaving/malicious relay could deliver an
event with a forged or missing `h` tag and the drain would still hand it to `group.ingest()`. The two existing `h`
tag reads in the codebase (`src/client/runtime/group-runtime.ts:360`, `src/engine/group-engine.ts:1221`) are
**audit-log-only** (`transport_group_id` forensic metadata) — they do not gate trust and are out of scope for the
D-11 strict-getter migration.
**Why it happens:** The subscription filter was treated as sufficient routing; the spec's cardinality rule
(`transports/nostr.md` line 91: "A kind 445 event MUST include exactly one `h` tag") was never locally re-verified.
**How to avoid:** After verifying id+sig, also read `h` via `getSingletonTagValue` and reject (or at minimum log/flag)
events whose `h` does not equal the group's own `getNostrGroupIdHex(group.state)` — this closes the loop the spec's
"MUST NOT read only the first matching tag" rule implies, and is consistent with WIRE-02's intent even though the
literal success criterion #3 only requires _rejecting malformed cardinality_, not _cross-checking the value against
the subscribed group_. Flag this as an explicit scope decision for the planner (see Open Questions).
**Warning signs:** A plan that treats the relay subscription filter as equivalent to verifying the tag.

### Pitfall 3: `ts-mls`'s own `LifetimeConfig.maximumTotalLifetime` field is unused dead weight — the cap must live in marmot-ts

**What goes wrong:** `defaultMarmotClientConfig.lifetimeConfig = defaultLifetimeConfig` (`src/core/client-state.ts:59`,
importing `ts-mls`'s `defaultLifetimeConfig` at `ts-mls/src/lifetimeConfig.ts:8-11`: `maximumTotalLifetime: 10368000n`
/* 120 days */, `validateLifetimeOnReceive: false`). Reading `ts-mls/src/clientState.ts:626-649`
(`validateLeafNodeKeyPackage`) shows the engine's own Add-processing lifetime check **only** verifies "current time
within `[notBefore, notAfter]`" (no grace) when `sentByClient || config.validateLifetimeOnReceive` — and
`validateLifetimeOnReceive` defaults to `false`, so this check is currently OFF for inbound Adds. The
`maximumTotalLifetime` field is **read nowhere** in `ts-mls`'s validation code — it is effectively dead/unconsulted
in this version (2.0.0-rc.14). A plan that assumes bumping `defaultLifetimeConfig.maximumTotalLifetime` to 7,261,200n
enforces the cap will silently do nothing.
**Why it happens:** The `LifetimeConfig` type looks like it should enforce the cap; it does not in the current
ts-mls version.
**How to avoid:** Implement the ≤7,261,200 s cap check and the ~1h-grace current-check entirely in marmot-ts
(`src/core/key-package-event-decode.ts` / `key-package-eligibility.ts`, per D-08), independent of `LifetimeConfig`.
Optionally (Claude's Discretion / Open Question below) also flip `validateLifetimeOnReceive: true` in a marmot-ts-
owned `LifetimeConfig` override for defense-in-depth at the engine layer — but note that check has **no grace window**
at all, so turning it on could reject a KeyPackage the marmot-ts boundary check would have accepted (asymmetric
strictness). Do not mutate the imported `defaultLifetimeConfig` object itself — construct a new local object.
**Warning signs:** A plan task titled "set `maximumTotalLifetime` to enforce the cap" with no code that reads
`notAfter - notBefore` itself.

### Pitfall 4: Existing tests already produce properly-signed events — turning on verification is low-risk but must still be run

**What goes wrong:** A natural fear is that enabling real signature verification will break every existing test that
uses `MockNetwork` (`src/__tests__/helpers/mock-network.ts`) with synthetic events.
**Why it doesn't happen here:** Every event that flows through `MockNetwork` in the existing test suite is produced
by real signing code: `createGroupEvent` (445) calls `finalizeEvent()` with a freshly generated ephemeral secret key
(`src/core/group-event.ts:44-47` — real Schnorr, real NIP-01 id); the 1059 gift wrap is built via
`GiftWrapFactory.create(signer, ...)` with a `PrivateKeyAccount` signer (`applesauce-accounts`); 30443 events are
signed via `KeyPackagePublisher.publish()` → `signer.signEvent()`. `MockNetwork` itself performs no event
fabrication — it only stores/filters/replays events it's given.
**How to avoid:** Still run the full test suite (`pnpm vitest run`) after wiring in the default verifier — this is a
low-risk-but-verify item, not a guaranteed-safe one, since 444 welcome **rumors** are intentionally unsigned
(`isRumor` checks `!("sig" in event)`) and must never be passed through `VerifyEventMethod` (only the 1059 wrapper and
the seal are signed events; the rumor itself is correctly exempt).
**Warning signs:** A plan task that calls the verifier on a `Rumor` object instead of the signed 1059/seal events.

## Code Examples

### 445 inbound entry point — exact current shape to modify

```typescript
// Source: src/client/groups-manager.ts:428-473 (verified by direct read)
async #connectGroup(
  group: MarmotGroup<THistory, TMedia>,
  options?: ConnectOptions,
): Promise<Unsubscribable> {
  // ... relay/h resolution (unchanged) ...
  const filter = { kinds: [GROUP_EVENT_KIND], "#h": [h] };
  const seen = new Set<string>();
  const drain = async (events: NostrEvent[]): Promise<void> => {
    const fresh = events.filter((event) => !seen.has(event.id));
    for (const event of fresh) seen.add(event.id);
    if (!fresh.length) return;
    try {
      for await (const result of group.ingest(fresh)) {
        if (result.kind === "unreadable")
          this.emit("unreadable", group.id, result.event);
      }
    } catch (err) {
      log("connect: ingest failed for group %s: %o", group.idStr, err);
    }
  };
  // Backfill then live-subscribe (unchanged structure) — the NEW verify step
  // slots in at the top of `drain`, before `fresh` is handed to `group.ingest`.
  await drain(await this.network.request(relays, filter));
  const sub = this.network.subscription(relays, filter)
    .subscribe({ next: (event) => void drain([event]) });
  return { unsubscribe: () => sub.unsubscribe() };
}
```

### 1059 inbound entry point — exact current shape to modify

```typescript
// Source: src/client/invite-manager.ts:181-203 (verified by direct read)
// NOTE: zero verification of `event` happens here today — this is the
// insertion point, BEFORE the event is stored or handed to decryptGiftWrap().
async ingestEvent(event: NostrEvent): Promise<boolean> {
  if (!isGiftWrap(event)) {
    throw new Error(`Expected kind 1059 gift wrap, got kind ${event.kind}`);
  }
  const seen = await this.getSeenSet();
  if (seen.has(event.id)) return false;
  // ... store as "received", update seen index, emit "received" ...
}
```

### 30443 inbound "single chokepoint" — already documented as such in-source

```typescript
// Source: src/client/key-package-store.ts:191-213 (verified by direct read)
// This is ALREADY the single chokepoint for both tracked (untrusted) and
// self-published events, per its own doc comment — the natural site for the
// d/i/mls_protocol_version cardinality + Lifetime cap checks.
async addPublished(ref: string | Uint8Array, event: NostrEvent): Promise<void> {
  const key = this.#resolveKey(ref);
  // MIP-00: the `i` tag IS the KeyPackageRef of the event body. Receivers MUST
  // verify it against the decoded KeyPackage and reject on mismatch ...
  const publicPackage = getKeyPackage(event);
  const computedRefBytes = await calculateKeyPackageRef(publicPackage, this.#cryptoProvider);
  const computedRef = bytesToHex(computedRefBytes);
  if (computedRef !== key.toLowerCase()) {
    throw new Error(`KeyPackage event ${event.id} carries i tag ${key} but its body's KeyPackageRef is ${computedRef}`);
  }
  // ... identifier = getKeyPackageIdentifier(event); persist ...
}
```

Callers: `KeyPackageManager.track(event)` (`src/client/key-package-manager.ts:416-434`, the passive/inbound-discovery
path — app calls this after independently fetching a 30443 event) and `KeyPackageManager.create()`/`rotate()` (the
self-publish path, already-trusted). **A third consumption path bypasses `addPublished` entirely:**
`createInviteIntent()` (`src/client/group/invite.ts:34-67`, called from `GroupsManager.invite()`) takes a raw
`keyPackageEvent: NostrEvent` directly and only checks `kind` + credential-identity-matches-pubkey — it does **not**
verify id/sig, does not check Lifetime, and does not go through `KeyPackageStore`. This is a second boundary the
planner must cover, not just `track()`/`addPublished()`.

### Produce-side lifetime — the single call site to fix

```typescript
// Source: src/utils/timestamp.ts:53-64 (verified by direct read)
export function createThreeMonthLifetime(): Lifetime {
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  const threeMonthsInSeconds = 90n * 24n * 60n * 60n; // 7,776,000s — 514,800s OVER the 7,261,200s cap
  const notAfter = currentTime + threeMonthsInSeconds;
  return { notBefore: currentTime, notAfter }; // no backdate — D-07 wants notBefore = now - 3600
}
// Sole call site: src/core/key-package.ts:105 `generateKeyPackage()` — confirmed via
// grep across all of src/**; the full chain is
// KeyPackageManager.create() -> KeyPackagePublisher.generate() -> generateKeyPackage()
// -> createThreeMonthLifetime() (src/client/key-package-publisher.ts:107-113).
```

### `evaluateKeyPackageForGroup` — where the WIRE-01 inbound check plugs into eligibility

```typescript
// Source: src/core/key-package-eligibility.ts:81-161 (verified by direct read)
// Currently: cipher-suite match, required_capabilities, agent-text-stream roles,
// already-member check. Lifetime is NEVER read. `reasons.push(...)` is the
// established pattern for a new "Lifetime" failure to slot into (though
// `evaluateKeyPackageForGroup` never THROWS on invalid input — it returns
// `eligible: false` with a reasons array — so a REJECT here is softer than the
// hard-reject required at the `addPublished`/`track()`/discovery boundary;
// the planner must decide whether both sites need the Lifetime check or just
// the boundary. CONTEXT's canonical refs list both files.
```

## State of the Art

| Old Approach                                       | Current Approach                                                                       | When Changed                                                                | Impact                                                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No wire-boundary verification (pre-#236 spec text) | Verify-before-trust + tag cardinality + Lifetime cap, all MUST-level (#236, `7f2f5fa`) | Spec commit `7f2f5fa` (post `cc73aa8`/`c47436a` darkmatter import boundary) | Any marmot-ts client today produces KeyPackages a conformant peer will reject (90 days > 84-day cap) and accepts inbound input a conformant peer never would — this phase is interop-breaking to skip |

**Deprecated/outdated:**

- `createThreeMonthLifetime()`'s current 90-day value: no longer spec-conformant post-#236; keep the function name if
  CONTEXT's discretion note (deprecated-alias rename) is followed, but the _value_ must change regardless of naming
  decision.

## Assumptions Log

| #   | Claim                                                                                                                                                                                            | Section                                     | Risk if Wrong                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Whether `h` (445) and `p` (1059) should be _cross-checked against the expected group/pubkey value_, not just cardinality-validated, is in scope for WIRE-02                                      | Pitfall 2                                   | If out of scope, a plan that adds this check is doing extra work beyond the phase's literal success criteria; if in scope and skipped, a malicious relay can still forge routing metadata post-verification                         |
| A2  | `evaluateKeyPackageForGroup` (soft `reasons` array) should ALSO gain the Lifetime check, in addition to the hard-reject boundary at `KeyPackageStore.addPublished()`/`KeyPackageManager.track()` | Code Examples, "evaluateKeyPackageForGroup" | If only one site gets the check, an app calling the other path directly could bypass WIRE-01                                                                                                                                        |
| A3  | Flipping `validateLifetimeOnReceive: true` in a marmot-ts-owned `LifetimeConfig` override (engine-layer defense-in-depth) is desirable                                                           | Pitfall 3                                   | If done without care, the no-grace engine check could reject KeyPackages the marmot-ts boundary check (with ~1h grace) would accept — asymmetric behavior; if not done, there is one fewer layer of defense at the MLS-engine level |

## Open Questions

1. **Should the `h`/`p` tag values be cross-checked against the expected group id / local pubkey, not just validated for cardinality?**
   - What we know: The spec's tag-cardinality table (#236) only mandates cardinality/value-shape rules; the spec's
     "Malformed transport input" bullets (`transports/nostr.md` lines 299-310) say a 445 event "MUST satisfy the `h`
     tag rule above" (i.e., cardinality), not "MUST match the subscribed group."
   - What's unclear: Whether WIRE-02's success criterion #3 ("reject repeated/empty/duplicate") is meant to also
     imply a value-match reject, or whether value-matching is a Phase-3-adjacent convergence concern (out of scope
     here per CONTEXT's explicit out-of-scope list).
   - Recommendation: Scope WIRE-02 strictly to cardinality (matches the literal success criteria and CONTEXT's D-11
     table, which lists no value-matching rule); leave `h`/`p` value cross-checking as a note for the planner to
     accept-or-defer explicitly, not silently add.

2. **Should `KeyPackagePublisher.publish()` / the produce side also validate its own output before signing (defense-in-depth), or is fixing `createThreeMonthLifetime()` sufficient?**
   - What we know: There is exactly one produce-side call site (`src/core/key-package.ts:105`); fixing it fixes every
     produced KeyPackage.
   - What's unclear: Whether a caller could pass an explicit `lifetime` override to `generateKeyPackage({ lifetime })`
     (the option exists — `src/core/key-package.ts:65`) that exceeds the cap, bypassing the default.
   - Recommendation: Low priority — `generateKeyPackage`'s `lifetime` param is not exercised by any current internal
     caller (`KeyPackagePublisher.generate()` never passes it), so this is a latent library-API concern, not an
     active bug; flag for the planner to decide whether the WIRE-01 fix should also guard the explicit-override path.

3. **Where should the shared `RejectReason` type and the injected `VerifyEventMethod` option live?**
   - What we know: CONTEXT leaves this to Claude's Discretion; `MarmotClientOptions` (`src/client/marmot-client.ts:85-156`)
     is the natural top-level injection point since it already composes `GroupsManagerOptions`,
     `InviteManagerOptions`, `KeyPackageManagerOptions`.
   - What's unclear: Whether a new `src/client/verify.ts` module (holding `RejectReason`, default-verifier re-export)
     is warranted, or whether this belongs in `src/client/nostr-interface.ts` alongside the other shared client-layer
     types (`PublishResponse`, `Unsubscribable`, etc.).
   - Recommendation: New `src/client/verify.ts` — keeps `nostr-interface.ts` (transport-shape types) separate from
     trust-boundary types, and gives the `RejectReason` taxonomy (D-05: `'invalid-signature' | 'lifetime-cap' |
'tag-cardinality'`) a single importable home for all three managers' event signatures.

## Environment Availability

Not applicable — this phase modifies existing TypeScript source and has no new external tool/service dependencies.
`pnpm`, `node`, `deno`, `bun`, and `tsc` are already CI-verified per `CLAUDE.md`.

## Validation Architecture

Skipped — `workflow.nyquist_validation` is explicitly `false` in `.planning/config.json`.

## Security Domain

### Applicable ASVS Categories

| ASVS Category           | Applies              | Standard Control                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 Authentication       | No                   | Not a user-authentication phase — this is transport-message authenticity, not account login                                                                                                                                                                                                                                      |
| V4 Access Control       | No                   | Group-admin authorization is a separate concern (`src/engine/admin-policy.ts`), not touched here                                                                                                                                                                                                                                 |
| V5 Input Validation     | Yes                  | Table-driven tag-cardinality validator (`src/utils/tag-cardinality.ts`, new) rejects malformed/duplicate/empty required tags before any field is trusted — same spirit as schema validation (zod/joi), but hand-written against the #236 cardinality table since it operates on Nostr's `string[][]` tag arrays, not JSON schema |
| V6 Cryptography         | Partial              | Signature verification itself is delegated to `applesauce-core`'s `verifyEvent` (→ `@noble/curves/secp256k1` `schnorr.verify`) — never hand-roll BIP-340 verification; this phase only wires the call, it does not implement cryptography                                                                                        |
| V13 API and Web Service | Yes (domain-adapted) | Nostr event authenticity (NIP-01 id + BIP-340 signature) is the closest analog to "message authenticity" in a non-HTTP protocol; the Marmot spec (`transports/nostr.md` "Event identity and tag cardinality") is the authoritative control document since ASVS has no Nostr/MLS-specific category                                |

### Known Threat Patterns for this stack

| Pattern                                                                                                                                                                          | STRIDE                                            | Standard Mitigation                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forged/unsigned event accepted as trusted transport metadata (relay or MITM injects a fabricated 445/1059/30443 event)                                                           | Spoofing                                          | SEC-01: verify NIP-01 id + BIP-340 Schnorr signature via `verifyEvent` before trusting any field                                                                                                                                                                               |
| Duplicate/repeated required tag used to smuggle a second value past a first-match reader (e.g. two `h` tags, one matching the subscription filter and one the attacker controls) | Tampering                                         | WIRE-02: `getSingletonTagValue`/`getListTag` reject on any cardinality violation instead of silently taking the first match                                                                                                                                                    |
| Over-long-lived KeyPackage extends an attacker's window to use a compromised/leaked private key material indefinitely                                                            | Elevation of Privilege (extended exposure window) | WIRE-01: reject KeyPackages whose `Lifetime` range exceeds 7,261,200 s or is not current (with ~1h grace)                                                                                                                                                                      |
| Malformed/empty tag values causing downstream `parseInt`/decode exceptions to propagate as unhandled errors rather than typed rejections (availability/DoS-adjacent)             | Denial of Service                                 | The validator returns a typed reject rather than throwing from deep inside decode helpers; existing patterns (`evaluateKeyPackageForGroup`'s try/catch → `reasons.push("undecodable: ...")`) already establish "never throw on malformed input, always return a typed outcome" |

## Sources

### Primary (HIGH confidence — direct source reads this session)

- `src/client/groups-manager.ts` (445 `#connectGroup` drain, lines 428-473)
- `src/client/group/nostr-peeler.ts`, `src/core/group-message-crypto.ts`, `src/core/group-event.ts` (445 peel/decrypt/create)
- `src/client/invite-manager.ts` (1059 ingest/decrypt, lines 100-443)
- `src/client/transport/nostr/welcome-delivery.ts` (1059 outbound delivery)
- `src/client/key-package-manager.ts`, `src/client/key-package-store.ts`, `src/client/key-package-publisher.ts` (30443 discovery/track/publish)
- `src/client/group/invite.ts` (`createInviteIntent` — second 30443 consumption path)
- `src/core/key-package-event-decode.ts`, `src/core/key-package-eligibility.ts`, `src/core/key-package.ts` (KeyPackage decode/eligibility/generate)
- `src/core/welcome-event.ts`, `src/core/welcome.ts` (444 rumor decode)
- `src/utils/nostr.ts`, `src/utils/timestamp.ts` (`getTagValue`, `createThreeMonthLifetime`, `isLifetimeValid`)
- `src/engine/types.ts`, `src/core/inbound.ts` (existing `IngestResult`/`InputCategory` vocabulary, for contrast with the new transport `rejected`)
- `src/client/marmot-client.ts` (`MarmotClientOptions`, manager composition)
- `src/__tests__/integration/group-connect.test.ts`, `src/__tests__/helpers/mock-network.ts` (test infra confirming events are already properly signed)
- `node_modules/.pnpm/applesauce-core@6.2.0_typescript@6.0.3/node_modules/applesauce-core/dist/helpers/event.js` + `.d.ts` (`VerifyEventMethod`, `verifyEvent`, `fakeVerifyEvent`, `verifyWrappedEvent`, cached-flag behavior)
- `node_modules/.pnpm/applesauce-common@6.2.0_typescript@6.0.3/node_modules/applesauce-common/dist/helpers/gift-wrap.js` + `.d.ts` (`unlockGiftWrap`, seal-only verification gap)
- `node_modules/.pnpm/nostr-tools@2.19.4_typescript@6.0.3/node_modules/nostr-tools/lib/esm/pure.js` (`verifyEvent` real implementation)
- `ts-mls/src/lifetime.ts`, `ts-mls/src/lifetimeConfig.ts`, `ts-mls/src/clientState.ts` (lines 626-713 — `validateLeafNodeKeyPackage`, confirms `maximumTotalLifetime` is unused)
- `refs/marmot/transports/nostr.md` (lines 55-154, 280-320 — event identity/cardinality table, validation-before-peeling bullets)
- `refs/marmot/foundation/key-packages.md` (lines 72-97 — Lifetime cap text, verbatim match to CONTEXT)
- `refs/mdk/crates/cgka-engine/src/key_package.rs` (lines 160-220 — Rust-side lifetime-policy validation shape, cross-check)
- `.planning/research/SPEC-DELTAS.md` (findings 1-3, prior catchup-review analysis — consistent with this session's direct reads)

### Secondary (MEDIUM confidence)

- None used — all findings this session were either direct source reads (HIGH) or spec-text citations (HIGH-tier CITED).

### Tertiary (LOW confidence)

- None — no web search was needed; `.planning/config.json` has `exa_search`/`brave_search`/`firecrawl` all `false`,
  and every fact needed was available and verified directly in the local repo (project source, `node_modules`,
  `refs/marmot`, `refs/mdk`, local `ts-mls` workspace).

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — no new packages; existing dependency versions confirmed via `node_modules/.pnpm` listing
- Architecture: HIGH — every entry point and call site cited with file:line from direct reads this session
- Pitfalls: HIGH — each pitfall traced to specific source lines, including the two "no existing call site" findings that correct CONTEXT's "migrate" framing

**Research date:** 2026-07-22
**Valid until:** Stable for the life of this phase (single-session, pre-implementation research); re-verify file:line
references if Phase 2 planning/execution spans a rebase of `src/client/*` or a `ts-mls` version bump.
