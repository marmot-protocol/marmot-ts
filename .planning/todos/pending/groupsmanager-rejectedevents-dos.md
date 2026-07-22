---
id: groupsmanager-rejectedevents-dos
created: 2026-07-22
source: 02-REVIEW.md
severity: warning
resolves_phase: 3
---

# Remove unbounded `rejectedEvents` Set in GroupsManager #connectGroup

From `02-REVIEW.md` (WR-01/WR-02/IN-01), introduced by plan 02-04's deviation.

**Problem:** `#connectGroup`'s drain (`src/client/groups-manager.ts` ~line 495) keeps a
`Set<NostrEvent>` of untrusted, already-rejected event _objects_, unbounded, for the
connection lifetime. A hostile relay can stream unlimited distinct invalid 445 events and
pin memory forever (DoS-adjacent). Its object-identity dedup also does not work in
production (fresh deserialized objects per relay message), so it only ever suppresses a
duplicate `rejected` under `MockNetwork`'s shared-array replay — it is effectively untested.

**Why not a quick fix:** rejections cannot be deduped by `event.id` — that would re-open the
WR-01 censorship bug (a same-id genuine event must still be processed).

**Recommended fix:** drop `rejectedEvents` entirely; filter only on `!seen.has(event.id)`.
Accept that a backfill+subscription redelivery of the same malformed event emits `rejected`
twice — this is informational, not a protocol-safety concern, and matches the InviteManager
sibling boundary (IN-01). Loosen the two exact-count tests in
`src/__tests__/groups-manager.test.ts` ("rejects an inbound 445 event with an invalid
signature", "rejects a properly-signed 445 event carrying a duplicate h tag") from
`toHaveLength(1)` to `>= 1` with all reasons asserted.
