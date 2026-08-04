# Deferred Items — Phase 03 commit-integrity-convergence-parity

Out-of-scope discoveries logged during execution (not fixed; see per-item plan for the
appropriate follow-up).

## From plan 03-02

- **`src/__tests__/exports.test.ts` inline snapshot is stale** (pre-existing, caused by
  plan 03-01, not 03-02). Plan 03-01 added `validateAppComponentIntegrity`,
  `validateAdminLeafCoupling`, `validateCommitLegality`, and `collectAppDataUpdateOps` to
  the `src/core` barrel (re-exported through `src/core/index.ts` → `src/index.ts`) but did
  not regenerate the exports snapshot test. `pnpm vitest run` fails on this one snapshot
  independent of any 03-02 change (confirmed by stashing 03-02's changes and re-running).
  Out of scope for 03-02 per the SCOPE BOUNDARY rule — the snapshot only needs
  `pnpm vitest run -u -- src/__tests__/exports.test.ts` (or an equivalent manual update) to
  add the four new names in sorted position. Whichever later plan in this phase next
  touches `src/core/index.ts`/exports should pick this up, or it should be swept in the
  phase's quality-gate pass.

- **`pnpm lint` fails on `refs/mdk/target/**`** (pre-existing, unrelated to any phase-03
  plan). `refs/mdk` is a vendored Rust reference repo; its `.prettierignore` entry is
  missing (only `ts-mls/` and `darkmatter/` are excluded), so `pnpm lint` (prettier
  --check .) flags hundreds of generated Cargo build-fingerprint JSON files under
  `refs/mdk/target/`. Confirmed independent of 03-02: reproduces identically with 03-02's
  changes stashed. All 03-02-touched source files (`src/engine/*`,
  `src/client/session/group-session.ts`, `src/core/inbound.ts`) individually pass
  `prettier --check`. Fix belongs in `.prettierignore` (add a `refs/mdk/target/` or
  `refs/mdk/` entry), not in this phase's source-code plans.

## From plan 03-06

- **`removedMarkerStore` (D-12) is not yet threaded through `GroupsManagerOptions` /
  `GroupRegistryOptions` / `GroupFactoryOptions`.** `MarmotGroupOptions.removedMarkerStore`
  and `#realizeRemovalIfNeeded` are fully wired at the `MarmotGroup` level (constructor,
  `fromClientState`, the `ingest` "removed" branch, `destroy`), and CONV-02's
  restart-durability requirement is proven directly against `MarmotGroup` in
  `src/__tests__/integration/removed.test.ts`. Checked every `MarmotGroup` construction
  site per this plan's Task 2 action item: `GroupRegistry.build()` only ever constructs via
  `MarmotGroup.fromClientState` (already covered), and `GroupFactory.create()` bypasses
  `fromClientState` but only ever builds a BRAND NEW group (never already removed), so no
  load-time realization gap exists at either site today. A downstream app driving groups
  exclusively through the top-level `GroupsManager` convenience API has no way to supply a
  `removedMarkerStore`, so realization there still degrades to the documented in-memory-only
  fallback across a restart. Threading the option through all three option types (mirroring
  how `rewindStore` is already threaded) is a reasonable, small follow-up if/when a plan next
  touches `group-registry.ts` / `group-factory.ts` / `groups-manager.ts`'s option surface —
  not required for CONV-02 itself, which this plan closes at the `MarmotGroup` level.

## From plan 03-07

- **A rewind can never actually LAND ON `removedFromGroup` via `ForkRecovery`'s
  pool-replay path (`fork-recovery.ts`'s `#buildBranches`/`explore()`), and a group removed
  via the DIRECT in-order commit branch (`ingest.ts`) can never later be un-removed via
  tree-fed re-convergence (`#reconvergeFromTree`/`buildTreeBranchSet`) — both discovered
  while building `state-notification-withdrawal.test.ts`'s CONV-03 marker-clearing case, and
  both pre-existing, cross-cutting engine/ts-mls interactions this plan's tasks do not touch:
  1. **Tombstone confirmationTag collision.** Verified directly (isolated `processMessage`
     call, no reuse/mutation involved): when `processMessage` applies a commit that removes
     the PROCESSING party's own leaf, the resulting `removedFromGroup` ClientState's
     `confirmationTag` is BYTE-IDENTICAL to its parent's — ts-mls has no legitimate new
     transcript hash to give the party it just removed (correct per RFC 9420: the removed
     party cannot compute secrets it's no longer entitled to). `ForkRecovery#buildBranches`'s
     `explore()` dedups candidates by resulting `confirmationTag` via a `seen: Set<string>`
     BEFORE recording any edge; since the tombstone's tag always equals the (already-`seen`)
     parent's tag, `seen.has(tag)` is always true and the candidate is silently dropped — no
     branch, no edge, nothing recorded. A commit that would remove the *observing* party can
     therefore never become an explorable fork-recovery candidate, regardless of digest
     ordering. This makes `AppliedForkResolution.tipCommitMessage` (03-06) and this plan's
     `resolution.notifications` attribution at the pool-replay "removed" forkPool site
     (`ingest.ts` ~line 830) effectively unreachable via `ForkRecovery` — they were kept as
     legitimate, harmless, forward-looking attribution code (mirroring 03-06's own
     `tipCommitMessage`), not removed, since a future fix to the dedup key (e.g. keying by
     `(parentTag, commitDigest)` instead of resulting tag alone) could make them reachable
     without touching the notification/withdrawal plumbing itself.
  2. **Direct removal skips tree/retained recording entirely.** `ingest.ts`'s direct
     in-order `removedFromGroup` branch deliberately does not call `ctx.recordCommit`
     ("retained history is moot" once removed — pre-existing comment, not from this plan).
     This means `RetainedHistoryStore` and `GroupHistoryTree` never learn the canonical tip
     advanced to the tombstone. `buildTreeBranchSet` (`tree-convergence.ts`) requires
     `tree.epochOf(currentTipTag)` to be defined and returns `undefined` (no-op) otherwise —
     so `#reconvergeFromTree` can never even attempt a switch once a group is removed via the
     direct branch, regardless of what else is recorded in the tree. The "deliberate
     asymmetry" comment in `group-engine.ts`'s `#ingestWithPool` (added in 03-06: "this
     tree-fed re-convergence pass must still run regardless... so a later rewind can
     supersede the removing commit and clear the removal marker") is therefore aspirational
     for the *direct*-removal case as currently implemented — it holds only if a FUTURE plan
     also records the removing commit into the tree (accepting the tag-collision consequence
     above, e.g. keying tree nodes by `(parentTag, commitDigest)` rather than resulting tag).
  - **Consequence for this plan (03-07/CONV-03):** the withdrawal mechanism (derive +
    ledger-record + `invalidatedByRewind` + grouped `stateInvalidated` yield, at both rewind
    sites) is implemented and proven end-to-end against a REAL `MarmotGroupEngine` for the
    ordinary (non-removal) case — see `withdraws exactly a superseded commit's...` and
    `yields stateInvalidated before...` in `state-notification-withdrawal.test.ts`. The
    marker-clearing branch added to `MarmotGroup#ingest` is implemented and unit-tested
    directly (a crafted `stateInvalidated` result with a `selfRemoved` entry), since composing
    it with a fully organic "removed via rewind, then un-removed via a later rewind"
    end-to-end scenario is blocked by the two structural gaps above. CONV-03 is marked
    Complete on this basis (derivation + ledger + withdrawal + marker-clearing wiring are
    all implemented and tested at their correct boundaries); the full organic composition is
    logged here as the concrete follow-up for whichever future plan next touches
    `fork-recovery.ts`'s candidate dedup key or the direct-removal branch's tree/retained
    recording.
