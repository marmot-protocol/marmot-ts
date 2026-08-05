---
phase: 03-commit-integrity-convergence-parity
reviewed: 2026-08-05T12:10:00Z
depth: standard
round: 2
files_reviewed: 24
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
  - src/engine/wire-format.ts
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
  critical: 4
  warning: 5
  info: 0
  total: 9
carried_open_from_round_1:
  warning: 11
  info: 3
status: issues_found
---

# Phase 3: Code Review Report (Round 2 — re-review after fixes)

**Reviewed:** 2026-08-05T12:10:00Z
**Depth:** standard
**Files Reviewed:** 24
**Fix range:** `2f8fb1c..86139e2`
**Status:** issues_found

## Round-1 Critical Verdicts

This section is the decision input for whether Phase 3 can close.

| ID | Verdict | One-line basis |
|----|---------|----------------|
| CR-01 | **RESOLVED** | Short-circuit is parent-qualified at `fork-recovery.ts:237-240`; map carries `parentTag` at `:421-432`; regression test asserts no edge hangs off the competing node. |
| CR-02 | **RESOLVED** | `getAppComponents` decode is now converted to a typed violation (`integrity.ts:290-299`) *and* all three replay seams wrap the call defensively. Residual non-throwing-contract leak noted below (WR-15). |
| CR-03 | **RESOLVED** | `selfUpdate` now runs D-05 splice + D-07 depletion (`group-engine.ts:674-681`) and D-01/D-02 legality (`:694`) via helpers shared with `case "commit"`. No other `send()` kind produces a commit. |
| CR-04 | **PARTIAL** | `validateCommitLegality` now runs on the known path, but the MIP-03 **admin-policy callback** is still skipped there while `#treeResolution` re-runs it (CR-11), and the new fail-closed fall-through silently drops our own canonical branch (CR-08). |
| CR-05 | **RESOLVED** | `await this.save(true)` precedes `#realizeRemovalIfNeeded()` (`marmot-group.ts:798-799`); regression test snapshots the state store at marker-write time. |
| CR-06 | **RESOLVED** (gated) | Results now flow `group-engine.ts:1846-1859` → `group-session.ts:382-388` → `marmot-group.ts:542-549`, through the same `#applyRemovalWithdrawal` branch as `ingest()`. Gated end-to-end by CR-10 — the marker store is still unreachable from the public API. |
| CR-07 | **RESOLVED** | Every `winnerChain` link is derived and ledger-recorded (`group-engine.ts:1705-1724`), not just the tip; test asserts both `epochAdvanced` transitions of a 2-link rewind. Introduced a duplicate-record side effect (WR-14). |

**Net:** 6 of 7 round-1 criticals are resolved. **CR-04 is PARTIAL**, and the fix diff (+1249/−244) introduced three further critical-tier defects (CR-08, CR-09, CR-10 — the last a promotion of round-1 WR-01, now load-bearing for CR-05/CR-06). Phase 3 should not close on this HEAD.

**Suite status independently confirmed:** the four phase test files (`convergence-parity`, `send-commit-legality`, `state-notification-withdrawal`, `integration/removed`) run 31/31 green on this HEAD. None of the findings below are caught by an existing test.

---

## Verdict Evidence (detail)

### CR-01 — RESOLVED

`KnownNextState` now carries the recorded parent tag (`src/engine/fork-recovery.ts:57-60`), populated from
`retained.stateAt(sourceEpoch)` at `:425-431`. The DFS consults it only when
`known.parentTag === bytesToHex(state.confirmationTag)` (`:238`), and on mismatch falls through to the ordinary
replay path where a foreign parent cannot process our own commit. The regression test
(`convergence-parity.test.ts`, "does not graft our own canonical commit onto a competing same-epoch fork node")
builds a genuinely 2-deep competing branch and asserts the `edges` array contains no
`parentTag === forkBTag` edge for `ourC2` — it would fail with the digest-only key. Genuine guard, not a
tautology.

### CR-02 — RESOLVED

`validateCommitLegality` wraps `getAppComponents` and returns
`{reason:"component-integrity", detail:"current app_components component did not decode"}`
(`src/core/components/integrity.ts:290-299`). Independently, all three replay seams now catch:
`fork-recovery.ts:252-262` (known path), `:308-317` (replay path), `group-engine.ts:1968-1982`
(`#treeResolution`). The escape route named in round 1 — throw → `explore` → `#buildBranches` → `resolveFork` →
`ingest.ts:811` → out of the generator, skipping `GroupSession.save()` — is closed twice over.

### CR-03 — RESOLVED

`case "selfUpdate"` (`src/engine/group-engine.ts:657-704`) now calls `#adminPolicySpliceFor` (D-05 splice,
D-07 `AdminDepletionError`) and `#assertStagedCommitLegal` (D-01/D-02). Both are shared helpers
(`:734-785`, `:801-816`) that `case "commit"` also calls (`:571-577`, `:632`), and
`#assertStagedCommitLegal` validates against the *by-reference union*
(`Object.values(parentState.unappliedProposals)` ∪ by-value), matching what `createCommit` actually bundles
(`ts-mls/src/createCommit.ts:281-292`, `bundleAllProposals`, unconditional).

The "every other `send()` kind" half of the question checks out: `applicationMessage` uses
`createApplicationMessage` and `proposal` uses `createProposal` (`:477`, `:483` and `:498`) — neither calls
`createCommit`, so neither can bundle unapplied proposals by reference. `commit` and `selfUpdate` are the
complete set of commit-producing seams, and both are now gated. Adjacent parity gaps in *other* dimensions
are CR-09 and WR-17.

### CR-04 — PARTIAL

Resolved half: the known path reads the commit's proposals off the wire
(`framedCommitProposals`, `src/engine/wire-format.ts:83-105`) and runs `validateCommitLegality`
before reusing the recorded state (`fork-recovery.ts:242-262`); a violation `continue`s, creating no edge.

Not resolved: (a) the MIP-03 admin-policy callback is still bypassed on the known path — see **CR-11**; and
(b) the newly-added fail-closed fall-through drops our own canonical branch outright — see **CR-08**.
Criterion 1 ("these three seams behave IDENTICALLY") is therefore still not met.

Note also that the CR-04 regression test in `send-commit-legality.test.ts` is not fully targeted: the violating
commit is authored by `admin2`, so it is replayable from our leaf, and the test would also pass if the known
path's validation were removed and the code merely fell through to `processMessage` + the replay-path
validator. The verdict above rests on code inspection, not on that test.

### CR-05 — RESOLVED

`src/client/group/marmot-group.ts:798-799`: `await this.save(true);` then `await this.#realizeRemovalIfNeeded();`.
A rejected `save()` now aborts before the marker write, and the removal realizes on the next load — the safe
direction. The test (`removed.test.ts`, "persists the tombstone before writing the removal marker") wraps
`setItem` to snapshot the state store at marker-write time and asserts the persisted state deserializes to
`removedFromGroup`; it fails with the old ordering.

### CR-06 — RESOLVED (gated by CR-10)

`reconvergeFromHistory()` collects, dispositions, audits and returns results
(`src/engine/group-engine.ts:1846-1859`); `GroupSession.reconverge()` maps and returns them and still saves
(`src/client/session/group-session.ts:382-388`); `MarmotGroup.reconverge()` routes each through
`#applyRemovalWithdrawal` — the same helper `ingest()` uses (`marmot-group.ts:543-548`, `:821-829`).
`GroupRegistry.load` calls it on the documented load path (`group-registry.ts:183`).

The gate: `removedMarkerStore` is still not plumbed through `GroupRegistry.build` (`group-registry.ts:136-155`)
or `GroupsManagerOptions` (`groups-manager.ts:77-90`), so the marker any real consumer gets is the in-memory
fallback — which is reset by process exit anyway. The precise CR-06 scenario ("removed on a losing fork,
**restarts**, re-converges") therefore cannot be exercised through any public entry point. See CR-10.

### CR-07 — RESOLVED

`#applyForkResolution` iterates `resolution.winnerChain` and derives + `record()`s per link, diffing
`link.parent → link.child` (never `parent → winnerTip`), concatenating into `chainNotifications`
(`src/engine/group-engine.ts:1705-1724`). Withdrawal is computed *before* the new records
(`:1650-1653`), so the ordering is right. The test asserts `epochAdvances === [[1,2],[2,3]]` for a 2-link
rewind — it fails with tip-only derivation. Side effect: WR-14.

---

## Narrative Findings (AI reviewer)

### CR-08: the new fail-closed fall-through silently drops our own canonical branch, handing the rewind to a shallower competitor — BLOCKER

**File:** `src/engine/fork-recovery.ts:237-242`, `src/engine/wire-format.ts:99-102`,
`src/engine/group-engine.ts:819-856`, `src/engine/history-tree.ts:354-380`

**Issue:** The CR-04 fix made the CONV-04 short-circuit conditional on being able to reconstruct the commit's
proposals:

```ts
const knownProposals =
  known && known.parentTag === bytesToHex(state.confirmationTag)
    ? framedCommitProposals(message, state)
    : undefined;
if (known && knownProposals) { /* validate, reuse recorded state */ }
else { /* replay via processMessage */ }
```

`framedCommitProposals` returns `undefined` when a `ProposalRef` names a proposal absent from
`parentState.unappliedProposals` (`wire-format.ts:99-102`). The code comment at `fork-recovery.ts:231-236`
justifies the fall-through only for the `PrivateMessage` case; it does not address the `ProposalRef` case at
all. That case is reachable, and the fall-through is not benign — replaying **our own** commit is exactly what
CONV-04 exists to avoid (RFC 9420: an `UpdatePath` never encrypts a path secret to the committer's own leaf),
so `processMessage` throws, `continue` fires (`:288`), and **our own canonical branch is not built as a
candidate at all**.

Reachability, concretely:

1. Alice calls `MarmotGroup.propose(...)` / `sendProposal(...)`. `GroupRuntime.publishProposal` →
   `confirmPublished({kind:"proposal", newState})`, which for a non-`"commit"` pending only calls
   `#setState` (`group-engine.ts:855`). **Nothing writes the new `unappliedProposals` into the history-tree
   node snapshot** — `recordProposalStaged` is only wired for *inbound* proposals (`ingest.ts:543`).
2. Alice commits. `createCommit` bundles the staged proposal **by reference** (`bundleAllProposals`,
   unconditional). `#recordCommitNode` records the *child* node; `GroupHistoryTree.recordCommit` never
   refreshes the *parent* node's snapshot (`history-tree.ts:360-380`).
3. Restart. `GroupRegistry.#retainedFromTree` rebuilds `RetainedHistoryStore` purely from tree snapshots
   (`group-registry.ts:235-251`), so `retained.stateAt(forkEpoch)` has `unappliedProposals === {}`.
4. A fork arrives at that epoch. `framedCommitProposals` cannot resolve the `ProposalRef` → `undefined` →
   fall-through → own commit replay throws → candidate dropped.
5. `selectCanonicalBranch` (`core/convergence.ts:269-285`) scores only the surviving candidates and does not
   require the winner to beat the current tip; `resolveFork` then reports `outcome: "recovered"` because
   `winnerTip.confirmationTag !== currentState.confirmationTag` (`fork-recovery.ts:452-456`). The engine
   rewinds off its own deeper canonical branch onto the competitor.

Consequence: silent loss of applied local history and divergence from every peer that still has the parent's
proposals — a strictly worse outcome than the pre-fix grandfathering CR-04 was closing.

**Fix:** Do not conflate "cannot reconstruct proposals" with "must replay". Fail closed on the *candidate*,
not on the branch, only when the commit is genuinely re-validatable another way; otherwise close the
underlying snapshot gap so reconstruction always succeeds:

```ts
// group-engine.ts — record own staged proposals into the tree, symmetric with inbound
confirmPublished(pending: PendingState): void {
  if (pending.kind === "proposal") {
    this.#setState(pending.newState);
    this.#recordProposalStaged(pending.newState);   // NEW — mirrors ingest.ts
    return;
  }
  // ...
}
```

and, in `fork-recovery.ts`, treat an unresolvable-`ProposalRef` known commit explicitly (log + drop the
*candidate* with a distinguishable reason, or keep the short-circuit and validate with the proposals
recovered from the child state's transcript) rather than silently routing it into a replay that is
guaranteed to throw. Add a regression test: own proposal → own commit → serialize/reload from the tree →
`resolveFork` must still produce our branch as a candidate.

---

### CR-09: `selfUpdate` commits are never recorded into retained history or the history tree — the persisted fork tree is discarded on the next load — BLOCKER

**File:** `src/engine/group-engine.ts:657-704`, `:819-856`, `src/engine/types.ts:38-45`,
`src/client/runtime/group-runtime.ts:98`, `src/client/group-registry.ts:200-206`

**Issue:** `case "selfUpdate"` returns `pending: { kind: "selfUpdate", newState }` (`group-engine.ts:702`) —
no `parentState`, no `commitMessage` (the `PendingState` shape at `types.ts:38-45` makes both optional and
they are only populated for `kind: "commit"`). `confirmPublished` therefore takes the tail path and only calls
`#setState(pending.newState)` (`:855`). `#recordCommitNode` is never called for a selfUpdate.

A selfUpdate **is** a commit: it advances the epoch and produces a new `confirmationTag`. So after every
selfUpdate:

- `RetainedHistoryStore` has no `stateAt(newEpoch)` and no `appliedCommits` entry for the source epoch, so
  `resolveFork` can never rebuild across a selfUpdate;
- the `GroupHistoryTree` has no node for the new tip, so `#sweepTree`'s
  `this.#tree.path(bytesToHex(this.#state.confirmationTag)) ?? []` is empty
  (`group-engine.ts:1044-1046`) and every pooled app message is classified non-canonical and held silently
  (`:1169-1171`);
- `#reconvergeFromTree` computes `currentTipTag` from a tag the tree does not contain (`:1770-1771`);
- **worst:** on the next load `GroupRegistry.#loadHistory` sees `!tree.hasNode(tipTag)`, logs
  "discarding stale history tree", and returns `undefined` (`group-registry.ts:202-205`) — the entire
  persisted fork history and the rebuilt retained window are thrown away.

`MarmotGroup.selfUpdate()` is public, documented (`docs/client/marmot-group.md:136`), non-admin-callable, and
per MIP-02 is the operation callers are told to run right after joining from a Welcome
(`marmot-client.ts:414`). So on the normal join path, the very first thing a client does destroys its own
convergence persistence.

This predates the fix diff, but `case "selfUpdate"` was rewritten by `2858d1c` under a docstring asserting
that "the two commit-producing seams cannot drift", and it directly defeats CONV-02/CONV-03's persistence
promises, so it is in scope and load-bearing for this phase.

**Fix:** Make `selfUpdate` a first-class commit in the pending contract and record it on confirmation:

```ts
// send(): case "selfUpdate"
return {
  kind: "selfUpdate",
  envelope,
  pending: { kind: "selfUpdate", newState, parentState, commitMessage: commit },
};

// confirmPublished()
if (pending.kind === "commit" || pending.kind === "selfUpdate") {
  // ...existing commit path, including #recordCommitNode
}
```

Add a test that performs a selfUpdate, saves, reloads through `GroupRegistry`, and asserts the history tree
survives (`hasNode(tipTag)`), plus one asserting `retainedStates()` contains the post-selfUpdate epoch.

---

### CR-10: `removedMarkerStore` is still unreachable through the public client API, so CR-05 and CR-06 are inert in production — BLOCKER (promoted from round-1 WR-01)

**File:** `src/client/group-registry.ts:136-155`, `src/client/groups-manager.ts:77-90`, `:216`, `:230`,
`src/client/marmot-client.ts:111`, `:214`, `src/client/group/marmot-group.ts:152`

**Issue:** Unchanged since round 1: `grep -rn removedMarkerStore src` finds it only on `MarmotGroupOptions`,
inside `MarmotGroup`, and in tests. `GroupsManagerOptions` plumbs `store` and `rewindStore` through to both
`GroupRegistry` and `GroupFactory` (`groups-manager.ts:216`, `:230`) and `MarmotClient` forwards
`rewindStore` (`marmot-client.ts:214`) — but neither ever mentions `removedMarkerStore`, and
`GroupRegistry.build` does not pass it (`group-registry.ts:136-155`).

Round 1 rated this a WARNING. It is now critical-tier because **two of the seven critical fixes hang off it**:

- CR-05's ordering guarantee only matters if the marker is durable; without a store, `#realizeRemovalIfNeeded`
  falls back to `#removalRealizedInMemory` (`marmot-group.ts:703-709`), which is reset by process exit — so
  the whole class of bug CR-05 fixed cannot occur *and cannot be fixed*, because realization never survives a
  restart at all.
- CR-06's stated scenario is literally "restarts, and re-converges from disk". Through
  `GroupsManager`/`MarmotClient`, `#clearRemovalMarker()` clears an in-memory boolean that was already `false`
  (`marmot-group.ts:723-729`). The fix is provably unreachable for every real consumer.

The integration test constructs `MarmotGroup` directly (`removed.test.ts:65-72`), so it never exercises the
real wiring. Silent degradation, no error, no warning log.

**Fix:** Add `removedMarkerStore?: GenericKeyValueStore<boolean>` to `GroupsManagerOptions`,
`MarmotClientOptions`, and `GroupRegistryOptions`/`GroupFactoryOptions`; forward it in
`GroupRegistry.build()` alongside `store`/`rewindStore`; add a test that drives a removal +
restart + reconverge through `GroupsManager` rather than a hand-built `MarmotGroup`.

---

### CR-11: the CONV-04 short-circuit still bypasses the MIP-03 admin-policy callback that `#treeResolution` re-runs — BLOCKER (unresolved remainder of CR-04)

**File:** `src/engine/fork-recovery.ts:242-270` vs `src/engine/group-engine.ts:1903-1949`

**Issue:** CR-04's premise is that `ours` comes from `RetainedHistoryStore`, which `GroupRegistry` rebuilds on
load straight from the persisted history tree — the same pre-upgrade edge class `#treeResolution` explicitly
refuses to grandfather. The fix re-runs `validateCommitLegality` on that path, but the known branch still
constructs its result by hand:

```ts
next = { kind: "newState", newState: known.state, actionTaken: "accept", consumed: [], aad: new Uint8Array() };
```

with `actionTaken` hardcoded to `"accept"`. The MIP-03 admin gate — `createAdminCommitPolicyCallback`, which
enforces admin-only commits, the account-identity-proof check on `Add` proposals, and the
admin-cannot-self-remove rule (`admin-policy.ts:38-116`) — is never consulted.

`#treeResolution` does the opposite for the same input class: it replays each link with
`withCapturedProposals(this.#createAdminVerificationCallback())` (`group-engine.ts:1903-1932`) and abandons
the whole chain if `replayed.actionTaken === "reject"` (`:1943-1949`). Two seams, same persisted-edge input,
opposite policies — the exact divergence criterion 1 forbids and CR-04 named.

Concretely: a persisted edge written by a build whose admin set differed (or a pre-MIP-03 build) is replayed
into a winning candidate by `ForkRecovery` and refused by `#treeResolution`, so which seam happens to run
first decides whether the group converges — non-deterministically across peers.

**Fix:** Run the admin callback on the known path too, against the recorded parent, before accepting the
short-circuit. The proposals are already reconstructed by `framedCommitProposals`, so the callback can be
invoked directly on a synthesized `incoming` value; or, at minimum, gate the short-circuit on a flag that is
only set for commits this *process* validated (never for a rehydrated retained store) and fall back to
`#treeResolution`'s replay-and-re-check policy otherwise.

---

## Warnings

### WR-14: a rewind now re-records notifications for already-applied prefix links, duplicating both delivery and withdrawal — WARNING

**File:** `src/engine/group-engine.ts:1650-1653`, `:1705-1724`

**Issue:** `invalidatedByRewind` **keeps** entries whose digest is in `canonicalDigests`
(`state-notifications.ts:219-225`), i.e. every link on the winning chain that was already ledger-recorded when
it was first applied (`ingest.ts:772-776`). The CR-07 loop then `record()`s all of them again (`:1717-1721`),
producing two ledger entries with the same digest and epoch, and pushes their notifications into
`chainNotifications`, which is surfaced to the caller as `processed`/`removed` `notifications`
(`ingest.ts:840`, `:848`).

Reachable whenever the fork root sits below the divergence point — e.g. fork pool carries competing commits at
both epoch `F` and `F+1`: the winner chain is `[F→c1 (already applied inbound), F+1→peer]`, so `c1`'s
notifications are re-recorded and re-reported. A later rewind that supersedes `F+1..` then withdraws each of
`c1`'s notifications twice, breaking CONV-03's "withdraw exactly the notifications it derived" invariant from
the other direction, and compounding WR-02's unbounded-ledger problem.

**Fix:** Skip links already in the ledger, or make `record` idempotent on `(digest, epoch)`:

```ts
record(digest, epoch, notifications) {
  if (notifications.length === 0) return;
  const key = bytesToHex(digest);
  if (this.#entries.some((e) => e.digest === key && e.epoch === epoch)) return;
  this.#entries.push({ digest: key, epoch, notifications });
}
```
and filter `chainNotifications` to links whose digest is not already recorded, so the caller is not told about
a commit it already processed.

---

### WR-15: `deriveStateNotifications` is the one unguarded call site, and it runs *after* state has already advanced — WARNING

**File:** `src/engine/group-engine.ts:1671-1724`, `src/core/components/integrity.ts:309`,
`src/core/group-members.ts:19-27`, `src/core/credential.ts:48-64`

**Issue:** `fork-recovery.ts:252-262`, `:308-317` and `group-engine.ts:1968-1982` all wrap
`validateCommitLegality` with the explicit rationale "a throw escaping here would abandon state already
advanced in the batch before `GroupSession.ingest` can persist it". `#applyForkResolution` violates that same
policy at the one place where the state genuinely *has* already advanced: `this.#setState(resolution.winnerTip)`
runs at `:1671`, and the per-link `deriveStateNotifications(...)` loop at `:1705-1723` is unguarded.

`deriveStateNotifications` calls `getGroupMembers` (`state-notifications.ts:93-94`), which calls
`getCredentialPubkey`, which throws for a basic credential whose identity is not a valid 32-byte hex key
(`credential.ts:49-62`); `getGroupMembers` filters on `credentialType` but not on identity validity
(`group-members.ts:22-24`). `validateCommitLegality` has the same exposure at `integrity.ts:309`, so the
docblock's "non-throwing by design (D-01/D-02)" contract (`integrity.ts:16-26`) is still not literally true.

Reachability is low — `marmotAuthService.validateCredential` gates identities on the inbound path
(`core/auth-service.ts:16-27`) — but a state hydrated from a Welcome or a `ratchet_tree` extension is not
covered by that gate, and the CR-07 fix multiplies the number of derivations per rewind by N.

**Fix:** Wrap the loop the same way its siblings are wrapped, and log-and-continue rather than aborting the
generator mid-rewind:

```ts
let derived: StateNotification[];
try {
  derived = deriveStateNotifications({ parentState: link.parent, resultingState: link.child, commitDigest: linkDigest });
} catch (error) {
  this.#log()("state notification derivation failed for link %s: %o", bytesToHex(link.child.confirmationTag), error);
  continue;
}
```
Additionally, harden `getGroupMembers` to skip (not throw on) an unparseable identity.

---

### WR-16: the removal marker is still cleared without re-checking the tombstone, and `ingest()` / `reconverge()` now disagree about re-asserting realization — WARNING (promoted from round-1 WR-10)

**File:** `src/client/group/marmot-group.ts:821-829`, `:542-549`, `:780-800`

**Issue:** `#applyRemovalWithdrawal` clears the marker on *any* `stateInvalidated` carrying a `selfRemoved`,
with no check that canonical state actually left the tombstone (`:822-828`). The CR-06 fix made this
reachable from two paths that now behave differently:

- `reconverge()` clears, then re-asserts with `await this.#realizeRemovalIfNeeded()` (`:548`);
- `ingest()` clears (`:802`) and never re-asserts.

So a live rewind that supersedes removal-commit A but lands on branch B which *also* removes us leaves
`marker = false` with `groupActiveState.kind === "removedFromGroup"` and no re-emitted `removed`. The next
load then emits a duplicate `removed`, violating the exactly-once contract from the other side. On the
`reconverge()` path the re-assert fires immediately and emits a *second* `removed` in the same process for
what the app sees as one removal.

Two call sites of a helper whose entire purpose is "the live and load-time rewind paths can never diverge"
(`:818-819`) currently diverge.

**Fix:** Guard the clear, and make the two paths symmetric:

```ts
async #applyRemovalWithdrawal(result: DispositionedIngestResult) {
  if (result.kind !== "stateInvalidated" || !result.withdrawn.some((n) => n.kind === "selfRemoved")) return;
  if (this.state.groupActiveState.kind === "removedFromGroup") return; // still removed — nothing to clear
  await this.#clearRemovalMarker();
}
```
and drop the extra `#realizeRemovalIfNeeded()` from `reconverge()` (or add it to `ingest()`), so both paths
run the same sequence.

---

### WR-17: `selfUpdate` still skips the lifecycle gate, the `PendingPublish` transition, and the staged-parent pin that `case "commit"` runs — WARNING

**File:** `src/engine/group-engine.ts:657-704` vs `:521-655`

**Issue:** Parity between the two commit-producing seams was closed for legality/admin-coupling but not for
lifecycle. `case "commit"` checks `mayPrepareLocalCommit(this.#lifecycle)` (`:527-531`), transitions to
`pendingPublish` (`:634-638`), and sets `#stagedCommitParentEpoch` so the parent epoch is pinned against
retained pruning (`:639`). `case "selfUpdate"` does none of these.

Consequently an engine-level `send({kind:"selfUpdate"})` issued while a commit is staged in `PendingPublish`
builds a second commit off the same parent, and whichever `confirmPublished` lands second overwrites the
other's state — a silent fork against the group. The client layer masks it because
`MarmotGroup.submitIntent` gates on `mayReleaseOutbound(status, lifecycle)`, which requires `Stable`
(`core/convergence-status.ts:128-133`), but `MarmotGroupEngine` is a documented public entrypoint
(`./engine` subpath) for callers building their own transport, and the round-1 comment style elsewhere in this
file treats "masked by an incidental guard" as a defect, not a fix.

**Fix:** Hoist the gate and the pending/pin bookkeeping into the shared path both branches call — see CR-09,
which needs the same restructuring.

---

### WR-18: `notifications` semantics widened to whole-chain, but the consuming result types still document per-commit — WARNING

**File:** `src/engine/ingest.ts:61-76`, `:840`, `:848`, `src/engine/types.ts:91-97`,
`src/client/session/group-session.ts:41-42`, `:115-116`

**Issue:** `AppliedForkResolution.notifications` is now explicitly "derived from the WHOLE applied winner
chain … concatenated" (`ingest.ts:61-76`). That value is assigned straight into `ProcessedIngestResult` /
`RemovedIngestResult` at `ingest.ts:840` and `:848`, whose own docs still read "derived from **this** commit"
(`types.ts:92-94`, `group-session.ts:41`, `:115-116`). A consumer that pairs `result.message` with
`result.notifications` — the obvious reading of the type — now attributes an entire multi-commit chain to one
representative fork-pool envelope (`rep.message`, which the code itself notes is "merely the first forkPool
entry"). The per-entry `commitDigest` makes correct attribution *possible*, but nothing in the type says the
caller must regroup.

**Fix:** Update the three docblocks to state the rewind case explicitly, and consider surfacing the rewind's
notifications as their own result variant (symmetric with `stateInvalidated`) rather than piggy-backing them
on a `processed`/`removed` result whose `message` is unrelated.

---

## Round-1 Warning / Info Carry-Forward

One line each, per instructions. Only WR-01 and WR-10 were promoted (to CR-10 and WR-16); the rest are carried
unchanged.

| ID | Status | Note |
|----|--------|------|
| WR-01 | **promoted → CR-10** | Unchanged in code; now load-bearing for CR-05 and CR-06. |
| WR-02 | still-open | `StateNotificationLedger` still has no absolute cap (`state-notifications.ts:193-200`); WR-14 makes it grow faster. |
| WR-03 | still-open | `group-engine.ts:1438-1444` still hardcodes `reason: "admin_policy"` for all three rejection reasons. |
| WR-04 | still-open | `#assertStagedCommitLegal` throws `new UsageError(violation.detail)` (`:815`), discarding `violation.reason`; now on two seams instead of one. |
| WR-05 | still-open | `validateAdminLeafCoupling`'s single `try` still spans both decodes (`integrity.ts:222-236`), mislabelling a current-epoch failure. |
| WR-06 | still-open | `#maybeAutoCommitSelfRemoves` still has no `removedFromGroup` guard (`group-engine.ts:1248-1251`). |
| WR-07 | still-open | `#sweepTree` still runs unconditionally for an evicted group (`group-engine.ts:989`). |
| WR-08 | still-open | `groups-manager.ts` untouched by the fix diff; `seen` still unbounded. |
| WR-09 | still-open | `#realizeRemovalIfNeeded` still check-then-acts across the `await` (`marmot-group.ts:697-702`); CR-06 added a third concurrent caller (`reconverge()`), widening the window. |
| WR-10 | **promoted → WR-16** | Now reachable from two paths that disagree. |
| WR-11 | still-open | Inbound still builds `capture` once before the commit loop (`ingest.ts:605`); pool-replay and tree re-convergence still bind the tip's callback (`group-engine.ts:1581`, `:1904`). |
| WR-12 | still-open | Session/engine `IngestResult` unions still hand-duplicated; `UnreadableIngestResult.decryptFailure` still missing from the session type (`group-session.ts:78-82`). |
| WR-13 | still-open | `bytesEqual` (`integrity.ts:89-96`) and `componentBytesEqual` (`state-notifications.ts:50-57`) still duplicated with divergent bodies. |
| IN-01 | still-open | `ingest-disposition.ts:52` fallthrough + inert eslint directive unchanged. |
| IN-02 | still-open | `groups-manager.test.ts` still asserts `toBeGreaterThanOrEqual(1)`. |
| IN-03 | still-open | `#emitIngestOutcome` still narrows on `kind === "stateInvalidated"` rather than field presence (`group-engine.ts:1416`); audit wiring still deferred. |

---

_Reviewed: 2026-08-05T12:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard (round 2)_
