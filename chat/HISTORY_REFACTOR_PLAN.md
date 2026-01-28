# Chat App Refactor Plan (after Marmot-TS Store/History Design)

Status: draft

This document describes how the demo chat app should be refactored once the Marmot-TS store/history interfaces are standardized.

This plan assumes the library refactor work tracked in [`marmot/LIBRARY_REFACTOR_PLAN.md:1`](marmot/LIBRARY_REFACTOR_PLAN.md:1) has landed.

The primary goal is to ensure the UI has a **single source of truth** for group timelines, avoiding message flicker and disappearing messages.

## Current problems (symptoms)

- Messages “flicker” and disappear
- Users see their own messages but not reliably messages from others
- Notifications of new messages occur, but the timeline doesn’t reflect them consistently

These map to architectural issues:

- competing timeline sources (in-memory buffers vs persisted history)
- inconsistent dedupe across paging vs live updates

## Target architecture

### Single timeline source: history store

The UI should render messages from the per-group history store.

Runtime ingestion (subscriptions) should:

- process outer group events
- write rumors to the history store
- optionally emit “rumor persisted” events

UI should:

- load pages from history
- subscribe to new persisted rumors
- dedupe by `rumor.id`

This aligns with the library design in [`marmot/store-and-history-design.md:1`](marmot/store-and-history-design.md:1).

## Concrete refactor steps

### 1) Remove competing timelines

Today, message delivery occurs via both:

- background subscription buffering in [`chat/src/lib/group-subscription-manager.ts:45`](chat/src/lib/group-subscription-manager.ts:45)
- direct history paging + history event emitter in [`chat/src/hooks/use-group-messages.ts:20`](chat/src/hooks/use-group-messages.ts:20)

Choose one. The recommended choice is: **history store is the single timeline**.

Implication:

- `GroupSubscriptionManager` should not maintain a separate `messageBufferByGroup` intended for UI rendering.
- It can still maintain `seenEventIds` and unread counts.

### 2) Ensure dedupe is uniform

The UI must dedupe rumors by `rumor.id` across:

- paginated loads
- live “rumor persisted” updates

In the current hook, paging uses dedupe but the live listener appends without dedupe (see [`chat/src/hooks/use-group-messages.ts:73`](chat/src/hooks/use-group-messages.ts:73)). The refactor should route all additions through one dedupe path.

### 3) Backfill should be incremental

Once Marmot-TS exposes a resume cursor based on **outer events**, background subscriptions should request only “newer than cursor” using composite `(created_at, id)` boundaries, consistent with MIP-03 conventions in [`marmot/03.md:117`](marmot/03.md:117).

Implementation note:

- Many relays only support timestamp-based `since` filtering.
- The recommended pattern is:
  1. request `since = resume.created_at` (coarse)
  2. client-side filter to only accept events where `(created_at, id) > resume` (precise)

Note: do not fall back to timestamp-only resume. Timestamp-only pagination is insufficient when multiple events share the same second.

### 4) Sent message UX

For immediate feedback, the UI can optimistically insert the local rumor after sending, but it should rely on history persistence as the canonical store.

Avoid requiring each page to manually call history persistence (currently done in [`chat/src/pages/groups/[id].tsx:315`](chat/src/pages/groups/[id].tsx:315)). Prefer that the group send path persists to history (or that the runtime ingestion persists once the client receives its own message back from relays).

## Acceptance criteria

- Opening a group shows a stable timeline with no flicker
- Reloading the page shows previously received messages (history-backed)
- Two users in the same group see each other’s messages reliably
- Incremental backfill does not re-process the full history (uses resume cursor)

## Proposed wiring pattern (reference)

This section describes how modules should interact after the refactor.

### Background runtime

The runtime should be responsible for keeping MLS state fresh and persisting decrypted rumors.

- A background manager (existing: [`chat/src/lib/group-subscription-manager.ts:21`](chat/src/lib/group-subscription-manager.ts:21)) maintains relay subscriptions per group.
- On every incoming outer event:
  1. dedupe by outer event id
  2. call group ingest (MLS processing)
  3. persist outputs to the group history store
  4. advance resume cursor

The background manager should NOT maintain a second UI-visible “timeline buffer”.

It SHOULD treat the history store as the durable sink:

- “live message” notifications must correspond to rumors that have been persisted (or will be immediately persisted)
- UI should subscribe to persisted rumors, not transient in-memory buffers

### UI page

The group page (existing: [`chat/src/pages/groups/[id].tsx:249`](chat/src/pages/groups/[id].tsx:249)) should:

- load initial messages by querying the group’s history store
- subscribe to `history.subscribe` (or EventEmitter) to receive newly persisted rumors
- merge everything through a single dedupe+sort function

### React hook responsibility

The hook (existing: [`chat/src/hooks/use-group-messages.ts:20`](chat/src/hooks/use-group-messages.ts:20)) should become a thin adapter around:

- history paging
- history live subscription

It should not ingest from relays directly.

## What moves where

### Keep in `GroupSubscriptionManager`

- `seenEventIds` (outer event dedupe)
- unread calculation (last message vs last seen)
- background reconcile of subscriptions

### Remove from `GroupSubscriptionManager`

- `messageBufferByGroup` as a UI timeline source
- `onApplicationMessage()` callbacks intended to drive rendering

### Keep in the history store layer

- durable rumor storage
- resume cursor and stable pagination
- “rumor persisted” notifications

## Notes on ordering

For UI rendering, sort rumors by `(rumor.created_at, rumor.id)`.

For backfill/resume from relays, filter by `(outer.created_at, outer.id)` using the MIP-03 timestamp/id convention in [`marmot/03.md:117`](marmot/03.md:117).

### Note on interface drift

This plan intentionally references _semantic_ requirements rather than the current demo implementations.

As the library refactor lands, ensure the chat app wiring matches the standardized per-group history API described in [`marmot/store-and-history-design.md:79`](marmot/store-and-history-design.md:79) and the implementation sequence in [`marmot/LIBRARY_REFACTOR_PLAN.md:1`](marmot/LIBRARY_REFACTOR_PLAN.md:1).
