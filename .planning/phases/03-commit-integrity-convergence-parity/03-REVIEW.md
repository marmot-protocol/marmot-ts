---
phase: 03-commit-integrity-convergence-parity
reviewed: 2026-08-05T15:40:00Z
depth: deep
round: 3
files_reviewed: 33
files_reviewed_list:
  - src/core/components/integrity.ts
  - src/core/components/index.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/inbound.ts
  - src/core/group-members.ts
  - src/core/__tests__/group-members.test.ts
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
  - src/client/session/group-effects.ts
  - src/client/group/marmot-group.ts
  - src/client/groups-manager.ts
  - src/client/group-registry.ts
  - src/client/group-factory.ts
  - src/client/marmot-client.ts
  - src/client/runtime/group-runtime.ts
  - src/__tests__/groups-manager.test.ts
  - src/__tests__/integration/removed.test.ts
  - src/__tests__/integration/own-proposal-snapshot.test.ts
  - src/__tests__/integration/self-update-persistence.test.ts
findings:
  critical: 5
  warning: 18
  info: 7
  total: 30
round_2_verdicts:
  resolved: 5
  partial: 4
  not_resolved: 0
spec_baseline: "refs/marmot (topic-organized); MIP numbering deprecated per refs/marmot/mip-coverage.md"
status: issues_found
---

# Phase 3: Code Review Report (Round 3 — deep)

**Reviewed:** 2026-08-05T15:40:00Z
**Depth:** deep
**Fix range under review:** `848c7e6..HEAD` (8 fix commits)
**Files Reviewed:** 33
**Spec baseline:** `refs/marmot/` (topic-organized). MIP numbering is deprecated;
`refs/marmot/mip-coverage.md` is the authoritative old→new mapping. Citations below use the new
paths, and stale `MIP-NN` citations in phase-3-touched source are filed as **WR-24**.
**Status:** issues_found

## Summary

Round 2's nine findings were all attacked, and five are genuinely closed. Four are
**PARTIAL**: CR-08's root-cause fix is correct but the fall-through it deliberately kept is
still reachable for a self-authored commit through a chained route the fixer's argument does
not cover; CR-11 makes both seams *call* the admin callback but they still disagree on what a
refusal *does*; WR-15 hardened `getGroupMembers` and left its co-caller
`getPubkeyLeafNodeIndexes` throwing one line later in the same loop.

Three new blockers, all cross-seam and all surfaced only by deep depth:

1. **CR-12** — `MarmotGroup.fromClientState` realizes removal (sets the marker, emits
   `removed`) *before* `GroupRegistry.track()` attaches the listener that forwards it. The
   emission goes to a listener-less emitter. CR-10 made the marker durable, so the next load
   returns early and the app is **never** told it was removed. The round-2 test suite documents
   this in a comment and works around it by spying on `EventEmitter.prototype`
   (`removed.test.ts:284-289`). D-12's "exactly once" is "exactly zero" through the public API.
2. **CR-13** — `send({kind:"selfUpdate"})` has **no commit-authorization gate**, and the gate
   `case "commit"` does run scans only the *by-value* proposal set while every peer's inbound
   gate scans the by-reference union `createCommit` actually bundles. Per
   `refs/marmot/protocol-core/group-messaging.md:50-57`, a non-admin self-update Commit that
   updates anything beyond the sender's own LeafNode is **invalid** — so a non-admin
   post-join self-update issued while any foreign proposal is staged builds, publishes and
   locally applies a commit every conformant peer refuses. The client forks itself off the
   group.
3. **CR-14** — found by the "selfUpdate is not a commit" sweep the coordinator asked for,
   generalized: **no locally-authored commit derives or ledger-records state notifications**.
   `deriveStateNotifications` is called from exactly two places (`ingest.ts:735`,
   `group-engine.ts:1816`), neither of which is `confirmPublished`. CONV-03's stated invariant
   — "a rewind that supersedes the commit can withdraw exactly the notifications it derived" —
   therefore does not hold for any commit *we* authored, on either seam.

The 14 round-1 carry-forwards are re-derived below against current code. Two changed
character materially: **WR-06** is now provably unreachable (ts-mls clears
`unappliedProposals` when it sets the tombstone, `processMessages.ts:310-320`) and is demoted
to a defence-in-depth INFO; **WR-07**'s round-1 remedy is now *wrong* — gating `#sweepTree` on
eviction would starve the CONV-03 rewind path that plan 03-07 added, so the gate belongs on
payload *delivery*, not on tree growth. **WR-02** must not be "capped": the project ships
`maxRewindCommits: Infinity` as a supported mode, so the remedy is a horizon-derived bound,
not an arbitrary one — and WR-14's `has()` made `record()` an O(n) linear scan over that
unbounded array.

The suite (78 files / 727 tests) is green. Of the 30 findings below, **zero** are caught by an
existing test.

---

## Round-2 Fix Verdicts

| ID | Verdict | One-line basis |
|----|---------|----------------|
| CR-08 | **PARTIAL** | Root cause fixed (`#recordProposalStaged` now runs for own proposals, `group-engine.ts:403-410`, `:935`), but a self-authored commit still reaches the kept fall-through via a *preceding* link that was replayed rather than short-circuited. |
| CR-09 | **RESOLVED** | `selfUpdate` carries `parentState`+`commitMessage` (`:755-764`); `confirmPublished` merges the two kinds (`:893`); `publishFailed` too (`:945`); test reloads through `GroupRegistry` and asserts `hasNode(tipTag)`. |
| CR-10 | **RESOLVED** (with a new consequence) | Plumbed through all four option types and both construction sites. But making the marker durable turned a lost `removed` emission into a permanent one — see **CR-12**. |
| CR-11 | **PARTIAL** | Both seams now invoke `createAdminCommitPolicyCallback`, but their *rejection* semantics differ (drop-one-edge vs abandon-whole-switch), and the known path skips the `confirmationTag` cross-check `#treeResolution` performs. |
| WR-14 | **RESOLVED** | `record` is idempotent on `(digest, epoch)` (`state-notifications.ts:215-223`) and `chainNotifications` is filtered by `has()` (`group-engine.ts:1800-1830`). Side effect: `record` is now O(n) — see WR-02. |
| WR-15 | **PARTIAL** | Derivation loop is wrapped (`group-engine.ts:1814-1828`) and `getGroupMembers` skips bad identities (`group-members.ts:32-44`), but `getPubkeyLeafNodeIndexes` still throws — see **WR-21**. |
| WR-16 | **RESOLVED** | Clear is gated on leaving the tombstone (`marmot-group.ts:848-853`) and both paths run the identical trailing `#realizeRemovalIfNeeded()` (`:550`, `:816`). Regression test is genuinely failing pre-fix. |
| WR-17 | **RESOLVED** | `mayPrepareLocalCommit` gate (`:693-697`), `pendingPublish` transition + parent pin (`:740-745`), and `GroupRuntime.publishSelfUpdate` rollback (`group-runtime.ts:140-149`). Test asserts the refusal. |
| WR-18 | **RESOLVED** (as scoped) | Doc-only, as declared: all four result docblocks plus the `ingest.ts` assignment site now state the whole-chain semantics. No behaviour change was claimed. |

### CR-08 — PARTIAL

**Resolved half.** `#recordProposalStaged` is now a shared engine method (`group-engine.ts:403-410`)
called from `confirmPublished`'s proposal branch (`:935`), symmetric with the inbound wiring at
`ingest.ts:543`. `own-proposal-snapshot.test.ts` reloads through the real `GroupRegistry` path
and proves `framedCommitProposals` resolves the `ProposalRef` from the reloaded parent snapshot
(`:177-185`). Non-tautological — it fails on the pre-fix source. The live path was never broken:
`RetainedHistoryStore.record` re-sets `#states[parentEpoch] = parentState` on every record
(`retained-store.ts:102`), so the retained parent always carries whatever was staged at commit
time; only the tree-derived restart path was.

**Not resolved: enumerate the `undefined` returns and trace each.**
`framedCommitProposalsWithSender` (`wire-format.ts:117-149`) returns `undefined` in exactly
three places:

1. `:123` — not an `mls_public_message`.
2. `:125` — the public message's content type is not `commit`.
3. `:145` — a `ProposalRef` is absent from `parentState.unappliedProposals`.

The fixer's kept-fall-through argument (`fork-recovery.ts:236-240`) covers (1) and (2) — our
own commits are always `wireAsPublicMessage: true` (`group-engine.ts:631`, `:728`), and an
inbound `PrivateMessage` commit replays fine because we are not its committer. That holds.

It does **not** cover (3) in the chained case, and (3) is what CR-08 was actually about:

- Root at epoch `F`. `ours` = `[B (inbound, source F), C (ours, source F+1)]`.
- `B` reaches the fall-through for reason (1) or (3) — e.g. a peer that wires handshake
  content as `PrivateMessage`, which `wire-format.ts:76-77` itself calls out as possible.
- `B` replays fine: `processMessage(root, B)` → a state whose `unappliedProposals` is `{}`
  (ts-mls clears it on commit, `clientState.ts` `applyProposals`).
- The proposal `P` that was staged onto epoch `F+1` **after** `B` applied is therefore absent
  from that replayed node. `C` bundles `P` by reference.
- At that node, `framedCommitProposalsWithSender(C, replayedState)` hits `:145` → `undefined`
  → fall-through → `processMessage` of **our own** commit throws (RFC 9420) → `continue`
  (`fork-recovery.ts:351-353`) → **our branch is truncated at `F+1`**.
- `#buildBranches` then registers the truncated prefix as a branch candidate
  (`:407-424`, `extended === false`), so `selectCanonicalBranch` scores our chain at depth 1
  instead of 2 and a 2-deep competitor wins. `resolveFork` reports `recovered`
  (`:516-534`) and the engine rewinds off its own deeper canonical branch — CR-08's exact
  symptom, one link further down the chain.

The same mechanism truncates *competing* branches too: `#buildBranches` never re-stages
proposals onto candidate states, so any peer commit that bundles a by-reference proposal
staged above the fork root fails `applyProposals` ("Could not find proposal with supplied
reference") and is silently dropped at `:351-353`. Proposals reaching `candidatesAt`
(`:174-199`) cannot help — they produce an unchanged `confirmationTag`, which is always in
`seen`, so `:385` skips them.

**Fix:** stop treating "cannot reconstruct" as "must replay" for a commit we recorded against
this parent. Either (a) carry the recorded parent state itself into `KnownNextState` (it is in
`retained`, and it *does* have the proposals) and resolve refs against that rather than
against the DFS node's replayed state, or (b) re-stage the parent's `unappliedProposals` onto
the replayed child before descending. Add a regression test with a 2-link own chain whose
first link is forced down the replay path (a `PrivateMessage` inbound commit) and assert
`resolveFork` still yields our 2-deep branch as a candidate.

### CR-09 — RESOLVED

`send()`'s `case "selfUpdate"` now returns `pending: { kind, newState, parentState, commitMessage }`
(`group-engine.ts:755-764`); `confirmPublished` routes both commit kinds through the same
`#recordCommitNode` + audit + `Merging → Stable` path (`:892-926`); `publishFailed` accepts
both (`:945`). `self-update-persistence.test.ts:115-171` drives a real
selfUpdate → save → `GroupRegistry.load` and asserts `tree.hasNode(tipTag)`,
`tree.hasNode(parentTag)`, `tree.rootTag === parentTag`, and that the rebuilt retained window
contains the post-selfUpdate epoch. The pre-fix failure mode (`#loadHistory` discarding the
whole tree at `group-registry.ts:211-214`) is directly asserted against. Genuine.

**Severity claim survives the spec renumbering.** The finding's weight rested on "MIP-02 tells
clients to selfUpdate right after joining". Re-verified against the current spec:
`refs/marmot/protocol-core/joining.md:58` lists "performs a self-update as soon as practical"
as step 13 of the receiving flow, and `:60-64` states a new member "SHOULD perform the
post-join self-update before sending application payloads when feasible, and SHOULD do so
promptly after joining", explicitly noting it "carries forward the MIP-02 post-join rotation
guidance". The behaviour is still normative; only the label was wrong. Correct citation for
`group-engine.ts:711`, `:889`, `marmot-group.ts:556`, `marmot-client.ts:425` and
`self-update-persistence.test.ts:111` is `protocol-core/joining.md` — see **WR-24**.

**Root cause is pre-Phase-3 and shared with WR-17.** `eb3028c` (2026-06-09) added the
`mayPrepareLocalCommit` gate to `case "commit"` and left `selfUpdate()` — ~350 lines below in
the same file — untouched. That is not truncated work; it is one misclassification ("a
selfUpdate is not a commit") that produced both CR-09 (no `parentState`/`commitMessage`, so
never recorded) and WR-17 (no lifecycle gate). The systematic sweep for other instances of the
same misconception is below, and it found two more: **CR-14** and **WR-25**.

**The third, unreviewed change in `cc7bbd6` — `GroupRuntime.publishSelfUpdate`'s rollback —
reviewed on its own merits (`group-runtime.ts:133-154`):**

- It is *required*, not cosmetic: without it a failed publish leaves `PendingPublish`, and
  `mayPrepareLocalCommit` (`group-lifecycle.ts:65-67`) would block every subsequent commit
  forever.
- The `try` correctly wraps only `#publishToGroupRelays`, matching `publishCommit:159-168`.
- `publishFailed` is idempotent and guarded (`group-engine.ts:945-946`): wrong kind → return;
  lifecycle not `PendingPublish` → return. No double-transition is reachable from it.
- **Stranding paths that remain (both shared with `case "commit"`, so not regressions but now
  doubled):** `#confirmPublished` is *outside* the `try`. It transitions
  `PendingPublish → Merging`, then `#setState` → `onStateChanged` → `MarmotGroup` emits
  `stateChanged` to arbitrary app listeners (`marmot-group.ts:445`). A throwing listener leaves
  the engine permanently in `Merging`, from which the only legal exit is `Stable`
  (`group-lifecycle.ts:38`) and no code path takes it. Likewise `await this.#save()` after
  `confirmPublished` rejects with state advanced in memory but unpersisted. Neither is rolled
  back. Recorded as **WR-22** together with the pre-wrap variant.
- Rollback does **not** need to undo tree/retained recording: `#recordCommitNode` only runs
  inside `confirmPublished`, i.e. after the publish succeeded. Verified — the asymmetry the
  round-3 brief asked about does not exist.

### CR-10 — RESOLVED (and it exposed CR-12)

`removedMarkerStore` is now on `MarmotClientOptions:121`, `GroupsManagerOptions:97`,
`GroupRegistryOptions:45`, `GroupFactoryOptions:39`, and is forwarded at
`marmot-client.ts:225`, `groups-manager.ts:227` and `:242`, `group-registry.ts:152`,
`group-factory.ts:144`. Both construction sites (load via `GroupRegistry.build`, create via
`GroupFactory.create`) are covered, and `GroupsManager.adoptClientState` goes through
`#registry.build` (`groups-manager.ts:576`) so import/join inherit it too. No partially-wired
site found. `removed.test.ts:405-...` drives the whole thing through two `GroupsManager`
instances over shared stores.

This is the right fix — but see **CR-12**: it converts a lost `removed` emission into a
permanently lost one.

### CR-11 — PARTIAL

**Resolved half.** `framedCommitProposalsWithSender` (`wire-format.ts:117-149`) reproduces
`applyProposals`' `allProposals` faithfully — I checked it line-for-line against
`ts-mls/src/clientState.ts:864-881`: by-value entries take the committer's leaf, `ProposalRef`
entries carry the staged `ProposalWithSender` verbatim, and `senderLeafIndex` is
`content.sender.senderType === member ? leafIndex : undefined`, matching
`processMessages.ts:288-289`. The known path invokes the callback on that synthesized
`incoming` (`fork-recovery.ts:288-305`), treats a throw as a refusal, and the regression test
uses a commit authored by our own leaf so the short-circuit is the only route to an edge —
the targeting weakness round 2 flagged in the CR-04 test is genuinely fixed.
`IncomingMessageAction` is `"accept" | "reject"` only (`ts-mls/src/incomingMessageAction.ts:5`),
so the `=== "reject"` check is exhaustive.

**Not resolved — the two seams still do not agree on what a refusal means:**

1. **Granularity.** `#treeResolution` abandons the *entire* winner chain on `reject`, on a
   replay throw, or on a legality violation (`group-engine.ts:2041-2099`, four `return undefined`
   sites) — the current tip stays put. The known path `continue`s (`fork-recovery.ts:296`,
   `:304`, `:324`, `:326`), dropping one edge; `#buildBranches` then registers the truncated
   prefix as a candidate (`:407-424`) which can still **win** and force a rewind. Same
   persisted-edge input, opposite outcomes: `#treeResolution` keeps our tip, `ForkRecovery`
   rewinds off it. That is criterion 1's exact failure mode, unchanged.
2. **No child cross-check.** `#treeResolution` verifies the replayed child's
   `confirmationTag` equals the stored snapshot's (`group-engine.ts:2059-2068`) — proof that
   the stored edge is internally consistent. The known path never checks that `known.state` is
   what `message` produces from `state`; it trusts `retained` on the strength of
   `known.parentTag` alone (`fork-recovery.ts:241-243`). Consistent by construction today
   (`group-registry.ts:256-260`), but the fail-closed policy the seam claims is not enforced.
3. **Callback state binding.** Both seams bind the callback to the *current tip*
   (`group-engine.ts:1659`, `:2011-2012`), so they agree with each other and both disagree with
   the per-node binding `#sweepTree` uses (`:1215`). CR-11 therefore adds a **third** consumer
   of the tip-bound callback, and it is now an accept/reject decision input on the CONV-04
   path — see WR-11.

**Fix:** give both seams one shared "re-validate a persisted link" helper that takes
`(parent, message, child)` and returns `accept | reject | unverifiable`, and make the DFS treat
`unverifiable` as "this candidate contributes no edge **and** the prefix is not registered as a
branch tip" so a refused link cannot promote a truncated branch.

### WR-14 / WR-15 / WR-16 — interaction check

These three touch overlapping code in `#applyForkResolution` and `#applyRemovalWithdrawal`. I
traced the combined path:

- `alreadyRecorded` is sampled **before** `record()` (`group-engine.ts:1800-1803`, `:1829`) and
  after `invalidatedByRewind` (`:1728`), which keeps canonical-digest entries
  (`state-notifications.ts:243`). Ordering is correct — the prefix filter sees the pre-rewind
  ledger, not the one it is about to write.
- WR-15's `continue` on a derivation throw (`group-engine.ts:1827`) skips `record()` for that
  link. That is the right direction (nothing recorded, so nothing double-withdrawn), but it
  also leaves the link's notifications permanently non-withdrawable — the same invariant CR-07
  was raised to fix, now reachable through a different door. Low severity because the throw is
  itself now hard to trigger; noted, not filed separately.
- WR-16's tombstone gate (`marmot-group.ts:848-853`) runs per result; the trailing
  `#realizeRemovalIfNeeded()` runs once after the loop on both paths (`:816`, `:550`). I
  verified the ordering guarantee CR-05 established survives: `GroupSession.ingest`'s trailing
  `await this.save()` (`group-session.ts:586`) executes when the consumer's `for await` requests
  the value after the last yield, i.e. **before** `MarmotGroup.ingest` reaches `:816`. So the
  trailing realization never writes the marker ahead of the state. Good.
- No conflict found between the three. The genuine leftovers are WR-21 (WR-15's sibling
  function) and CR-12 (an ordering problem WR-16 does not address because it is on the load
  path, not the rewind path).

---

## The "a selfUpdate is not a commit" sweep

Per the coordinator's correction, CR-09 and WR-17 are one misclassification introduced by
`eb3028c`, not two independent bugs. I swept every site that special-cases commits and could be
reached by a selfUpdate (or by any locally-authored commit) without naming it. Method: enumerate
every branch on `PendingState["kind"]`, `SendIntent["kind"]`, `SendResult["kind"]`,
`GroupPublishWork["kind"]` and `GroupSessionSendIntent["kind"]` across `src/`, then check each
commit-only side effect against both send seams and against the inbound seam.

| Concern | Site | Verdict |
|---|---|---|
| Lifecycle gate | `group-engine.ts:554`, `:693` | ✅ both |
| `PendingPublish` transition | `:661`, `:740` | ✅ both |
| Retained-history parent pin | `:666`, `:745` | ✅ both |
| `confirmPublished` recording | `:893` (`"commit" \| "selfUpdate"`) | ✅ both |
| `publishFailed` rollback | `:945` | ✅ both |
| Tree recording (`#recordCommitNode`) | `:908` | ✅ both (via the merge) |
| Own-echo dedup (`#sentContentIds`) | `:667`, `:747` | ✅ both |
| Audit `epoch_confirmed` / `epoch_rolled_back` | `:913`, `:949` | ✅ both |
| Audit `artifact_kind` | `:1557` (`groupEvolution \|\| selfUpdate → "commit"`) | ✅ both |
| Audit `intent_kind` / `result_kind` | `:2184-2207` | ✅ intentionally distinct |
| Runtime publish dispatch | `group-runtime.ts:93-108` | ✅ both |
| D-05 splice / D-07 depletion | `:598`, `:715` | ✅ both |
| D-01/D-02 legality | `:659`, `:733` | ✅ both |
| Wire format (`PublicMessage`) | `:631`, `:728` | ✅ both |
| Inbound classification (`framedContentType === commit`) | `ingest.ts:493`, `group-engine.ts:1203`, `:1274` | ✅ content-type based, seam-agnostic |
| `admin-policy.ts:164` (`incoming.kind`) | ts-mls inbound union | ✅ not an instance |
| **Commit-authorization gate** | `:614-628` only | ❌ **CR-13** |
| **State-notification derivation + ledger record** | `ingest.ts:735`, `group-engine.ts:1816` only | ❌ **CR-14** |
| **`historyChanged` emission** | `marmot-group.ts:755`, `:818` (ingest only) | ❌ **WR-25** |
| Delivered-payload ledger for own app messages | `ingest.ts:572` only | ❌ noted under CR-14 |
| `GroupPublishWork` union | `group-effects.ts:13` vs `:14-21` | ❌ noted under CR-14 |

Two of the three misses are the same shape as CR-09: a *commit-only* side effect wired on the
inbound seam and never on the local seam. The third (CR-13) is the seam-parity gap CR-03's
round-1 fix created by adding the splice without adding the gate.

---

## Carry-Forward Re-Derivation (round 1, now in scope)

Each verdict is derived from current code, not carried by ID.

### WR-02: notification/payload ledgers are unbounded, and `record` is now O(n) — WARNING (still open, character changed)

**File:** `src/engine/state-notifications.ts:177-261` (`has:198-201`, `record:215-223`),
`src/engine/delivered-payloads.ts:37-80`, prune sites `src/engine/group-engine.ts:1593-1600`,
`:1834-1838`

**Current state:** unchanged in substance. The only bound is `pruneBelow(anchorEpoch())`. Under
`maxRewindCommits: Infinity` — supported and documented on `MarmotGroupEngineOptions:174-177`,
`MarmotGroupOptions:163-168`, `GroupsManagerOptions:118-123` and `MarmotClientOptions:122-129` —
`prunableRetainedEpochs` computes `floor = max(0, tip - Infinity) = 0`, `RetainedHistoryStore`
never prunes (`retained-store.ts:106-121`), `anchorEpoch()` stays pinned at the initial epoch,
and `pruneBelow` is a permanent no-op. The class doc's "bounded to the rollback horizon"
(`state-notifications.ts:172-175`) is false in that configuration.

**What changed:** WR-14 added `has()` (`:198-201`), a linear `some()` over `#entries`, and
`record()` now calls it on every commit (`:221`). Under Infinity that is O(n) per commit over an
array that never shrinks. WR-14 removed the duplicate-growth accelerant but added a per-record
scan across the same unbounded structure. CR-14's fix will add one `record()` per *local* commit
too, roughly doubling the rate.

**Fix (not "cap it" — the project wants infinite rewind):**
1. Index by digest: `#entries` → `Map<string, {epoch, notifications}[]>` keyed on
   `bytesToHex(digest)`, so `has`/`record`/`invalidatedByRewind` stop scanning.
2. Bound by *what a rewind can actually reach*, not by an arbitrary count: the fork-history
   tree is the persisted source and is itself bounded by its own retention. Prune to
   `min(anchorEpoch, oldest epoch still present as a tree node)` rather than `anchorEpoch`
   alone, so Infinity-rewind groups still shed notifications for epochs no candidate branch
   can name.
3. If a hard ceiling is wanted as a backstop, spill to the `rewindStore` (the ledger is
   digest-keyed and trivially serializable) rather than dropping entries — dropping silently
   breaks CONV-03's withdrawal invariant, which is the whole point of the ledger.

Apply the same treatment to `DeliveredPayloadLedger`, which has the identical shape.

### WR-03: the audit log still records all three rejection reasons as `admin_policy` — WARNING (still open)

**File:** `src/engine/group-engine.ts:1523-1529`

`RejectedIngestResult.reason` is a three-value union (`types.ts:128`) and `ingest.ts:693`/`:722`
populate it correctly, but the audit emit hardcodes `reason: "admin_policy"`. The WIRE-03/CONV-01
rejections this phase added are invisible in the one artifact a post-incident investigator reads.

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

### WR-04: the send seam discards `violation.reason` — WARNING (still open, now on two seams)

**File:** `src/engine/group-engine.ts:871-876`

`#assertStagedCommitLegal` throws `new UsageError(violation.detail)`, dropping `reason` —
which `integrity.ts:36-38` explicitly designates as the protocol-visible signal, with `detail`
free to change. Callers wanting to distinguish `component-integrity` from
`admin-leaf-coupling` must string-match. Inconsistent with the sibling `AdminDepletionError`
(`:127-134`) in the same file. Round 1 saw one call site; CR-03 made it two (`:659`, `:733`).

**Fix:** add `export class CommitLegalityError extends Error { constructor(readonly violation: CommitIntegrityViolation) { super(violation.detail); this.name = "CommitLegalityError"; } }`
and throw it; export from `src/engine/index.ts` alongside `AdminDepletionError`.

### WR-05: a current-epoch admin-policy decode failure is blamed on the resulting epoch — WARNING (still open)

**File:** `src/core/components/integrity.ts:222-236`

The single `try` still spans both `getAdminPolicy(args.resultingExtensions)` (`:224`) and the
carried-forward `getAdminPolicy(args.currentExtensions)` (`:228`). A malformed *inherited*
policy yields `detail: "resulting admin-policy component did not decode"` and rejects a commit
that never touched admin policy — then rejects every subsequent commit the same way, wedging the
group with a diagnostic pointing at the wrong epoch. This is now the only remaining un-split
decode: `validateCommitLegality` already split out `getAppComponents` (`:290-299`) under CR-02.

**Fix:** split the two `try` blocks so the detail names the correct side
(`"carried-forward admin-policy component did not decode"`), exactly as CR-02 did for
`app_components`.

### WR-06: `#maybeAutoCommitSelfRemoves` has no `removedFromGroup` guard — **demoted to INFO (IN-04)**

**File:** `src/engine/group-engine.ts:1333-1340`, `:468-472`

Round 1's reachability argument is **disproven** by current code. The guard is still absent, but
`ts-mls/src/processMessages.ts:310-320` sets `unappliedProposals: {}` in the same object literal
that sets `groupActiveState: {kind:"removedFromGroup"}`, for both an admin `Remove` and a
`self_remove` (`clientState.ts:968` derives `selfRemoved` from our own leaf being blanked,
covering both). Every route to the tombstone — inbound apply, replay, tree-snapshot round-trip —
therefore carries an empty proposal set, so `unapplied.length === 0` returns at `:1340` before
the D-14 throw at `:468` can be reached. Filed as **IN-04** (defence in depth).

### WR-07: `#sweepTree` still decrypts and delivers for an evicted group — WARNING (still open, **remedy revised**)

**File:** `src/engine/group-engine.ts:1074`, `:1125-1182`, `:1239-1256`, `:1099-1112`

`ingestEnvelopes`' D-13 short-circuit (`ingest.ts:336-345`) stops *fresh* input, but
`#ingestWithPool` continues past it: `#sweepTree` peels, decrypts, `processMessage`s and can
`yield {kind:"processed"}` an application message (`:1254-1255`) for a group we have been
evicted from — the input `refs/marmot/protocol-core/member-departure.md` says "need not be
decrypted or authenticated". `evictStale` (`:1099`) also still yields `unreadable`.

**Round 1's remedy is now wrong.** Gating `#sweepTree` on eviction would starve plan 03-07's
CONV-03 path: the deliberate asymmetry documented at `:1082-1089` requires fork material to be
*grown into the tree* while removed, so `#reconvergeFromTree` can later supersede the removing
commit and clear the marker. Suppressing the sweep suppresses that growth.

**Fix:** gate *delivery*, not traversal. In `#sweepResult`, when
`this.#state.groupActiveState.kind === "removedFromGroup"`, keep the commit branch
(`:1226-1236`, which grows the tree) and return `undefined` from the `applicationMessage`
branch (`:1239-1256`) so nothing is delivered. Add a test that a pooled app message is not
`processed` after removal but a pooled commit still lands in the tree.

### WR-08: the `seen` dedup Set is unbounded and attacker-growable — WARNING (still open)

**File:** `src/client/groups-manager.ts:508`, `:509-540`

Unchanged. `seen` is a plain `Set<string>` scoped to the subscription's lifetime. The `h`
routing tag is public (it is the relay filter, `:496`), so any keypair can sign a valid kind-445
event carrying it; that event passes both trust gates (`:519`, `:523`), is added to `seen`
permanently (`:527`), **and** is handed to `group.ingest()` (`:533`). Memory grows with attacker
traffic, not with group traffic. The engine-side sets are not equivalently exposed:
`#seenContentIds` only grows via `ctx.dedup.remember`, which is reached only for messages that
actually decrypted and reached a terminal apply (`ingest.ts:687`, `:716`, `:751`, `:777`), and
the `IngestionPool` is explicitly bounded.

The second half also stands: with `rejectedEvents` removed, a redelivered invalid-signature
event costs a fresh secp256k1 verification and a fresh `rejected` emission per delivery,
because `fresh` filters on `seen` only (`:510`).

**Fix:** replace `seen` with a bounded ring/LRU of ids (a `Set` plus an insertion-ordered array,
evicting oldest past ~10k). If repeated `rejected` emissions matter, bound a rejected-**id**
cache the same way — ids, not the event objects the removed `rejectedEvents` held. Optionally
cross-check the `h` tag value against the subscribed group id before `seen.add`, which closes
the amplification at its source (currently declared out of scope at `:515-516`).

### WR-09: `#realizeRemovalIfNeeded` check-then-act across an `await` — WARNING (still open, window widened again)

**File:** `src/client/group/marmot-group.ts:696-715` (race at `:699-704`)

```ts
const alreadyRealized = await this.#removedMarkerStore.getItem(this.idStr);
if (alreadyRealized) return;
await this.#removedMarkerStore.setItem(this.idStr, true);
```

Two concurrent invocations can both observe `false` and both emit `removed` + reject queued
outbound. The contract is "exactly once" (`:685-694`). Call sites are now **four**:
`fromClientState:510`, `ingest`'s removed branch `:801`, `ingest`'s trailing re-assert `:816`
(WR-16), and `reconverge`'s trailing re-assert `:550` (WR-16). The two `ingest` ones are
sequential within one flow, but `GroupRegistry.load`'s `fromClientState` + `reconverge`
(`group-registry.ts:186`, `:192`) can interleave with a `connectAll` drain on an
already-tracked instance.

**Fix:** collapse onto a single in-flight promise:
```ts
#realizing?: Promise<void>;
#realizeRemovalIfNeeded(): Promise<void> {
  return (this.#realizing ??= this.#realizeInner().finally(() => { this.#realizing = undefined; }));
}
```

### WR-10 → folded into WR-16 — **RESOLVED**

The tombstone re-check landed at `marmot-group.ts:848-853` and both rewind paths now run the
identical sequence. Nothing left open.

### WR-11: the seams bind the admin callback to four different states — WARNING (still open, aggravated)

**Files:** `src/engine/ingest.ts:605`; `src/engine/group-engine.ts:1659`, `:2011-2012`,
`:1215`, `:2128`; consumed at `src/engine/fork-recovery.ts:163`, `:290`

Unchanged, and CR-11 added a consumer:

| Seam | Binding | Applied to |
|------|---------|-----------|
| inbound | `ctx.createAdminCallback()` built **once before the commit loop** (`ingest.ts:605`) | every commit in the batch, including ones after an admin-set change |
| pool-replay DFS | tip-bound (`group-engine.ts:1659`) | arbitrary earlier-epoch DFS nodes |
| **CONV-04 short-circuit (new)** | the same tip-bound value, invoked directly (`fork-recovery.ts:290`) | a recorded parent at an arbitrary epoch — now an **accept/reject decision** |
| tree re-convergence | tip-bound (`group-engine.ts:2011-2012`) | every `link.parent` on a persisted chain |
| tree witnesses | tip-bound (`:2128`) | every node on every candidate path |
| sweep | per-node (`:1215`) | correct |

Beyond the admin-set drift round 1 named, the CR-11 site has a sharper failure:
`createAdminCommitPolicyCallback` resolves `senderLeafIndex` and every self_remove proposer's
leaf against `state.ratchetTree` from the **tip** (`admin-policy.ts:63-70`, `:85-89`). MLS
reuses blanked leaf slots, so a leaf index recorded at epoch `N` can name a different account
at the tip — and that resolution now decides whether our own canonical branch survives fork
recovery.

**Fix:** add `createAdminCallbackFor(state)` to `IngestContext`, rebuild it per commit in
`ingest.ts`'s loop, and thread the DFS node's `state` / `link.parent` into
`#buildBranches`/`#treeResolution`/the CR-11 known-path invocation.

### WR-12: session and engine result unions are hand-duplicated and still diverge — WARNING (still open)

**File:** `src/client/session/group-session.ts:36-158` vs `src/engine/types.ts:93-289`

Unchanged. `UnreadableIngestResult` (`group-session.ts:87-91`) still omits `decryptFailure`,
which the engine variant carries (`types.ts:166`) and which `mapEngineIngestResult` spreads
through verbatim (`:244-245`) — the runtime value carries a field the public type denies.
`ProcessedIngestResult`/`RejectedIngestResult`/etc. still use inline `import("ts-mls")` types
instead of the shared imports at the top of the file. This round added `notifications`
docblocks to both copies (`e90fcff`), so the duplication cost is now paid in prose too.

**Fix:**
```ts
type Renamed<T> = T extends { envelope: NostrEvent } ? Omit<T, "envelope"> & { event: NostrEvent } : T;
export type IngestResult = Renamed<EngineIngestResult<NostrEvent>>;
```
then derive each named alias with `Extract<IngestResult, {kind: "..."}>` so a new engine field
cannot be forgotten here.

### WR-13: duplicate byte-equality predicates with divergent bodies — WARNING (still open)

**File:** `src/core/components/integrity.ts:89-96` vs `src/engine/state-notifications.ts:50-57`

Unchanged. `bytesEqual` still carries `&& a.length === b.length`, which is dead:
`compareBytes` already returns `a.length - b.length` when the common prefix matches
(`src/core/components/bytes.ts:9`). Both predicates are consumed by code that must agree —
`validateAppComponentIntegrity`'s Rule 3 (`integrity.ts:171`, `:174`) and
`deriveStateNotifications`' component diff (`state-notifications.ts:122`). A fix applied to one
would silently desynchronise commit-legality from notification derivation.

**Fix:** export one `bytesEqual(a?: Uint8Array, b?: Uint8Array)` from
`src/core/components/bytes.ts`, import it in both, drop the redundant length comparison.

### IN-01: fallthrough plus an inert eslint directive — INFO (still open)

**File:** `src/engine/ingest-disposition.ts:36-55`

Unchanged. The `skipped` case relies on its inner switch being exhaustive so control never
reaches `// eslint-disable-next-line no-fallthrough` at `:52` and drops into `case "unreadable"`.
`noFallthroughCasesInSwitch` makes it compile-safe today, but the directive is inert — there is
no root ESLint config (only `ts-mls/eslint.config.mjs`).

**Fix:** give the inner switch `default: { const _never: never = result.reason; return _never; }`
and delete the comment.

### IN-02: trust-boundary assertions relaxed to `>= 1` — INFO (still open)

**File:** `src/__tests__/groups-manager.test.ts:202`, `:245`, `:318`

All three are still `expect(rejections.length).toBeGreaterThanOrEqual(1)`. The relaxation is
justified by the `rejectedEvents` removal, but it now also passes if a regression emits hundreds
of `rejected` events per delivery — which is precisely WR-08's second half.

**Fix:** assert the exact count for each fixture (2 for the backfill+subscribe redelivery case,
1 elsewhere).

### IN-03: `#emitIngestOutcome` narrows on kind, not field presence; no audit for withdrawals — INFO (still open)

**File:** `src/engine/group-engine.ts:1497-1530`

Unchanged. The early return at `:1501` guards `this.peeler.idOf(result.envelope)` at `:1502`
against the one generic-free variant, enforced by a comment rather than the type. Audit wiring
for `stateInvalidated` is still explicitly deferred (`:1498-1500`), so CONV-03's rewind
withdrawals — the phase's headline capability — produce no forensic record at all, on either
rewind path.

**Fix:** narrow structurally (`if (!("envelope" in result)) return;`) and file the withdrawal
audit event as a tracked item; the data needed (`commitDigest`, `forkEpoch`, withdrawn kinds) is
already on the result.

---

## New Findings

### CR-12: load-time removal realization emits `removed` before any listener is attached — and CR-10's durable marker makes the loss permanent — BLOCKER

**File:** `src/client/group/marmot-group.ts:503-512` (`:510`), `:696-715` (`:703`, `:714`),
`src/client/group-registry.ts:186`, `:265-279` (`:274-275`), `:328-340`

**Issue:** `MarmotGroup.fromClientState` calls `await group.#realizeRemovalIfNeeded()` at
`:510`, *inside the static factory, before the instance is returned*. That call writes the
marker (`:704`) and emits `removed` (`:714`). The listener that forwards the event to the
application is attached later, in `GroupRegistry.track()` (`group-registry.ts:274-275`), which
only runs after `load()` resolves (`:328-331`). The emission therefore goes to an emitter with
zero listeners and is discarded.

Before CR-10 this leaked once per process: the in-memory fallback (`marmot-group.ts:709-710`)
was reset by process exit, so every restart re-attempted the (still lost) emission. With CR-10
the marker is persisted, so `#realizeRemovalIfNeeded` returns at `:703` on **every** subsequent
load. Net effect for any consumer of `GroupsManager` / `MarmotClient`: a client that was
removed while offline (or that crashed between commit-apply and notification —
`refs/marmot/protocol-core/member-departure.md`'s "Realizing removal" scenario, quoted at
`:507-509`) is **never** told. `GroupsManagerEvents.removed` never fires, `connectAll`'s
`disconnect` handler (`groups-manager.ts:454`) never runs, and `#rejectQueuedOutbound` (`:713`)
fires against an empty queue on an instance nobody holds yet.

The round-2 test suite documents the defect without recognising it:
`src/__tests__/integration/removed.test.ts:284-289` — *"`fromClientState` realizes internally
(before returning), so a listener attached to the returned instance can never observe that
internal emission — spy on the shared EventEmitter prototype instead"*. Both marker tests
(`:286`, `:443`) rely on that prototype spy, which is why they pass while the public API is
broken.

**Fix:** make realization a post-construction step the loader drives, so it lands after
listeners exist:

```ts
// marmot-group.ts — construct only; do not realize
static async fromClientState(...) {
  return new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
}
/** Public, idempotent: the loader calls this once listeners are attached. */
async realizeRemovalIfPending(): Promise<void> { await this.#realizeRemovalIfNeeded(); }

// group-registry.ts — in get(), after track()
const loadPromise = this.load(groupId).then(async (loaded) => {
  this.track(loaded);          // attaches the `removed` forwarder
  this.emit("loaded", loaded);
  await loaded.realizeRemovalIfPending();
  return loaded;
});
```
`GroupsManager.adoptClientState` (`groups-manager.ts:576-583`) needs the same ordering. Add a
test that constructs a tombstone through `GroupsManager.get()` and asserts the **manager**
emits `removed` — with no prototype spy.

---

### CR-13: neither send seam runs the commit-authorization gate over the proposal set `createCommit` actually bundles; `selfUpdate` runs no gate at all — BLOCKER

**File:** `src/engine/group-engine.ts:684-765` (no gate) vs `:614-628` (by-value-only gate),
`:713-719` (the splice), `:800-803` and `:867-870` (the by-reference union its siblings *do*
use), `src/engine/admin-policy.ts:91-109`, `src/client/group/marmot-group.ts:561-568`

**Spec:** `refs/marmot/protocol-core/group-messaging.md:48-57` — "Non-admin members can commit
only the narrow flows that the spec explicitly allows: a self-update Commit that updates only
the sender's own LeafNode; a dedicated SelfRemove-only Commit… Those two non-admin commit
shapes MUST NOT be combined with each other or with other proposal types. All other Commits
from non-admins are invalid."

**Issue, two layers:**

1. **`case "selfUpdate"` has no gate at all.** `case "commit"` refuses a non-admin commit
   unless every by-value proposal is an `Update` or every one is a `self_remove` (`:614-628`).
   `case "selfUpdate"` runs the D-05 splice (`:713-719`), the D-07 depletion guard, the
   D-01/D-02 legality check (`:733`) and now the lifecycle gate (`:693-697`) — and nothing else.
2. **Both send-path gates scan the wrong set.** `case "commit"`'s gate reads `allProposals`,
   which is only `newProposals ∪ selectedProposals ∪ splice` (`:590`, `:604`) — the *by-value*
   set. Every peer's inbound gate reads `incoming.proposals`, which ts-mls builds as
   `allProposals` = by-value **∪ by-reference** (`ts-mls/src/clientState.ts:864-881`, handed to
   the callback at `processMessages.ts:304`). The two siblings in the same file get this right:
   `#adminPolicySpliceFor` (`:800-803`) and `#assertStagedCommitLegal` (`:867-870`) both scan
   `Object.values(state.unappliedProposals) ∪ byValueProposals` precisely because
   "`createCommit` bundles every unapplied proposal by reference" (`:777-781`). The admin gate
   does not.

**Reachable failure (the post-join path the spec names):**

1. An admin publishes a standalone `Remove` proposal. Every member stages it
   (`ingest.ts:536-545`).
2. A **non-admin** member calls `MarmotGroup.selfUpdate()` — which
   `refs/marmot/protocol-core/joining.md:58,60-64` tells it to do promptly after joining.
3. `createCommit` bundles the admin's `Remove` by reference. If it de-leafs an admin account,
   `#adminPolicySpliceFor` also splices an `AppDataUpdate` by value (`:838-845`).
4. `#assertStagedCommitLegal` passes — the dictionary change *is* backed by the commit's own op,
   which is the splice's whole purpose.
5. The commit is wrapped, published, and applied locally on `confirmPublished` (`:892-926`).
6. Every peer runs `createAdminCommitPolicyCallback`: sender not an admin (`admin-policy.ts:91`),
   `incoming.proposals.length !== 0` (`:93`), not `isSelfUpdateOnly` (a `Remove`/`AppDataUpdate`
   is present), not `isSelfRemoveOnly` → **`"reject"`** (`:109`).

We are at epoch `N+1`; every peer is at `N`. We have forked ourselves off the group with a
commit our own inbound seam would reject — the "a guard that exists on one seam only" class the
phase set out to close, produced by CR-03's round-1 fix adding the splice without the gate.

Routing the same intent as `{kind:"commit"}` fares little better: the by-value gate sees only
the splice, refuses, and the *legitimate* self-update is blocked — divergent outcomes for
identical group state depending on which intent kind the caller chose.

**Fix:** one shared gate, run over the by-reference union, called by both seams. Switching to
the union does **not** break the auto-committer: `#maybeAutoCommitSelfRemoves` only proceeds
when `unapplied.every(isSelfRemoveProposal)` (`:1346`), so the union is self_remove-only and
`selfRemoveOnly` still passes.

```ts
#assertCommitActorAllowed(state: ClientState, adminPubkeys: readonly string[],
                          actorPubkey: string, byValueProposals: readonly Proposal[]): void {
  if (adminPubkeys.includes(actorPubkey)) return;
  const all = [
    ...Object.values(state.unappliedProposals).map((p) => p.proposal),
    ...byValueProposals,
  ];
  const selfUpdateOnly = all.every((p) => p.proposalType === defaultProposalTypes.update);
  const selfRemoveOnly =
    all.length > 0 && all.every((p) => p.proposalType === selfRemoveProposalType);
  if (!selfUpdateOnly && !selfRemoveOnly)
    throw new Error(
      "Not a group admin. Non-admins may only commit a self-update-only or self_remove-only commit.",
    );
}
```
`case "selfUpdate"` has no `actorPubkey`, which is itself part of the misclassification: resolve
it from
`getCredentialPubkey(getCredentialFromLeafIndex(state.ratchetTree, state.privatePath.leafIndex))`,
or add `actorPubkey` to the `selfUpdate` intent for symmetry with `commit`. Regression tests:
(a) stage an admin `Remove`, call `selfUpdate()` as a non-admin, assert it throws and nothing is
published; (b) stage a foreign `Add`, call `commit()` as a non-admin with no by-value proposals,
assert it throws — it currently succeeds.

---

### CR-14: no locally-authored commit derives or ledger-records state notifications, so CONV-03's withdrawal invariant does not hold for our own commits — BLOCKER

**File:** `src/engine/group-engine.ts:892-936` (`confirmPublished` — no derivation),
vs `src/engine/ingest.ts:732-776` (inbound) and `src/engine/group-engine.ts:1784-1832` (rewind);
ledger at `src/engine/state-notifications.ts:177-261`

**Issue:** `deriveStateNotifications` has exactly two call sites in `src/`
(`ingest.ts:735`, `group-engine.ts:1816`) and `#stateNotifications.record` exactly three
(`group-engine.ts:1597` via `ctx.recordStateNotifications`, `:1829`). None of them is on the
local send path. `confirmPublished` (`:892-936`) advances the epoch, records the commit into
retained history and the tree, emits `epoch_confirmed` — and derives nothing, records nothing.

A local commit is not notification-free in substance: it can add members (invite), remove them,
rotate a key, and rewrite components (the D-05 splice writes admin policy). Two consequences:

1. **The withdrawal invariant fails.** `invalidatedByRewind` can only withdraw what was
   `record()`ed (`state-notifications.ts:232-251`). When a rewind supersedes *our own* commit,
   `#applyForkResolution` computes `canonicalDigests` from the winner chain (`:1723-1727`), our
   commit's digest is absent from the ledger entirely, and nothing is withdrawn. CONV-03's
   stated invariant — "a rewind that supersedes the commit can withdraw exactly the
   notifications it derived" — is vacuously true only because it derived none. An app told
   "Alice joined" by its own invite is never told the rewind undid it.
2. **The delivery half is silently one-sided.** The app learns about membership/component
   changes it observed inbound but not about ones it caused, so a UI built on
   `StateNotification` must special-case its own actions — the exact asymmetry the
   commit-digest attribution model exists to remove.

This is CR-09's misclassification one level up: "a *local* commit is not a commit" for the
notification ledger, on **both** send seams. It survived rounds 1 and 2 because both rounds
looked at seam parity between `commit` and `selfUpdate`, not at parity between the local and
inbound seams.

`DeliveredPayloadLedger` has the identical gap for our own application messages
(`ingest.ts:572-578` is the only `recordDeliveredAppPayload` call site;
`group-engine.ts:503-521`'s `case "applicationMessage"` records nothing), so a rewind that
abandons the branch we sent on never retracts our own payload as `invalidated`. Same class,
lower severity — folded here rather than filed separately.

**Fix:** derive and record inside the merged commit branch of `confirmPublished`, using the
digest of the bytes already in hand:

```ts
if (pending.kind === "commit" || pending.kind === "selfUpdate") {
  // ...existing transition + setState + #recordCommitNode...
  const digest = commitDigest(encode(mlsMessageEncoder, pending.commitMessage));
  let derived: StateNotification[] = [];
  try {
    derived = deriveStateNotifications({
      parentState: pending.parentState,
      resultingState: pending.newState,
      commitDigest: digest,
    });
  } catch (error) {
    this.#log()("state notification derivation failed for local commit: %o", error);
  }
  this.#stateNotifications.record(digest, toEpoch, derived);
  const anchor = this.#retained.anchorEpoch();
  if (anchor !== undefined) this.#stateNotifications.pruneBelow(anchor);
  // ...
}
```
Wrap the derivation for the same reason WR-15 wrapped the rewind loop — state has already
advanced at that point. Surfacing the derived list to the caller needs a channel
(`SendResult.notifications`, or the dedicated rewind/apply result variant WR-18 and WR-20 both
want); the *ledger record* is the part that must not wait, because without it the withdrawal
path is unrecoverable. Regression test: local invite commit → fork arrives → rewind supersedes
it → assert a `stateInvalidated` withdrawing the `memberAdded`.

---

### WR-19: `removedMarkerStore` shares the bare group-id keyspace with `store`, and the docs invite backing them with one store — WARNING

**File:** `src/client/group/marmot-group.ts:700-704`, `:730`;
`src/client/marmot-client.ts:112-121`; `src/client/groups-manager.ts:88-97`;
compare `src/engine/history-tree.ts:29-32`

**Issue:** the marker is keyed by the **bare** group-id hex — `getItem(this.idStr)` /
`setItem(this.idStr, true)` / `removeItem(this.idStr)` — the same key `GroupSession.save`
uses for the serialized `ClientState` (`group-session.ts:375-377`). The rewind store avoids
this by namespacing every key (`${gid}/meta`, `${gid}/edge/${tag}`, …,
`history-tree.ts:29-32`); the marker store does not.

The docs actively push consumers toward a shared backend: *"Back it with the same durable
backend as `groupStateStore`"* (`marmot-client.ts:119-120`), and `MarmotGroupOptions:143-145`
says it is *"keyed by the same group-id hex as {@link store}"*. A consumer wiring one loosely
typed store (`InMemoryKeyValueStore<any>`, or a thin adapter over IndexedDB/localStorage that
erases the type parameter) into both fields gets `setItem(idStr, true)` **overwriting the
serialized group state** on the first involuntary removal — total, silent loss of the group.
The differing type parameters are the only thing preventing it, and they are erased at runtime.

**Fix:** namespace the marker key and keep it distinct by construction
(`#markerKey() { return \`${this.idStr}/removed\`; }`), reword the doc from "back it with the
same durable backend" to "a **separate** namespace on the same durable backend", update
`destroy()`'s clear (`marmot-group.ts:918`), and add a migration read of the legacy bare key.

---

### WR-20: tree-fed re-convergence derives and ledger-records the winner chain's notifications, then throws them away — WARNING

**File:** `src/engine/group-engine.ts:1872-1932` (`:1906-1931`), vs `src/engine/ingest.ts:841-856`

**Issue:** `#applyForkResolution` returns `notifications: chainNotifications` for every
recovered rewind (`:1847`). The pool-replay path surfaces them on the `removed` / `processed`
result (`ingest.ts:846`, `:854`). The tree-fed path (`#reconvergeFromTree`) yields only
`stateInvalidated` withdrawals (`:1912-1921`) and `invalidated` app-payload retractions
(`:1922-1930`) — `applied.notifications` is **discarded**.

So a load-time or post-sweep branch switch that adds Alice, removes Bob and rotates a key tells
the application only what was *withdrawn*, never what was *applied*. The commits are
ledger-recorded (`:1829`), so a later rewind can withdraw notifications the app was never told
about — the mirror image of the CR-07 defect, on the other rewind path. The method's doc
(`:1866-1870`) justifies the omission for *app messages* ("surface via a follow-up sweep"),
which does not apply to state notifications: no sweep re-derives them.

This became load-bearing this round — CR-06's fix routes `reconvergeFromHistory` results all the
way to `MarmotGroup.reconverge` (`marmot-group.ts:542-551`), so there is now a consumer that
would receive them.

**Fix:** yield the applied chain's notifications from `#reconvergeFromTree` before the
withdrawals, as their own result variant (symmetric with `stateInvalidated`) rather than bolted
onto a `processed` result with an unrelated `message` — which is also WR-18's recommended
structural remedy and the channel CR-14 needs. Doing all three at once makes it one breaking
change to the result union, not three.

---

### WR-21: WR-15's hardening is defeated one line later by `getPubkeyLeafNodeIndexes` — WARNING

**File:** `src/core/group-members.ts:47-59`, `:68-87`; call site
`src/engine/group-engine.ts:820-825`

**Issue:** WR-15 hardened `getGroupMembers` to skip a basic credential whose identity is not a
valid 32-byte hex key (`group-members.ts:32-44`). Its immediate co-caller in the same loop was
not hardened:

```ts
for (const pubkey of getGroupMembers(state)) {             // :820 — skips the bad leaf
  const leaves = getPubkeyLeafNodeIndexes(state, pubkey);  // :821 — THROWS on it
```

`getPubkeyLeafNodeIndexes` calls `getCredentialPubkey(node.leaf.credential)` on **every** basic
leaf while scanning for a match (`:81`), so the very leaf `getGroupMembers` just skipped throws
here. `getPubkeyLeafNodes` (`:47-59`) has the identical shape, and is reached from
`remove-member.ts:18` and `leave-group.ts:26`.

That throw escapes `#adminPolicySpliceFor`, which is called from **both** commit-producing send
seams before any staging (`group-engine.ts:598`, `:715`) — so a single malformed leaf (from a
Welcome or a `ratchet_tree` extension, the exact states WR-15's own docblock names as ungated by
`marmotAuthService`) makes every local commit and every selfUpdate throw an opaque
"Invalid credential nostr public key". The fix report flags this as a follow-up
(`03-REVIEW-FIX.md:220-222`); it is not a follow-up, it is the other half of the same defect on
a higher-severity path than the one that was fixed.

**Fix:** wrap the comparison in both functions, matching `getGroupMembers`:
```ts
.filter((node) => {
  if (node.leaf.credential.credentialType !== defaultCredentialTypes.basic) return false;
  try { return getCredentialPubkey(node.leaf.credential) === pubkey; } catch { return false; }
})
```
Extend `src/core/__tests__/group-members.test.ts` with the malformed-leaf case for all three
functions.

---

### WR-22: both commit seams enter `PendingPublish` before the envelope is wrapped, with no rollback path — WARNING

**File:** `src/engine/group-engine.ts:661-669` (`commit`), `:740-748` (`selfUpdate`);
`src/client/runtime/group-runtime.ts:140-154`, `:156-171`

**Issue:** in both seams the order is `#transitionLifecycle(pendingPublish)` →
`#stagedCommitParentEpoch = …` → `await this.peeler.wrapGroupMessage(...)`. If
`wrapGroupMessage` rejects (NIP-44 key derivation, a signer failure, a `getNostrGroupIdHex`
throw), `send()` propagates the error (`:490-498` re-throws after the audit emit) **without
ever returning a `pending`** — so no caller can invoke `publishFailed`. The engine is stuck in
`PendingPublish` with `#stagedCommitParentEpoch` pinned: every subsequent
`send({kind:"commit"|"selfUpdate"})` throws `mayPrepareLocalCommit`,
`#maybeAutoCommitSelfRemoves` returns early (`:1336`), `#reconvergeFromTree` returns early
(`:1875`), and `mayReleaseOutbound` never releases the queue. The group is permanently frozen
until the process restarts.

The same shape exists after publish: `GroupRuntime.publishSelfUpdate`/`publishCommit` call
`#confirmPublished` *outside* their `try` (`group-runtime.ts:151`, `:170`). `confirmPublished`
transitions to `Merging`, then `#setState` fires `onStateChanged` → `MarmotGroup` emits
`stateChanged` to arbitrary app listeners (`marmot-group.ts:445`). A throwing listener leaves the
engine in `Merging`, whose only legal exit is `Stable` (`group-lifecycle.ts:38`) and which
nothing takes. `await this.#save()` rejecting has the same effect one step later, with state
advanced in memory but unpersisted.

Pre-existing for `commit`; CR-09/WR-17 duplicated it onto `selfUpdate`, so it is now the
behaviour of both commit-producing seams.

**Fix:** move the wrap before the transition (nothing after `createCommit` depends on the
lifecycle), or wrap the tail in
`try { … } catch (e) { this.#transitionLifecycle(stable, "publish_failed"); this.#stagedCommitParentEpoch = undefined; throw e; }`.
In `GroupRuntime`, extend the `try` to cover `#confirmPublished` + `#save` and call
`publishFailed` (or a new `mergeFailed`) on throw.

---

### WR-23: the notification vocabulary CONV-03 exists to deliver is not reachable from the root barrel — WARNING

**File:** `src/index.ts:1-24`, `src/engine/index.ts:1-10`,
`src/client/session/group-session.ts:51`, `:132`, `:146`;
`src/client/group/marmot-group.ts:70-81`

**Issue:** the root `@internet-privacy/marmot-ts` barrel re-exports the client surface
(`src/index.ts:1`), which includes `group-session.js` (`client/index.ts:9`) and therefore the
public result types `ProcessedIngestResult.notifications?: StateNotification[]` (`:51`),
`RemovedIngestResult.notifications` (`:132`) and
`StateInvalidatedIngestResult.withdrawn: StateNotification[]` (`:146`). But `StateNotification`
itself is only exported from `src/engine/index.ts:3`, and the root barrel's curated engine
re-export list (`src/index.ts:7-24`) omits it. A consumer importing from the package root can
receive notifications but cannot name their type — they must reach into
`@internet-privacy/marmot-ts/engine`, which the architecture notes describe as the
"build your own transport" entrypoint, not the app entrypoint.

Two smaller inconsistencies in the same surface:
- `marmot-group.ts:70-81` curates a re-export list of nine result variants and omits
  `StateInvalidatedIngestResult` — the one variant this phase added.
- `src/engine/index.ts` does not export `wire-format.js`, `history-tree.js`,
  `tree-convergence.js` or `delivered-payloads.js`, yet `MarmotGroupEngineOptions.historyTree?:
  GroupHistoryTree` (`group-engine.ts:171`) and `MarmotGroup.forkTree` (`marmot-group.ts:347`)
  are public and typed as `GroupHistoryTree`, which is unnameable from either subpath.

**Fix:** add `export type { StateNotification } from "./engine/state-notifications.js";` (plus
`groupWithdrawnNotificationsByCommit`, which WR-18's new docblocks now tell consumers to use) to
`src/index.ts`; add `StateInvalidatedIngestResult` to `marmot-group.ts`'s list; export
`history-tree.js` from `src/engine/index.ts`.

---

### WR-24: phase-3 code cites deprecated MIP numbers, including in code the round-2 fix pass wrote — WARNING

**File (phase-3-touched only):** `src/engine/admin-policy.ts:23`, `:137`;
`src/engine/fork-recovery.ts:269`, `:277`; `src/engine/group-engine.ts:606`, `:711`, `:889`;
`src/engine/wire-format.ts:105`; `src/client/group/marmot-group.ts:556`, `:739`;
`src/client/marmot-client.ts:425`;
`src/engine/__tests__/commit-legality-seams.test.ts:189`, `:352`;
`src/engine/__tests__/send-commit-legality.test.ts:625`, `:670`, `:753`, `:761`, `:773`, `:960`;
`src/__tests__/groups-manager.test.ts:223`;
`src/__tests__/integration/self-update-persistence.test.ts:111`

**Issue:** MIP numbering is deprecated. `refs/marmot/mip-coverage.md:5` states plainly that the
file "maps the deprecated Marmot MIPs to this spec. It is a review aid, not a normative
surface." The bundled spec at `refs/marmot/` is topic-organized (`foundation/`, `protocol-core/`,
`app-components/`, `transports/`, `features/`), and every other spec citation in these same
files already uses the new paths (`protocol-core/member-departure.md`,
`protocol-core/group-messaging.md`, `app-components/admin-policy-v1.md`, `foundation/errors.md`)
— so the MIP citations are not a consistent legacy convention, they are stale outliers sitting
next to correct ones.

The round-2 fix pass **propagated** them into brand-new code rather than converting: the CR-11
comment (`fork-recovery.ts:269`, `:277`) cites "the MIP-03 admin gate"; the CR-09 test file
written from scratch cites MIP-02 (`self-update-persistence.test.ts:111`); the CR-11 helper's
docblock cites "the MIP-03 admin gate's self_remove rule" (`wire-format.ts:105`).

This is a comment/doc-accuracy issue, not behavioural — I verified the underlying normative
statements all survive the reorganization (see the CR-09 verdict for the joining.md check, and
CR-13 for the group-messaging.md commit-authorization check, which is *stronger* than the
MIP-03 wording the code paraphrases).

**Fix** — per `refs/marmot/mip-coverage.md:12-29`, for the phase-3 files only:

| Stale | Correct citation | Applies to |
|---|---|---|
| MIP-03 (admin-only commits / non-admin carve-out) | `protocol-core/group-messaging.md` §Commit authorization | `admin-policy.ts:23`, `:137`; `fork-recovery.ts:269`, `:277`; `group-engine.ts:606`; `wire-format.ts:105`; the six `send-commit-legality.test.ts` sites; `commit-legality-seams.test.ts:189`, `:352` |
| MIP-03 (self_remove / departure) | `protocol-core/member-departure.md` | the self_remove halves of the above |
| MIP-03 (commit ordering, 445 envelopes, ephemeral signing) | `transports/nostr.md` | `marmot-group.ts:739`; `groups-manager.test.ts:223` |
| MIP-02 (post-join self-update) | `protocol-core/joining.md:58`, `:60-64` | `group-engine.ts:711`, `:889`; `marmot-group.ts:556`; `marmot-client.ts:425`; `self-update-persistence.test.ts:111`; `send-commit-legality.test.ts:625` |

Do **not** chase the other ~100 repo-wide references in this phase. Consider a lint rule or a
`refs/marmot/mip-coverage.md` pointer in `CLAUDE.md` so the next fix pass does not propagate
more.

---

### WR-25: a local commit grows the fork-history tree but never emits `historyChanged` — WARNING

**File:** `src/client/group/marmot-group.ts:236-239` (event contract), `:754-755`, `:818-819`
(the only emit sites), vs `src/engine/group-engine.ts:908` (`#recordCommitNode` from
`confirmPublished`)

**Issue:** `historyChanged` is documented as firing "when the fork-history tree grew during
ingest — a new commit or a newly observed fork branch… Read `forkTreeView` to re-render"
(`:236-239`). It is emitted only from `MarmotGroup.ingest`, by comparing
`session.historyTree.size` before and after the drain (`:754-755`, `:818-819`).

A locally-authored commit grows the tree too — `confirmPublished` → `#recordCommitNode` →
`#tree.recordCommit` (`group-engine.ts:908`, `:370-383`) — and never passes through `ingest()`.
So any fork-tree UI or debugger built on this event goes stale after every commit the user
themselves makes, until the next inbound batch happens to fire it. CR-09 widened this: before
this round a selfUpdate did not touch the tree at all (that was the bug), so the missing event
was invisible for that seam; now the tree grows and the event still does not fire.

Same misclassification family as CR-09/CR-14: a commit-only side effect wired on the inbound
seam and not on the local one.

**Fix:** emit from the state-change path rather than from `ingest`'s size delta — e.g. have
`GroupSession` expose an `onHistoryChanged` callback that `MarmotGroup` forwards, fired by
`#recordCommitNode`/`#recordProposalStaged`/`recordEdge`, and keep the ingest-side size check
only as a coarse fallback (or drop it). At minimum, emit after
`runtime.publishCommit`/`publishSelfUpdate` resolves.

---

## Info

### IN-01 — see "Carry-Forward Re-Derivation" above (still open)
### IN-02 — see above (still open)
### IN-03 — see above (still open)

### IN-04: `#maybeAutoCommitSelfRemoves` lacks a `removedFromGroup` guard (demoted from WR-06)

**File:** `src/engine/group-engine.ts:1333-1340`

Unreachable today — see the WR-06 re-derivation: ts-mls sets `unappliedProposals: {}` in the
same literal that sets the tombstone (`ts-mls/src/processMessages.ts:310-320`), so the early
return at `:1340` always fires first. Still worth a one-line guard because D-13/D-14 state the
invariant explicitly everywhere else (`:468-472`, `ingest.ts:336-345`) and the current safety is
incidental to a ts-mls implementation detail.

**Fix:** `if (this.#state.groupActiveState.kind === "removedFromGroup") return undefined;` as the
first line.

### IN-05: `destroyLocalState` removes a rewind-store key the tree never writes, and does not clear the removal marker

**File:** `src/client/session/group-session.ts:406-412`, vs `src/engine/history-tree.ts:29-32`,
`src/client/group/marmot-group.ts:917-918`

`await this.rewindStore?.removeItem(idHex)` (`:410`) targets a bare `idHex` key; every key the
history tree writes is namespaced (`${gid}/meta`, `${gid}/edge/...`, …), and the real cleanup is
the `GroupHistoryTree.purge` call on the next line. The bare removal is dead legacy. Separately,
marker cleanup lives in `MarmotGroup.destroy()` (`:918`), not in `destroyLocalState()` — so a
consumer calling the public `group.session.destroyLocalState()` directly orphans the marker, and
a recreated group with the same id inherits a stale "already realized".

**Fix:** delete `:410`; move `#clearRemovalMarker()` into the same teardown unit as
`destroyLocalState()` (or document that `destroy()` is the only supported teardown entry point).

### IN-06: two different `getGroupMembers` in the same codebase with different return types

**File:** `src/core/group-members.ts:32` (`string[]`) vs `ts-mls`'s export of the same name
(`LeafNode[]`), both imported in `src/core/account-identity-proof.ts:12` and
`src/core/group-members.ts:6`

`group-members.ts` already has to alias its ts-mls import as `getMlsGroupMembers` (`:6`), and
`account-identity-proof.ts:389` iterates `for (const leaf of getGroupMembers(state))` using the
ts-mls one — reading, at a glance, exactly like the local `string[]` version. TypeScript catches
a mix-up today, but the collision is a live trap, and WR-21 shows how easy it is to harden one
member-enumeration helper and miss its siblings.

**Fix:** rename the local one to `getGroupMemberPubkeys` (it returns pubkeys, not members) and
keep a deprecated alias for one release.

### IN-07: `#buildBranches`' known path never clears the `withCapturedProposals` buffer

**File:** `src/engine/fork-recovery.ts:268-334`, contract at `src/engine/admin-policy.ts:149-155`

The known branch invokes the raw `callback` (`:290`) rather than `capture.callback`, so it
neither buffers nor clears. Safe today only because the replay branch always calls
`capture.take()` first (`:339`) and `collectWitnessesAt` (`:546-591`) uses `capture.callback` on
messages that are almost always application messages. A private-message *commit* among the
witness envelopes would buffer proposals that the next `capture.take()` at `:354` would
attribute to the wrong commit. Currently masked, not guarded.

**Fix:** call `capture.take()` at the top of every `explore` iteration rather than only in the
replay branch, so the buffer's lifetime is one iteration by construction.

---

_Reviewed: 2026-08-05T15:40:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep (round 3)_
