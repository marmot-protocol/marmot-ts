---
phase: 03-commit-integrity-convergence-parity
reviewed: 2026-08-04T16:55:00Z
depth: standard
files_reviewed: 23
files_reviewed_list:
  - src/core/components/integrity.ts
  - src/core/components/index.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/inbound.ts
  - src/engine/types.ts
  - src/engine/ingest-disposition.ts
  - src/engine/state-notifications.ts
  - src/engine/index.ts
  - src/engine/admin-policy.ts
  - src/engine/ingest.ts
  - src/engine/fork-recovery.ts
  - src/engine/group-engine.ts
  - src/engine/__tests__/state-notifications.test.ts
  - src/engine/__tests__/convergence-parity.test.ts
  - src/engine/__tests__/commit-legality-seams.test.ts
  - src/engine/__tests__/send-commit-legality.test.ts
  - src/engine/__tests__/self-eviction.test.ts
  - src/engine/__tests__/state-notification-withdrawal.test.ts
  - src/client/session/group-session.ts
  - src/client/group/marmot-group.ts
  - src/client/groups-manager.ts
  - src/__tests__/groups-manager.test.ts
  - src/__tests__/integration/removed.test.ts
findings:
  critical: 7
  warning: 13
  info: 3
  total: 23
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-08-04T16:55:00Z
**Depth:** standard
**Files Reviewed:** 23
**Status:** issues_found

## Summary

The phase claims three seams (send/staging, inbound, convergence/replay) all funnel
through one `validateCommitLegality`, that the CONV-04 `knownNextStates` short-circuit
is safe, and that CONV-02/CONV-03 marker + notification lifecycles are closed. Tracing
the code, none of those three claims fully holds.

Highest-value defects, in the order the phase context prioritised them:

1. **Seam divergence is real and load-bearing.** `send({kind:"selfUpdate"})` produces a
   commit and never calls `validateCommitLegality` (nor the D-05 admin-policy splice /
   D-07 depletion guard) even though `createCommit` bundles every unapplied proposal by
   reference. `#buildBranches`'s `known` short-circuit skips validation entirely, in
   direct contradiction of the fail-closed no-grandfathering policy the sibling
   `#treeResolution` implements for the same class of persisted history. The three seams
   also bind three *different* admin-verification callbacks (batch-start state, current
   tip, per-node state).
2. **The `knownNextStates` short-circuit is keyed only by commit digest.** It is consulted
   at *any* DFS node whose epoch matches the commit's source epoch — including nodes on a
   competing fork — so a competitor branch can splice our canonical chain onto itself and
   win selection on inflated depth.
3. **`validateCommitLegality` can throw**, and the convergence/replay seams do not catch
   it; the throw escapes the ingest generator and skips `GroupSession.save()`.
4. **The CONV-02 marker is written before the state it describes is persisted**, and the
   one path documented to clear it (`reconverge()` on load) throws its results away.
5. **A rewind that applies >1 commit derives notifications only for the tip link**, so
   intermediate commits' membership/component notifications are silently lost and are
   never ledger-recorded (hence never withdrawable).

Additionally, the persisted removal marker (`removedMarkerStore`) is not plumbed through
`GroupsManagerOptions` / `GroupRegistry` / `GroupFactory` / `MarmotClient`, so no
consumer using the public client API can actually get the persistence CONV-02 promises.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `knownNextStates` is keyed by commit digest alone — it can fire on the wrong parent

**File:** `src/engine/fork-recovery.ts:195-215` (lookup), `src/engine/fork-recovery.ts:349-359` (map build), `src/engine/fork-recovery.ts:151-176` (`candidatesAt`)

**Issue:** `candidatesAt(state)` admits any pooled message whose framed epoch equals
`Number(state.groupContext.epoch)` — it does **not** check that the message's parent is
`state`. The `known` lookup then keys purely on `bytesToHex(this.#commitDigestOf(message))`.
Consequently, while exploring a *competing* fork branch, the DFS reaching a node at epoch
`N` will find our own canonical commit with source epoch `N` in `pool` (it is prepended as
`[...ours, ...pool]`), hit `knownNextStates`, and adopt our canonical epoch-`N+1` state as
that fork node's child.

Reachability (depth ≥ 2 above the fork root, which the new
`convergence-parity.test.ts` scenarios never build):

- root at epoch `F`; `ours` = [commit@F, commit@F+1]; a peer commit@F is in `pool`.
- DFS explores peer commit@F via `processMessage` → fork-B node at epoch `F+1`.
- At fork-B, `candidatesAt` returns our commit@F+1 (epoch matches) → `known` hit → `next.newState`
  is our canonical state at `F+2`, which fork-B's commit never produced.

Consequences:
- A bogus `ChainLink { parent: forkB, message: ourCommit, child: ourCanonicalState }` is
  appended, so the losing branch inherits our canonical chain's depth and tip digest —
  directly biasing `selectCanonicalBranch`, whose primary key is branch depth.
- If that branch wins, `#applyForkResolution` calls
  `this.#retained.record(link.parent, link.message, link.child)` (`group-engine.ts:1622-1629`)
  with a parent that never produced that child, corrupting `RetainedHistoryStore`'s
  epoch→state / epoch→commit mapping used by every subsequent `resolveFork`.
- A false `EdgeSnapshot` is emitted (`fork-recovery.ts:258-265`). This one is currently
  absorbed because `GroupHistoryTree.recordEdge` no-ops when the child tag already exists
  (`history-tree.ts:394-411`) — that is luck, not a guard.

**Fix:** Only take the short-circuit when the current DFS `state` is the exact parent the
commit was applied to. Record the parent tag alongside the known child state:

```ts
// resolveFork
const knownNextStates = new Map<string, { parentTag: string; state: ClientState }>();
for (const msg of ours) {
  const sourceEpoch = framedEpoch(msg);
  if (sourceEpoch === undefined) continue;
  const parent = retained.stateAt(Number(sourceEpoch));
  const next = retained.stateAt(Number(sourceEpoch) + 1);
  if (!parent || !next) continue;
  knownNextStates.set(bytesToHex(this.#commitDigestOf(msg)), {
    parentTag: bytesToHex(parent.confirmationTag),
    state: deserializeClientState(serializeClientState(next)),
  });
}

// #buildBranches / explore
const known = knownNextStates.get(bytesToHex(this.#commitDigestOf(message)));
const useKnown =
  known !== undefined &&
  known.parentTag === bytesToHex(state.confirmationTag);
```

Add a regression test with a fork whose competing branch is ≥2 commits deep.

---

### CR-02: `validateCommitLegality` can throw, and the convergence/replay seams do not catch it

**File:** `src/core/components/integrity.ts:277-286`; escape paths `src/engine/fork-recovery.ts:244-249`, `src/engine/group-engine.ts:1873-1886`, `src/engine/ingest.ts:804-809`

**Issue:** `validateCommitLegality` calls
`getAppComponents(args.parentState.groupContext.extensions)` with no guard.
`getAppComponents` → `getComponent` → `decodeComponentsList`, which throws on malformed
bytes or a duplicate component id (`src/core/components/app-components-list.ts:28-41`).
`validateAdminLeafCoupling` deliberately wraps its own decode in `try/catch` and returns a
typed violation; the shared adapter does not do the same for `getAppComponents`, so the
"non-throwing by design (D-01/D-02)" contract documented at
`integrity.ts:16-26` is violated.

The bytes are attacker-influenceable: an admin can commit an `AppDataUpdate` writing
arbitrary bytes to component `0x0001`. Rule 3 accepts it (the change *is* backed by that
commit's own op) and Rule 2 only checks presence, never decodability. From the next commit
onward, every seam calls `getAppComponents(parentState)` on those bytes:

- **Inbound** (`ingest.ts:697`): caught by the enclosing `try` at `ingest.ts:656`, so the
  commit is pushed onto `unreadable`/retry and finally reported terminal. Net effect:
  the group can never apply another commit — permanent stall, with a misleading
  `invalid_encoding` disposition.
- **Convergence/replay** (`fork-recovery.ts:244`) and **tree re-convergence**
  (`group-engine.ts:1873`): **not** wrapped. The throw propagates out of `explore` →
  `#buildBranches` → `ForkRecovery.resolveFork` → `MarmotGroupEngine.#resolveFork` →
  `await ctx.resolveFork(...)` at `ingest.ts:804` (no `try`) → out of the ingest async
  generator. `GroupSession.ingest` (`group-session.ts:548-562`) therefore never reaches
  `await this.save()`, so any state already advanced in that batch is left unpersisted.

**Fix:** Make the adapter honour its own non-throwing contract, and defensively guard the
replay seams:

```ts
export function validateCommitLegality(args: {...}): CommitIntegrityViolation | undefined {
  const appDataUpdateOps = collectAppDataUpdateOps(args.proposals);
  let requiredIds: readonly AppComponentId[];
  try {
    requiredIds = getAppComponents(args.parentState.groupContext.extensions) ?? [];
  } catch {
    return {
      reason: "component-integrity",
      detail: "current app_components component did not decode",
    };
  }
  // ...unchanged
}
```

---

### CR-03: `send({ kind: "selfUpdate" })` bypasses every commit-legality guard the `commit` seam gained

**File:** `src/engine/group-engine.ts:743-764` (no validation), compare `src/engine/group-engine.ts:700-718`

**Issue:** `selfUpdate` builds a real commit via `createCommit(... extraProposals: [])`.
As the phase's own comment states at `group-engine.ts:578-585`, *"createCommit bundles
every entry of `this.state.unappliedProposals` by reference in addition to
`commitOptions.extraProposals`"*. Passing `extraProposals: []` does not exclude the
by-reference set. A `selfUpdate` therefore commits whatever proposals are staged — a peer's
`Remove` that de-leafs the last admin account, or an `AppDataUpdate` rewriting the
dictionary.

Because the `selfUpdate` branch runs none of:
- the D-05 admin-policy auto-coupling splice,
- the D-07 `AdminDepletionError` guard,
- `validateCommitLegality`,

the engine will happily wrap and publish a commit that its **own inbound seam**
(`ingest.ts:697-718`) rejects with `admin-leaf-coupling` / `component-integrity`, and that
every conformant peer rejects. This is exactly the mdk#707 "a guard that exists on one seam
only" bug class the phase set out to close. `MarmotGroup.selfUpdate()` is a public,
non-admin-callable API (`marmot-group.ts:546-553`), and per MIP-02 it is called right after
joining from a Welcome — a moment when staged proposals from other members are plausible.
No test in `send-commit-legality.test.ts` or `commit-legality-seams.test.ts` mentions
`selfUpdate`.

**Fix:** Factor the post-`createCommit` validation out of `case "commit"` and run it in
`case "selfUpdate"` too, against the same by-reference union:

```ts
case "selfUpdate": {
  const parentState = this.state;
  const { commit, newState } = await createCommit({ /* ...unchanged... */ });
  const violation = validateCommitLegality({
    parentState,
    resultingState: newState,
    proposals: Object.values(parentState.unappliedProposals).map((p) => p.proposal),
  });
  if (violation) throw new UsageError(violation.detail);
  // ...unchanged
}
```

Better still: hoist the D-05/D-07 auto-coupling block into a shared helper both branches call.

---

### CR-04: the `known` short-circuit grandfathers exactly the violations `#treeResolution` refuses to grandfather

**File:** `src/engine/fork-recovery.ts:198-215` vs `src/engine/group-engine.ts:1810-1887`

**Issue:** `#treeResolution` documents and implements a strict fail-closed policy: *"a
persisted tree edge may have been written by a pre-upgrade build that never enforced
`validateCommitLegality`, so adopting it without re-checking would be grandfathering a
violation the send/inbound/replay seams would all now refuse"* — and abandons the whole
switch on any failing link.

`#buildBranches`'s `known` branch does the opposite for the same class of data. Commits in
`ours` come from `RetainedHistoryStore`, which is rebuilt on load from the persisted
history tree — i.e. exactly the pre-upgrade edges `#treeResolution` distrusts. The `known`
path assigns `next` directly and jumps past both `capture.take()` and
`validateCommitLegality`, so a violating commit that was accepted by an older build is
replayed into a winning candidate branch without any re-check.

Two seams, opposite policies, on the same input class. Criterion 1 ("these three behave
IDENTICALLY") is not met.

**Fix:** Even on the `known` path, run the validator using the recorded parent and known
child, deriving proposals from a replay-free source (the stored commit's proposals can be
decoded from `link.message`, or the parent-matched edge can be re-validated as
`#treeResolution` does). At minimum, document + assert the invariant that everything in
`ours` was validated by this build, and re-validate whenever the retained store was
rehydrated from disk.

---

### CR-05: the removal marker is persisted before the tombstone `ClientState` is persisted

**File:** `src/client/group/marmot-group.ts:681-700`, `src/client/group/marmot-group.ts:767-770`, `src/client/session/group-session.ts:548-562`

**Issue:** Ordering in the live-removal path is:

1. `ingestEnvelopes` applies the removing commit and yields `{kind:"removed"}`
   (in-memory state → `removedFromGroup`).
2. `MarmotGroup.ingest` awaits `#realizeRemovalIfNeeded()`, which **writes
   `removedMarkerStore[idStr] = true`** and emits `removed`.
3. Only after the generator is fully drained does `GroupSession.ingest` reach
   `await this.save()` (`group-session.ts:562`) and persist the tombstone.

Any failure between 2 and 3 — a throw from a `removed` listener, an aborted `for await`
(e.g. a consumer that `break`s, which `GroupsManager.#connectGroup` does not but any app
may), a process exit, or a `save()` rejection — leaves `marker = true` with a **non-tombstone**
persisted `ClientState`.

On the next load, `fromClientState` → `#realizeRemovalIfNeeded` returns early
(`marmot-group.ts:682`, state is not the tombstone). When the removing commit is re-ingested
from relays, the `removed` result fires `#realizeRemovalIfNeeded` again, which reads
`alreadyRealized === true` and returns at line 688 — **the `removed` event is never emitted,
and queued outbound is never rejected.** That is the permanent silent suppression the
marker exists to prevent.

**Fix:** Persist the state before setting the marker, or make the marker write the last
step of an atomic realization:

```ts
if (result.kind === "removed") {
  this.log("removed from group by inbound commit");
  await this.save(true);            // persist the tombstone first
  await this.#realizeRemovalIfNeeded();
}
```

and drop the marker write if the subsequent save fails.

---

### CR-06: `reconverge()` discards `stateInvalidated` results, so a load-time rewind never clears the marker

**File:** `src/engine/group-engine.ts:1768-1770`, `src/client/session/group-session.ts:377-380`, `src/client/group/marmot-group.ts:778-784`

**Issue:** The only site that clears the removal marker on supersession is the
`stateInvalidated` handler inside `MarmotGroup.ingest`. But `reconvergeFromHistory()` is:

```ts
async reconvergeFromHistory(): Promise<void> {
  for await (const _ of this.#reconvergeFromTree([])) void _;
}
```

Every `stateInvalidated` result `#reconvergeFromTree` yields (`group-engine.ts:1739-1748`)
is thrown away, and `GroupSession.reconverge()` (`group-session.ts:377-380`) exposes only
`Promise<void>` — so `MarmotGroup.reconverge()` and the documented "Called automatically on
load" path can never clear the marker.

Concretely: a client that was removed on a losing fork, restarts, and re-converges from disk
onto a branch where it is still a member ends up with canonical membership restored **and a
stale `marker = true`**. A later genuine removal is then silently suppressed (see CR-05 for
the same terminal symptom). This is precisely the scenario the doc comment at
`marmot-group.ts:702-709` says the CONV-03 path must handle.

**Fix:** Make the reconverge path yield its results, or give it an explicit hook:

```ts
// GroupSession
async *reconverge(): AsyncGenerator<DispositionedIngestResult> {
  for await (const r of this.#engine.reconvergeFromTree([])) {
    yield { ...mapEngineIngestResult(r), disposition: ingestResultDisposition(r) };
  }
  await this.save();
}
// MarmotGroup.reconverge drains it through the same
// `stateInvalidated`/`selfRemoved` marker-clearing branch as ingest().
```

---

### CR-07: a rewind spanning more than one commit derives notifications only for the tip link

**File:** `src/engine/group-engine.ts:1642-1659`

**Issue:**

```ts
const tipLink = resolution.winnerChain.at(-1);
if (tipLink) {
  const tipDigest = commitDigest(encode(mlsMessageEncoder, tipLink.message));
  tipNotifications = deriveStateNotifications({
    parentState: tipLink.parent,
    resultingState: resolution.winnerTip,
    commitDigest: tipDigest,
  });
  this.#stateNotifications.record(tipDigest, ..., tipNotifications);
}
```

`winnerChain` can hold N links (`fork-recovery.ts:266-272` accumulates one per applied
commit; `#treeResolution` builds one per path segment). Only the last one is diffed. Two
concrete failures:

1. **Lost notifications.** If the rewind adopts a 3-commit branch that added Alice at
   `F+1`, removed Bob at `F+2`, and rotated a key at `F+3`, the caller is told only about
   `F+3`. `memberAdded(Alice)` and `memberRemoved(Bob)` are never emitted. `epochAdvanced`
   reports `F+2 → F+3` even though the client jumped from `F` (or its old losing tip).
2. **Non-withdrawable ledger.** Because those notifications are never `record()`ed, a
   *subsequent* rewind that supersedes commits `F+1`/`F+2` has nothing to withdraw for
   them — `invalidatedByRewind` can only withdraw what was recorded. CONV-03's stated
   invariant ("a rewind that supersedes the commit can withdraw exactly the notifications
   it derived") does not hold for multi-commit rewinds.

**Fix:** Derive and record per link, and return the concatenation:

```ts
const tipNotifications: StateNotification[] = [];
for (const link of resolution.winnerChain) {
  const digest = commitDigest(encode(mlsMessageEncoder, link.message));
  const derived = deriveStateNotifications({
    parentState: link.parent,
    resultingState: link.child,
    commitDigest: digest,
  });
  this.#stateNotifications.record(
    digest,
    Number(link.child.groupContext.epoch),
    derived,
  );
  tipNotifications.push(...derived);
}
```

(`AppliedForkResolution.notifications` should then be documented as "for the whole applied
chain", and `ingest.ts:828-843` keeps working unchanged.)

---

## Warnings

### WR-01: `removedMarkerStore` is unreachable through the public client API

**File:** `src/client/group/marmot-group.ts:140-152`; absent from `src/client/groups-manager.ts:77-126`, `src/client/group-registry.ts`, `src/client/group-factory.ts`

**Issue:** `grep -rn removedMarkerStore src/` finds it only on `MarmotGroupOptions`, inside
`MarmotGroup`, and in tests. `GroupsManagerOptions` plumbs `store` and `rewindStore` to both
`GroupRegistry` and `GroupFactory` but never `removedMarkerStore`, and `MarmotClient` has no
knob either. Every consumer going through `GroupsManager`/`MarmotClient` — i.e. all of them —
silently gets the documented in-memory degradation, so CONV-02's "realization survives a
restart" is not achievable in practice. The integration test constructs `MarmotGroup`
directly (`removed.test.ts:62-69`), so it never exercises the real wiring.

**Fix:** Add `removedMarkerStore?: GenericKeyValueStore<boolean>` to `GroupsManagerOptions`
and forward it through `GroupRegistry` and `GroupFactory` into `MarmotGroupOptions`, plus a
test that goes through `GroupsManager`.

---

### WR-02: `StateNotificationLedger` is unbounded under the explicitly supported `maxRewindCommits: Infinity`

**File:** `src/engine/state-notifications.ts:193-200`, `src/engine/state-notifications.ts:236-238`; `src/engine/group-engine.ts:1468-1472`, `src/engine/group-engine.ts:1661-1665`

**Issue:** The ledger's only bound is `pruneBelow(anchorEpoch())`. With
`maxRewindCommits: Infinity` — documented as supported on both
`MarmotGroupEngineOptions.convergencePolicy` (`group-engine.ts:171-176`) and
`MarmotGroupOptions.convergencePolicy` (`marmot-group.ts:163-168`) —
`prunableRetainedEpochs` computes `floor = Math.max(0, tip - Infinity) === 0`
(`src/core/retained-history.ts:89`), so `RetainedHistoryStore` never prunes,
`anchorEpoch()` stays pinned at the initial epoch forever, and `pruneBelow` is a permanent
no-op. Every commit's notifications accumulate for the process lifetime. `DeliveredPayloadLedger`
has the identical shape and the identical problem (`group-engine.ts:1464-1466`). The class
doc's claim that entries "stay bounded to the rollback horizon" is false in that
configuration.

**Fix:** Add an absolute entry cap independent of the anchor (mirror `IngestionPoolOptions`'s
`maxEntries`), evicting oldest-epoch entries first:

```ts
constructor(private readonly maxEntries = 4096) {}
record(...) {
  if (notifications.length === 0) return;
  this.#entries.push({ digest: bytesToHex(digest), epoch, notifications });
  if (this.#entries.length > this.maxEntries)
    this.#entries.splice(0, this.#entries.length - this.maxEntries);
}
```

---

### WR-03: the audit log hardcodes `admin_policy` for every rejection, misattributing the two new reasons

**File:** `src/engine/group-engine.ts:1388-1394`

**Issue:**

```ts
if (result.kind === "rejected") {
  this.#emitAudit({ type: "rejection", msg_id: msgId, reason: "admin_policy" });
}
```

`RejectedIngestResult.reason` is now a 3-value union (`admin-policy` |
`component-integrity` | `admin-leaf-coupling`, `types.ts:99-112`), and `ingest.ts` populates
it correctly. The forensic audit trail — the one artifact a post-incident investigator reads
— records all three as `admin_policy`, making the new WIRE-03/CONV-01 rejections invisible
and actively misleading.

**Fix:**

```ts
if (result.kind === "rejected") {
  this.#emitAudit({
    type: "rejection",
    msg_id: msgId,
    reason: (result.reason ?? "admin-policy").replace(/-/g, "_"),
  });
}
```

---

### WR-04: the send seam discards `violation.reason` and throws a generic `UsageError`

**File:** `src/engine/group-engine.ts:707-717`

**Issue:** `throw new UsageError(violation.detail)` propagates only the diagnostic string,
which `integrity.ts:36-38` explicitly designates as *"a diagnostic string ... The
protocol-visible signal is `reason`."* Callers wanting to branch on
`component-integrity` vs `admin-leaf-coupling` must string-match a message that the same
docblock says is free to change. It is also inconsistent with the sibling guard in this very
switch, which throws a typed `AdminDepletionError` (`group-engine.ts:126-133`).

**Fix:** Add a typed error carrying the violation:

```ts
export class CommitLegalityError extends Error {
  constructor(readonly violation: CommitIntegrityViolation) {
    super(violation.detail);
    this.name = "CommitLegalityError";
  }
}
// ...
if (violation) throw new CommitLegalityError(violation);
```

---

### WR-05: `validateAdminLeafCoupling` misattributes a *current*-epoch decode failure to the resulting epoch

**File:** `src/core/components/integrity.ts:222-236`

**Issue:** The `try` block spans both `getAdminPolicy(args.resultingExtensions)` and the
carried-forward `getAdminPolicy(args.currentExtensions)`. When the *current* (inherited,
already-accepted) admin-policy bytes fail to decode, the returned violation reads
`"resulting admin-policy component did not decode"` — blaming a commit that did not touch
admin policy at all, and rejecting it. Every subsequent commit is rejected the same way,
wedging the group with a diagnostic that points the operator at the wrong epoch.

**Fix:** Split the two decodes so the detail names the right side, and consider treating a
malformed *carried-forward* policy as a separate, non-commit-attributable condition:

```ts
let resultingSet: string[] | undefined;
try {
  resultingSet = getAdminPolicy(args.resultingExtensions);
} catch {
  return { reason: "admin-leaf-coupling", detail: "resulting admin-policy component did not decode" };
}
let resultingAdmins: string[];
if (resultingSet !== undefined) resultingAdmins = resultingSet;
else {
  try {
    resultingAdmins = getAdminPolicy(args.currentExtensions) ?? [];
  } catch {
    return { reason: "admin-leaf-coupling", detail: "carried-forward admin-policy component did not decode" };
  }
}
```

---

### WR-06: `#maybeAutoCommitSelfRemoves` has no `removedFromGroup` guard, and `send()` now throws for a removed group

**File:** `src/engine/group-engine.ts:880-888`, `src/engine/group-engine.ts:1198-1272`, `src/engine/group-engine.ts:440-444`

**Issue:** `ingest()` unconditionally calls `#maybeAutoCommitSelfRemoves()` after draining
the batch, including on the path where `ingestEnvelopes` just returned after applying a
commit that removed us. D-14 added an unconditional throw at the top of `send()`
("Cannot send: this client has been removed from the group."). If the tombstone state still
carries pending `self_remove` proposals in `unappliedProposals` and this client is elected
committer, `#maybeAutoCommitSelfRemoves` reaches `await this.send({kind:"commit", ...})`
(line 1259) and the throw escapes `ingest()` entirely, aborting the generator — and with it
`GroupSession.ingest`'s trailing `await this.save()`, so the tombstone is not persisted.

Today this is *usually* masked because `getCredentialFromLeafIndex(state.ratchetTree,
state.privatePath.leafIndex)` at line 1237-1245 throws for a blanked own leaf and is caught.
That is incidental, not a guard, and D-13/D-14 apply the check explicitly everywhere else.

**Fix:**

```ts
async #maybeAutoCommitSelfRemoves(): Promise<AutoCommitIngestResult<TEnvelope> | undefined> {
  if (this.#state.groupActiveState.kind === "removedFromGroup") return undefined;
  if (!mayPrepareLocalCommit(this.#lifecycle)) return undefined;
  // ...
}
```

---

### WR-07: the D-13 self-eviction short-circuit is incomplete — `#sweepTree` still decrypts after removal

**File:** `src/engine/ingest.ts:329-338`, `src/engine/group-engine.ts:900-978`

**Issue:** The D-13 guard is placed inside `ingestEnvelopes`, but `#ingestWithPool` continues
past it: `#sweepTree()` (line 939) peels and `processMessage`s every pooled envelope against
every retained tree node and can yield `processed` application messages, and `evictStale`
(line 964) still yields `unreadable`. `member-departure.md` is quoted in the guard's own
comment as saying such input *"need not be decrypted or authenticated"* — the sweep does
both, for a group we have been evicted from.

The deliberate exemption documented at `group-engine.ts:948-954` is for
`#reconvergeFromTree` (which evaluates already-retained material, not fresh input); it does
not cover `#sweepTree`.

**Fix:** Gate the pooled sweeps on membership:

```ts
const evicted = this.#state.groupActiveState.kind === "removedFromGroup";
if (!evicted && this.#pool.size > 0) yield* this.#sweepTree();
```
(keep `#reconvergeFromTree` unconditional, per the documented asymmetry).

---

### WR-08: the `seen` dedup Set is unbounded and attacker-growable; removing `rejectedEvents` re-verifies invalid events on every redelivery

**File:** `src/client/groups-manager.ts:496`, `src/client/groups-manager.ts:505-517`

**Issue:** This phase removed the `rejectedEvents` Set but left `seen` unbounded. `seen`
accumulates the id of every *trusted* kind-445 event for the life of the subscription. The
`h` routing tag is public, and any keypair can sign a valid kind-445 event carrying it — such
an event passes both trust gates, is added to `seen` permanently, **and** is handed to
`group.ingest()`. So the "unbounded Set" the todo aimed to remove is still present in the
larger of the two.

Separately, the removal means an invalid-signature event redelivered by a relay is
re-verified (a secp256k1 verification per delivery) and re-emitted as `rejected` every time,
because `fresh` filters on `seen` only. The tradeoff is documented, but it converts a
cached rejection into unbounded repeated work + repeated app-level callbacks under a replay
flood.

**Fix:** Bound `seen` with an LRU/ring (e.g. last 10k ids) and, if repeated `rejected`
emissions matter to consumers, bound a rejected-id (not object) cache the same way rather
than reintroducing an unbounded Set.

---

### WR-09: `#realizeRemovalIfNeeded` has a check-then-act race across its `await`

**File:** `src/client/group/marmot-group.ts:684-689`

**Issue:**

```ts
const alreadyRealized = await this.#removedMarkerStore.getItem(this.idStr);
if (alreadyRealized) return;
await this.#removedMarkerStore.setItem(this.idStr, true);
```

Two concurrent invocations — e.g. `GroupRegistry` loading the group
(`fromClientState` → line 510) while a `connectAll` drain is already ingesting the removing
commit — can both observe `alreadyRealized === false` before either writes, producing two
`removed` emissions and two `#rejectQueuedOutbound` calls. The method's contract is "exactly
once".

**Fix:** Guard with an in-flight promise:

```ts
#realizing?: Promise<void>;
async #realizeRemovalIfNeeded(): Promise<void> {
  return (this.#realizing ??= this.#realizeRemovalInner().finally(() => {
    this.#realizing = undefined;
  }));
}
```

---

### WR-10: the marker is cleared without re-checking that canonical state left the tombstone

**File:** `src/client/group/marmot-group.ts:778-784`

**Issue:** The clear fires on *any* `stateInvalidated` whose `withdrawn` contains a
`selfRemoved`, regardless of the state the rewind actually landed on. A rewind that
supersedes removal-commit A but lands on a branch that also removes us (commit B) withdraws
A's `selfRemoved`, clears the marker, and leaves `groupActiveState.kind ===
"removedFromGroup"` — with no re-emit of `removed`. The next `fromClientState` load then
sees tombstone + no marker and emits a duplicate `removed`, violating the "exactly once"
contract from the other direction.

**Fix:**

```ts
if (
  result.kind === "stateInvalidated" &&
  result.withdrawn.some((n) => n.kind === "selfRemoved") &&
  this.state.groupActiveState.kind !== "removedFromGroup"
) {
  await this.#clearRemovalMarker();
}
```

---

### WR-11: the three seams bind three different admin-verification callbacks

**File:** `src/engine/ingest.ts:598`, `src/engine/group-engine.ts:1531`, `src/engine/group-engine.ts:1814-1816`, `src/engine/group-engine.ts:1079-1081`

**Issue:** `withCapturedProposals` now wraps a callback whose admin set / ratchet tree is
snapshotted at four different moments:
- inbound: `ctx.createAdminCallback()` built **once before the commit loop**, so the second
  and later commits in a multi-commit batch are checked against the pre-batch admin set and
  ratchet tree;
- pool-replay: `#createAdminVerificationCallback()` at the current tip, then applied to
  candidate states at arbitrary earlier epochs;
- tree re-convergence: `#createAdminVerificationCallback()` at the current tip, applied to
  every `link.parent` on a persisted chain;
- sweep: `#createAdminVerificationCallback(state)`, correctly per-node.

Since MIP-03 admin membership can change mid-batch (an `AppDataUpdate` to `0x8002`), the
same commit can be accepted on one seam and rejected on another. Criterion 1 requires these
to agree.

**Fix:** Always derive the callback from the state the commit is being applied to. In
`ingest.ts`, rebuild it per iteration:

```ts
const capture = withCapturedProposals(ctx.createAdminCallback());
// -> move inside the loop, or add ctx.createAdminCallbackFor(state)
```
and pass `state` in `#buildBranches`/`#treeResolution`.

---

### WR-12: engine and session `IngestResult` unions are hand-duplicated and already diverge

**File:** `src/client/session/group-session.ts:36-142` vs `src/engine/types.ts:86-262`

**Issue:** `GroupSession` redeclares all nine result variants by hand. The engine's
`UnreadableIngestResult` carries `decryptFailure?: boolean` (`types.ts:138-150`); the session's
does not (`group-session.ts:78-82`) — but `mapEngineIngestResult` spreads it through, so the
runtime value carries a field the public type denies. `ProcessedIngestResult` similarly uses
inline `import("ts-mls")` types instead of the shared imports. Every future variant/field must
be edited in two places; this one already drifted.

**Fix:** Derive the session types mechanically from the engine ones:

```ts
type Renamed<T> = T extends { envelope: NostrEvent }
  ? Omit<T, "envelope"> & { event: NostrEvent }
  : T;
export type IngestResult = Renamed<EngineIngestResult<NostrEvent>>;
```

---

### WR-13: duplicate byte-equality predicates with divergent bodies

**File:** `src/core/components/integrity.ts:88-96`, `src/engine/state-notifications.ts:49-57`

**Issue:** `bytesEqual` and `componentBytesEqual` are the same predicate, defined twice.
`bytesEqual` adds `&& a.length === b.length`, which is dead — `compareBytes` already returns
`a.length - b.length` when the common prefix matches (`src/core/components/bytes.ts:9`).
Beyond the duplication, the divergence invites a future "fix" to one that does not land on the
other, silently desynchronising integrity checking from notification diffing.

**Fix:** Export one `bytesEqual` from `src/core/components/bytes.ts` and import it in both
places; drop the redundant length comparison.

---

## Info

### IN-01: fallthrough + a no-op eslint directive in the disposition map

**File:** `src/engine/ingest-disposition.ts:36-55`

**Issue:** The `skipped` case relies on the inner switch being exhaustive so control never
reaches the `// eslint-disable-next-line no-fallthrough` comment and drops into
`case "unreadable"`. This does compile-time-fail if a new `reason` is added
(`noFallthroughCasesInSwitch` is on in `tsconfig.build.json`), so it is safe today — but the
control flow is non-obvious, and the eslint directive is inert since there is no root ESLint
config (only `ts-mls/eslint.config.mjs`).

**Fix:** Replace the fallthrough with an explicit exhaustiveness assertion:

```ts
case "skipped": {
  switch (result.reason) { /* ...cases... */ }
}
case "unreadable":
  return disposition.stale(inputCategories.invalidEncoding);
```
→ give the inner switch a `default: { const _never: never = result.reason; return _never; }`
and remove the comment.

---

### IN-02: trust-boundary tests relaxed from exact counts to `>= 1`

**File:** `src/__tests__/groups-manager.test.ts:196-205`, `:243-248`, `:310-321`

**Issue:** Three assertions changed from `expect(rejections).toHaveLength(1)` to
`expect(rejections.length).toBeGreaterThanOrEqual(1)`. The relaxation is justified by the
`rejectedEvents` removal, but it now also passes if a regression emits hundreds of
`rejected` events per delivery.

**Fix:** Assert the exact expected count for the known fixture (2 for the
backfill+subscribe redelivery case, 1 elsewhere) rather than an open lower bound.

---

### IN-03: `#emitIngestOutcome` narrows on `stateInvalidated` only to avoid `idOf(undefined)`

**File:** `src/engine/group-engine.ts:1362-1367`

**Issue:** The early return is correct, but the reason is a structural one (the variant has
no `envelope`), enforced only by a comment. If a future generic-free variant is added, the
next `this.peeler.idOf(result.envelope)` is a runtime `undefined` deref. Audit wiring for
`stateInvalidated` is also explicitly deferred, so these rewind withdrawals produce no audit
record at all.

**Fix:** Narrow on the presence of the field (`if (!("envelope" in result)) return;`) and
file the deferred audit wiring as a tracked item.

---

_Reviewed: 2026-08-04T16:55:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
