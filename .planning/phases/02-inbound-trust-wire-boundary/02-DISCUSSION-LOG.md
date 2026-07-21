# Phase 2: Inbound Trust & Wire Boundary - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-21
**Phase:** 02-inbound-trust-wire-boundary
**Areas discussed:** Verification placement, Rejection surfacing, Lifetime cap approach, Cardinality validator shape

---

## Verification placement (SEC-01)

| Option                     | Description                                                          | Selected |
| -------------------------- | -------------------------------------------------------------------- | -------- |
| Central gate, always-on    | Shared `verifyInboundEvent()` at the 3 entry points; no opt-out      |          |
| Central gate, opt-out flag | Same gate, default-on, with a `trustTransport`/`assumeVerified` flag |          |
| Inside peeler/engine       | Push verification into `NostrGroupPeeler`/engine boundary            |          |

**User's choice:** Freeform — "It should be possible to pass in a custom method for signature verification so more performant methods can be provided" → followed by "we should follow applesauce for event verification".
**Notes:** Resolved to a central boundary gate whose verifier is **pluggable**, following applesauce's convention exactly: the injectable type is applesauce's `VerifyEventMethod` (`(event) => event is VerifiedEvent`, synchronous type-predicate), default = applesauce `verifyEvent`, `fakeVerifyEvent` as the trust-upstream delegation path (replaces the need for an opt-out flag), and the cached `verified` flag provides the performance path. "Inside peeler/engine" was rejected implicitly because the engine is transport-agnostic and the 1059/30443 paths never reach it.

---

## Rejection surfacing

| Option                       | Description                                                                          | Selected |
| ---------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Silent drop + debug log      | Log via `marmot:*` and drop; no API surface                                          |          |
| Typed result + manager event | Discriminated `rejected` outcome with `reason` + manager emit mirroring `unreadable` | ✓        |
| Reason only, no emit         | Typed `rejected` result but no new manager event                                     |          |

**User's choice:** Typed result + manager event.
**Notes:** Reason taxonomy: `invalid-signature` \| `lifetime-cap` \| `tag-cardinality`. Flagged (not asked) that this transport-boundary `rejected` is distinct from the engine's existing MLS-level `rejected` IngestResult and is surfaced at the client/manager layer.

---

## Lifetime cap approach (WIRE-01) — produce side

| Option                       | Description                                                       | Selected |
| ---------------------------- | ----------------------------------------------------------------- | -------- |
| 84 days flat, small backdate | Duration 7,257,600 s (~1h under cap), `not_before = now - 3600`   | ✓        |
| Exact cap, no backdate       | Duration exactly 7,261,200 s, `not_before = now`                  |          |
| Match MDK exactly            | Mirror the Rust builder's duration + grace, confirmed in research |          |

**User's choice:** 84 days flat, small backdate.

## Lifetime cap approach (WIRE-01) — inbound side

| Option                      | Description                                                                       | Selected |
| --------------------------- | --------------------------------------------------------------------------------- | -------- |
| Strict cap, lenient current | Reject if missing or `dur > 7,261,200`; ±1h grace on current-check                | ✓        |
| Strict everything           | Reject if missing, over-long, or `now` strictly outside `[not_before, not_after]` |          |
| Match MDK's check           | Mirror the Rust reference's current-check tolerance, confirmed in research        |          |

**User's choice:** Strict cap, lenient current (±1h symmetric grace).
**Notes:** Helper `createThreeMonthLifetime()` becomes a misnomer at 84 days — left to Claude's discretion (lean: rename + deprecated alias re-export).

---

## Cardinality validator shape (WIRE-02)

| Option                            | Description                                                                                        | Selected |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| Shared validator + strict getters | Table-driven `#236` validator + `getSingletonTagValue`/`getListTag`; leave `getTagValue` untouched | ✓        |
| Harden getTagValue in place       | Add cardinality options to `getTagValue` (broad call-site audit risk)                              |          |
| Per-decoder inline checks         | Cardinality checks duplicated inside each decoder                                                  |          |

**User's choice:** Shared validator + strict getters.
**Notes:** Migrate only the required-tag reads (445/1059/444/30443) to the strict getters; `getTagValue` stays as-is for unrelated call sites.

---

## Claude's Discretion

- Exact injection point / option name for the pluggable `VerifyEventMethod`.
- Renaming `createThreeMonthLifetime()` (lean: accurate name + deprecated alias).
- Names/shapes of strict getters and the validator module location.
- Exact manager `rejected` emit event name/payload (consistent with `unreadable`).
- Whether to confirm MDK's own lifetime/grace numbers as a research cross-check.

## Deferred Ideas

- CONF-01 / Phase 4 — automated MDK conformance-vector cross-checks for lifetime + cardinality.
- QA-02 / Phase 5 — recording byte-exact MDK cross-checks for the cap value.
- Phase 3 — WIRE-03, CONV-01..04 (app-component integrity, admin/leaf coupling, SelfEvicted, notification withdrawal).
