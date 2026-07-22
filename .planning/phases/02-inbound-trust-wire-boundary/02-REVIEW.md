---
phase: 02-inbound-trust-wire-boundary
reviewed: 2026-07-22T00:00:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - src/client/verify.ts
  - src/client/marmot-client.ts
  - src/client/groups-manager.ts
  - src/client/invite-manager.ts
  - src/client/key-package-manager.ts
  - src/client/group/invite.ts
  - src/core/welcome-event.ts
  - src/core/key-package.ts
  - src/core/key-package-eligibility.ts
  - src/core/key-package-event-decode.ts
  - src/utils/tag-cardinality.ts
  - src/utils/timestamp.ts
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-07-22T00:00:00Z
**Depth:** standard
**Files Reviewed:** 11 source files (+ colocated tests inspected for expected behavior)
**Status:** issues_found

## Summary

Reviewed the inbound-trust / wire-boundary implementation: `safeVerifyEvent`
(SEC-01), the #236 tag-cardinality readers (`getSingletonTagValue`/`getListTag`),
the capped/backdated KeyPackage lifetime helpers (WIRE-01), and the four inbound
gates (445 in `GroupsManager.#connectGroup`, 1059 in `InviteManager.ingestEvent`,
30443 in `KeyPackageManager.track` and `createInviteIntent`, 444 in
`getWelcome`).

The core boundary logic is sound: every gate verifies the outer Nostr signature
_before_ any decode/persist/ingest work, all four gates order signature →
cardinality → lifetime correctly, `safeVerifyEvent` correctly swallows
verifier throws (the documented applesauce/nostr-tools gap), and the strict
cardinality readers reject repeated/empty/extra-value tags as intended. I found
no signature-verification bypass and no unbounded/throwing-input path that
escapes a gate.

Two correctness defects are worth fixing before ship: an ordering bug in the 445
drain that lets an attacker poison the dedup set and silently censor legitimate
group messages, and a produce/consume asymmetry that can render a Welcome
un-decodable. The remaining items are defense-in-depth / consistency notes.

## Warnings

### WR-01: Dedup `seen` set is populated before verification — enables silent censorship of legitimate 445 events

**File:** `src/client/groups-manager.ts:486-507`
**Issue:** In `#connectGroup`'s `drain`, every fresh event id is added to `seen`
_before_ the signature/`h`-cardinality gate runs:

```ts
const fresh = events.filter((event) => !seen.has(event.id));
for (const event of fresh) seen.add(event.id);   // marked seen unconditionally
if (!fresh.length) return;
// ... verification happens AFTER this point
for (const event of fresh) {
  if (!safeVerifyEvent(this.#verifyEvent, event)) { /* rejected */ continue; }
  ...
}
```

A Nostr event id is the hash of everything except `sig`, so an attacker can take
a valid, publicly-visible kind-445 event, flip a byte in `sig` (same id), and
race the corrupted copy to a subscriber (trivial for a malicious relay in the
group's relay set). The corrupted copy is added to `seen`, rejected for
`invalid-signature`, and when the genuine same-id event later arrives it is
dropped by the `!seen.has(event.id)` filter — never verified, never ingested. In
a convergence protocol, silently dropping a commit forks the member and forces a
recovery. It self-heals only on reconnect (fresh in-memory `seen`), but the
window is a real liveness/censorship gap at exactly this trust boundary.

**Fix:** Only record an id in `seen` once it has passed verification (or, at
minimum, do not let a verification/cardinality failure occupy the id):

```ts
const fresh = events.filter((event) => !seen.has(event.id));
if (!fresh.length) return;
const trusted: NostrEvent[] = [];
for (const event of fresh) {
  if (!safeVerifyEvent(this.#verifyEvent, event)) {
    this.emit("rejected", group.id, event, "invalid-signature");
    continue;
  }
  if (getSingletonTagValue(event, "h") === undefined) {
    this.emit("rejected", group.id, event, "tag-cardinality");
    continue;
  }
  seen.add(event.id); // only trusted ids occupy the dedup slot
  trusted.push(event);
}
if (!trusted.length) return;
```

### WR-02: `createWelcomeRumor` permits duplicate relay URLs that the strict consumer (`getWelcome`) then rejects — silently un-joinable invite

**File:** `src/core/welcome-event.ts:52-77` (producer) vs. `105-107` / `151-155` (consumer)
**Issue:** The producer only rejects _empty_ relay URLs:

```ts
if (groupRelays.length === 0 || groupRelays.some((r) => r.length === 0))
  throw new Error(...);
// writes ["relays", ...groupRelays] verbatim — no dedup
```

But the consumer path reads the same tag through `getWelcomeGroupRelays` →
`getListTag`, which returns `undefined` on _duplicate_ values, collapsing to
`[]`, so `getWelcome` throws `"relays tag must contain at least one non-empty
relay URL"`. Result: if an app's group relay list contains an exact-duplicate
URL, `createWelcomeRumor` happily builds and gift-wraps the Welcome, but every
recipient's `getWelcome`/`joinGroupFromWelcome`/`previewWelcome` fails to decode
it. The invite silently never becomes joinable, with a misleading error.

**Fix:** Make the producer as strict as the consumer — dedup (or reject
duplicates) before writing the tag, so a rumor this code emits is always
readable by this code:

```ts
if (new Set(groupRelays).size !== groupRelays.length)
  throw new Error("Welcome rumor relays tag must not contain duplicate URLs");
```

## Info

### IN-01: Kind-1059 `p`-tag cardinality is not enforced despite the table + phase scope listing it

**File:** `src/client/invite-manager.ts:205-236`, `src/utils/tag-cardinality.ts:19-21`
**Issue:** `TAG_CARDINALITY[1059].p === "singleton"` and the phase brief lists 1059
among the entry points gated on cardinality, but `ingestEvent` only runs
`safeVerifyEvent` — it never checks the `p` tag. This is defensible under the
module's stated "validate at each required-tag _read_ site" philosophy (nothing
here reads `p`; routing is done by the relay `#p` filter), so it is not a
correctness bug. Flagging only so the table-vs-enforcement gap is a deliberate,
documented decision rather than an oversight.
**Fix:** Either add a `p` singleton check in `ingestEvent` for symmetry with the
other three gates, or note in the code that 1059 is intentionally signature-only
because `p` is never read for a trust decision.

### IN-02: `evaluateKeyPackageForGroup` performs neither signature verification nor credential-vs-author identity matching

**File:** `src/core/key-package-eligibility.ts:85-176`
**Issue:** This app-facing evaluator decodes the embedded KeyPackage and checks
membership/capabilities/lifetime, but (unlike `createInviteIntent`) does not
verify the event signature nor assert `getCredentialPubkey(...) ===
event.pubkey`. An app that treats an `eligible: true` result as "safe to add"
and then routes through a path other than `GroupsManager.invite` /
`createInviteIntent` would skip the trust boundary. The real invite path
(`createInviteIntent`) re-verifies, so there is no bypass today.
**Fix:** Document that this function assumes an already-verified event and is not
itself a trust boundary, or add the signature + identity-match checks so it
cannot report `eligible` for a spoofed-author KeyPackage.

### IN-03: `isEventId` accepts uppercase hex

**File:** `src/core/welcome-event.ts:20-22`
**Issue:** `/^[0-9a-fA-F]{64}$/` accepts uppercase, but NIP-01 event ids are
canonically lowercase hex. Lenient rather than incorrect (a mixed-case `e` tag
would still not match a real, lowercase-referenced KeyPackage event id
downstream), so impact is nil, but it diverges from canonical form.
**Fix:** Tighten to `/^[0-9a-f]{64}$/` if strict canonical matching is desired.

### IN-04: `isLifetimeWithinCap` accepts an inverted (`notAfter < notBefore`) range

**File:** `src/utils/timestamp.ts:95-99`
**Issue:** The cap check only bounds the upper side (`notAfter - notBefore <=
MAX`), so a degenerate lifetime where `notAfter < notBefore` yields a negative
range that trivially passes. Combined with the symmetric grace window in
`isLifetimeCurrentWithGrace`, a lifetime like `{notBefore: now+1, notAfter:
now-1}` passes both boundary checks. ts-mls lifetime validation on
`add`/`joinGroup` should still reject it, so this is a defense-in-depth gap, not
an exploitable hole.
**Fix:** Add a lower-bound sanity check (`lifetime.notAfter >=
lifetime.notBefore`) to `isLifetimeWithinCap` (or the gates) so a nonsensical
range is rejected at the boundary rather than relying on ts-mls.

---

_Reviewed: 2026-07-22T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
