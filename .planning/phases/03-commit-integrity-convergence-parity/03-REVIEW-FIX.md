---
phase: 03-commit-integrity-convergence-parity
fixed_at: 2026-08-05T12:38:00Z
review_path: .planning/phases/03-commit-integrity-convergence-parity/03-REVIEW.md
iteration: 1
review_round: 2
findings_in_scope: 9
fixed: 9
skipped: 0
deferred: 14
status: all_fixed
baseline_tests: "75 files / 716 tests"
final_tests: "78 files / 727 tests"
---

# Phase 3: Code Review Fix Report (round-2 findings)

**Fixed at:** 2026-08-05T12:38:00Z
**Source review:** `.planning/phases/03-commit-integrity-convergence-parity/03-REVIEW.md`
**Iteration:** 1
**Fix range:** `848c7e6..e90fcff`

**Summary:**

- Findings in scope: 9 (CR-08, CR-09, CR-10, CR-11, WR-14..WR-18)
- Fixed: 9
- Skipped: 0
- Deferred (out of scope, carried from round 1): 14

**Suite:** baseline 75 files / 716 tests green → final **78 files / 727 tests green**.
`pnpm compile` clean and `pnpm vitest run` fully green before every commit. No existing
assertion was weakened or deleted; no existing test needed changing.

## Method note — the failure mode this pass was told to avoid

The previous fix pass shipped a green suite while introducing CR-08 and CR-09, because its
tests passed with the bugs present. Every fix below therefore carries a regression test that
was **run against the pre-fix source** (via `git stash` of only the source files, keeping the
test) and observed to fail for the right reason. Each entry records the exact pre-fix failure.
There were no findings where a genuinely-failing test could not be produced.

---

## Fixed Issues

### CR-10: `removedMarkerStore` unreachable through the public client API — BLOCKER

**Files modified:** `src/client/group-registry.ts`, `src/client/group-factory.ts`,
`src/client/groups-manager.ts`, `src/client/marmot-client.ts`,
`src/__tests__/integration/removed.test.ts`
**Commit:** `2b7a166`

Added `removedMarkerStore` to `GroupsManagerOptions`, `MarmotClientOptions`,
`GroupRegistryOptions` and `GroupFactoryOptions`, forwarding it alongside `store`/`rewindStore`
on both the load path (`GroupRegistry.build`) and the create path (`GroupFactory.create`).

Landed first, as instructed — it is the prerequisite that makes CR-05/CR-06 reachable, and it
gave the later fixes a real end-to-end path to test against.

**Pre-fix failure:** `expected null to be true` — the marker never reached the store when the
group was driven through `GroupsManager` rather than a hand-built `MarmotGroup`.

### CR-09: `selfUpdate` commits never recorded into retained history or the tree — BLOCKER

**Files modified:** `src/engine/group-engine.ts`, `src/engine/types.ts`,
`src/client/runtime/group-runtime.ts`, `src/__tests__/integration/self-update-persistence.test.ts`
**Commit:** `cc7bbd6`

`selfUpdate` now carries `parentState` + `commitMessage`, and `confirmPublished`/`publishFailed`
treat it identically to `commit`, so `#recordCommitNode` runs.

**This commit also fully closes WR-17** — not as a bundling convenience but as a structural
necessity: `Stable → Merging` is an illegal lifecycle transition, so recording a selfUpdate
requires the same `PendingPublish` staging `case "commit"` performs. selfUpdate therefore now
also runs the `mayPrepareLocalCommit` gate, transitions to `PendingPublish`, and pins
`#stagedCommitParentEpoch`; and `GroupRuntime.publishSelfUpdate` gained the rollback-on-failure
`try`/`catch` that `publishCommit` already had, or a failed publish would strand the engine in
`PendingPublish`.

**Pre-fix failures:** `historyTree.hasNode(tipTag)` was `false` after reload (the tree had been
discarded wholesale); and a selfUpdate issued while a commit was staged did not throw.

### CR-08: fail-closed fall-through silently drops our own canonical branch — BLOCKER

**Files modified:** `src/engine/group-engine.ts`, `src/engine/fork-recovery.ts`,
`src/__tests__/integration/own-proposal-snapshot.test.ts`
**Commit:** `e5ff27d`

Fixed at the root cause the review identified, rather than by patching the fall-through:
extracted `#recordProposalStaged` as a shared engine method and called it from
`confirmPublished`'s proposal branch, symmetric with the inbound `ingest.ts` wiring. Our own
staged proposals now reach the tree node snapshot, so after a restart
`retained.stateAt(forkEpoch)` carries them and `framedCommitProposals` resolves the
`ProposalRef` — the short-circuit stays available and our branch is built as a candidate.

The fall-through itself is deliberately **kept**: it is correct for the `PrivateMessage` case
and for a previously-adopted *inbound* commit (which replays fine). It is now logged, so any
residual unreconstructable known-state commit is diagnosable instead of silent.

**Pre-fix failure:** `expected [] to have a length of 1` on the reloaded parent's
`unappliedProposals` — precisely the snapshot gap.

### CR-11: CONV-04 short-circuit bypasses the MIP-03 admin-policy callback — BLOCKER

**Files modified:** `src/engine/wire-format.ts`, `src/engine/fork-recovery.ts`,
`src/engine/__tests__/send-commit-legality.test.ts`
**Commit:** `2cb6c9a`

Added `framedCommitProposalsWithSender`, which reproduces exactly what ts-mls's `applyProposals`
assembles as `allProposals` (by-value proposals attributed to the committer; `ProposalRef`s
carrying the original proposer's leaf from `unappliedProposals`) plus the committer leaf index
read off the wire. The known path now invokes the admin callback on that synthesized `incoming`
and drops the candidate on `reject`; a throw is treated as a refusal, matching the seam's
fail-closed policy. `framedCommitProposals` is now a thin wrapper over the new function, so the
two cannot drift.

Sequenced after CR-08 as instructed, since both touch the same known-state path.

**Pre-fix failure:** `expected [ 1 ] to include 0` — the callback only ever saw the rival's leaf;
our own commit's short-circuit never consulted it. The test deliberately uses a commit authored
by our **own** leaf, so the short-circuit is the only route to an edge (replay throws per
RFC 9420) — this avoids the targeting weakness the reviewer noted in the CR-04 test.

### WR-14: rewind re-records notifications for already-applied prefix links

**Files modified:** `src/engine/state-notifications.ts`, `src/engine/group-engine.ts`,
`src/engine/__tests__/state-notifications.test.ts`
**Commit:** `ea2f906`

`StateNotificationLedger.record` is now idempotent on `(digest, epoch)` via a new
`has(digest, epoch)`, and `#applyForkResolution` checks `has` before deriving so an
already-recorded link is not pushed into the caller-facing `chainNotifications`.

**Pre-fix failure:** `expected 2 to be 1` — the duplicate ledger entry.

### WR-15: `deriveStateNotifications` unguarded, and running after state advanced

**Files modified:** `src/core/group-members.ts`, `src/engine/group-engine.ts`,
`src/core/__tests__/group-members.test.ts`
**Commit:** `dfbcbf4`

Fixed both ends as the review recommended: `getGroupMembers` now skips (rather than throws on) a
basic credential whose identity is not a valid 32-byte hex key, and the per-link derivation loop
in `#applyForkResolution` logs and continues rather than aborting the rewind mid-chain.

**Pre-fix failure:** `expected [Function] to not throw an error but 'Error: Invalid credential
nostr public key' was thrown`.

**Scope note:** `getPubkeyLeafNodes` and `getPubkeyLeafNodeIndexes` in the same file have the
identical latent exposure (they call `getCredentialPubkey` on every leaf to compare against a
target pubkey, so one malformed leaf throws instead of simply not matching). The review named
only `getGroupMembers`, so I deliberately did not widen the change. Flagged below as a follow-up.

### WR-16: removal marker cleared without re-checking the tombstone; paths diverge

**Files modified:** `src/client/group/marmot-group.ts`,
`src/__tests__/integration/removed.test.ts`
**Commit:** `b7eeada`

The clear is now gated on canonical state having actually left the tombstone. For the symmetry
half I took the "add it to `ingest()`" option rather than "drop it from `reconverge()`": both
paths now run the identical sequence — per-result withdrawal handling, then one trailing
state-derived `#realizeRemovalIfNeeded()`. Dropping the re-assert instead would have left a
rewind that lands us *on* a removal unrealized on both paths, which is the worse direction for a
state-derived (D-12) obligation.

**Pre-fix failure:** `expected null to be true` — the marker was wiped while the tombstone stood.

### WR-17: `selfUpdate` skips the lifecycle gate, `PendingPublish`, and the parent pin

**Files modified:** `src/engine/group-engine.ts`, `src/client/runtime/group-runtime.ts`
**Commit:** `cc7bbd6` (with CR-09 — see that entry)

Not bundled for convenience: CR-09's recording path cannot exist without WR-17's lifecycle
transition, because `Stable → Merging` throws. Covered by its own regression test
("refuses to prepare a selfUpdate while another commit is staged"), verified failing pre-fix.

### WR-18: `notifications` semantics widened to whole-chain, docs still per-commit

**Files modified:** `src/engine/types.ts`, `src/client/session/group-session.ts`,
`src/engine/ingest.ts`
**Commit:** `e90fcff`

Documentation only — no behavior change. All four result-type docblocks (engine + session,
`processed` + `removed`) plus the `ingest.ts` assignment site now state the rewind case
explicitly and give the rule: attribute by each entry's `commitDigest`, never positionally
against `message`.

The review's second suggestion — surfacing a rewind's notifications as their own result variant,
symmetric with `stateInvalidated` — is the cleaner shape but is a **breaking change to the public
result union**, so it is intentionally not done in a review-fix pass. Recorded as a follow-up.

**No regression test.** A docblock change has no observable behavior to assert against; per the
method note above, this is stated rather than papered over with a test that would pass either way.

---

## Skipped Issues

None.

---

## Deferred (explicitly out of scope for this pass)

The 11 warnings and 3 infos carried forward from round 1 (`carried_open_from_round_1` in the
review frontmatter) were **not** addressed, as instructed. They remain open exactly as the
round-2 review describes them: WR-02..WR-09, WR-11, WR-12, WR-13 and IN-01, IN-02, IN-03.

Two of them were touched only incidentally and are worth re-checking at the next review:

- **WR-02** (unbounded `StateNotificationLedger`): still has no absolute cap, but WR-14's
  idempotent `record` removes the duplicate-growth accelerant the review attributed to it.
- **WR-11** (callback bound to a single state): unchanged. Note CR-11 adds a third consumer of
  that same `callback` value on the known path, so the existing binding concern now covers one
  more call site.

## Follow-ups surfaced while fixing (not in scope, not actioned)

1. `getPubkeyLeafNodes` / `getPubkeyLeafNodeIndexes` (`src/core/group-members.ts`) share WR-15's
   throw-on-malformed-identity exposure; only `getGroupMembers` was hardened.
2. WR-18's structural remedy (a dedicated rewind-notification result variant) is deferred as a
   breaking API change.

---

_Fixed: 2026-08-05T12:38:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
