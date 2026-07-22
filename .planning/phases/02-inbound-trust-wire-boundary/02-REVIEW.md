---
phase: 02-inbound-trust-wire-boundary
reviewed: 2026-07-22T13:08:33Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - src/client/invite-manager.ts
  - src/client/groups-manager.ts
  - src/core/welcome-event.ts
  - src/client/__tests__/invite-manager.test.ts
  - src/__tests__/groups-manager.test.ts
  - src/core/__tests__/welcome.test.ts
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
status: issues_found
---

# Phase 02: Code Review Report (gap-closure re-review, plan 02-04)

**Reviewed:** 2026-07-22T13:08:33Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

> This report supersedes the initial phase review. It scopes only the plan 02-04
> gap-closure diff (base `8146e2f`), which closed the three previously-confirmed
> defects: the 1059 `p`-tag cardinality gate (was IN-01), the 445 dedup-after-verify
> reordering (was WR-01), and the duplicate-relay rejection in `createWelcomeRumor`
> (was WR-02).

## Summary

Verdict on the three targeted defects — all three are correctly closed:

1. **1059 `p`-tag cardinality gate (was IN-01)** — Correct. In
   `InviteManager.ingestEvent` the new gate (invite-manager.ts:224-227) runs
   _after_ the outer-signature verification (216-219) and _before_ the
   `seen`/store writes (229-242) — the required verify → cardinality → dedup →
   store order. The `length === 2` strictness inherited from
   `getSingletonTagValue` is spec-correct: `refs/marmot/transports/nostr.md`
   defines the 1059 `p` tag as "exactly one tag, exactly one value" and declares
   an event with "extra values beyond the one defined here" malformed, so
   rejecting a `p` tag that carries a relay hint is intended (not an interop
   regression). No finding.

2. **445 dedup-after-verify reordering (was WR-01)** — The core fix is correct.
   `seen.add(event.id)` now runs only after _both_ the signature and `h`-tag
   gates pass (groups-manager.ts:518), so a corrupted same-id forgery can no
   longer poison the dedup slot and censor the genuine same-id event that arrives
   later. A genuine event never enters `rejectedEvents` (it passes both gates),
   so the new filter cannot false-censor it, and the WR-01 test asserts the
   genuine event still ingests. Within-batch behavior is unchanged from before.
   However, the _auxiliary_ `rejectedEvents` Set added alongside `seen`
   introduces two new problems (WR-01, WR-02 below).

3. **Duplicate-relay rejection in `createWelcomeRumor` (was WR-02)** — Correct.
   The new `new Set(groupRelays).size !== groupRelays.length` check
   (welcome-event.ts:61-64) mirrors exactly the duplicate-rejection rule in the
   consuming `getListTag` (tag-cardinality.ts:94), achieving producer/consumer
   parity; the round-trip parity test covers it. No finding.

All remaining findings concern the newly-introduced `rejectedEvents` Set in
`GroupsManager.#connectGroup` — a mechanism added beyond what the fix required.

## Warnings

### WR-01: `rejectedEvents` object-identity dedup relies on an unguaranteed network-layer invariant and is effectively untested

**File:** `src/client/groups-manager.ts:495-499, 509, 515`
**Issue:** `rejectedEvents` is a `Set<NostrEvent>` and the `fresh` filter tests
`!rejectedEvents.has(event)` — i.e. **object identity**. Its stated purpose (per
the code comment at 491-494) is to suppress a duplicate `rejected` emission when
the _same_ malformed event is redelivered by backfill (`network.request`) and
then by the live subscription (`network.subscription`).

That suppression only works if the injected `NostrNetworkInterface` hands back
the _same object instance_ for a given event across `request`, subscription
replay, and subsequent live redeliveries. The interface contract does **not**
guarantee this. A production relay pool generally deserializes each relay `EVENT`
message into a fresh object, so `rejectedEvents.has(freshInstance)` is `false`,
the malformed event is re-evaluated, and `rejected` fires again — the exact case
the Set was added to prevent. The mechanism thus carries a cost (see WR-02)
without reliably delivering its benefit outside the test harness.

It appears to work only because `MockNetwork` (mock-network.ts:71-106) shares a
single `events` array, so `request` and the subscription replay return identical
instances. And **no test exercises the suppression path**: the WR-01 test
(groups-manager.test.ts) redelivers the _genuine_ event (deduped via `seen`, not
`rejectedEvents`) and never redelivers the rejected forgery, so the
`rejectedEvents.has(...)` branch is never asserted.

**Fix:** Prefer dropping `rejectedEvents` entirely — a duplicate `rejected`
emission on redelivery is informational, not a protocol-safety issue (the
parallel `InviteManager` 1059 path re-emits and is fine). If suppression is
genuinely wanted, key it on `event.id` in a structure that never feeds the
trusted `seen` slot, and add a test that redelivers a _distinct-instance_
forgery carrying the same bytes:

```ts
const rejectedIds = new Set<string>();
// ...
if (!safeVerifyEvent(this.#verifyEvent, event)) {
  if (!rejectedIds.has(event.id)) {
    rejectedIds.add(event.id);
    this.emit("rejected", group.id, event, "invalid-signature");
  }
  continue;
}
```

(but note WR-02 — any such set is still unbounded and attacker-fed).

### WR-02: `rejectedEvents` is an unbounded Set of full event objects fed by untrusted input

**File:** `src/client/groups-manager.ts:495`
**Issue:** `rejectedEvents` retains a reference to every rejected event _object_
for the entire lifetime of the connection (released only when the subscription
closure is GC'd on unsubscribe). Its growth is driven entirely by **untrusted**
input: a malicious or compromised relay serving the group's `#h` subscription
can stream an unbounded number of distinct invalid kind-445 events (bad
signature or malformed `h` tag), each retained forever. This is a
memory-exhaustion / availability (DoS-adjacent) vector on the inbound trust
boundary — precisely the surface this phase is hardening.

This is materially worse than the pre-existing `seen` set, which holds only
string ids of _trusted_ (validly-signed, group-authored) events, bounded by
legitimate traffic. `rejectedEvents` holds whole objects and is bounded only by
how many invalid events an adversary chooses to send.

**Fix:** If any suppression is kept, store ids (not objects) and bound the
structure — an LRU/ring buffer or a size ceiling past which suppression is
skipped:

```ts
const REJECTED_CAP = 1024;
const rejectedIds = new Set<string>();
// ...
if (rejectedIds.size < REJECTED_CAP) rejectedIds.add(event.id);
```

Preferably remove the mechanism (WR-01) so no attacker-controlled unbounded
structure exists on the inbound path at all.

## Info

### IN-01: Rejection-suppression behavior now differs between the two sibling inbound trust boundaries

**File:** `src/client/groups-manager.ts:495` vs `src/client/invite-manager.ts:216-227`
**Issue:** The 445 drain in `GroupsManager` suppresses repeat `rejected`
emissions via `rejectedEvents`, but the parallel 1059 boundary in
`InviteManager.ingestEvent` has no equivalent — a malformed gift wrap redelivered
through `listen()` re-emits `rejected` on every delivery (it is never added to
`seen`). Two boundaries hardened in the same milestone now behave differently for
the same scenario. Given WR-01/WR-02, the consistent and safer resolution is to
remove the `GroupsManager` suppression rather than replicate it into
`InviteManager`.
**Fix:** Align the two paths — prefer having both emit `rejected` per delivery,
and document `rejected` as an at-least-once signal.

---

_Reviewed: 2026-07-22T13:08:33Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
