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
