---
phase: 260912-jlt-vendor-forked-ts-mls-into-published-pack
plan: 01
subsystem: build
tags: [ts-mls, pnpm-pack, changesets, npm-publish, dependency-confusion, ci]

requires: []
provides:
  - "pnpm build vendors the compiled ts-mls fork into dist/vendor/ts-mls and rewrites emitted specifiers"
  - "packed tarball has no ts-mls runtime/peer dependency; five fork backends are optional peers"
  - "verify-package-tarball.mjs tarball/manifest assertions plus a fail-closed fork-publish guard"
  - "packed-tarball consumer smoke (npm install, Node/Bun/Deno, nodenext+bundler tsc) as a committed script and CI job"
  - "README/docs/AGENTS.md point consumers at @internet-privacy/marmot-ts/mls"
affects: [release, packaging, ci]

tech-stack:
  added: []
  patterns:
    - "post-compile vendoring step with build-failing guards (bare-specifier guard, undeclared-import guard)"
    - "tarball verification via tar -tzf/-xzOf rather than parsing pnpm pack --dry-run output"

key-files:
  created:
    - scripts/vendor-ts-mls.mjs
    - scripts/verify-package-tarball.mjs
    - scripts/package-smoke/run.sh
    - scripts/package-smoke/smoke.mjs
    - scripts/package-smoke/consumer.ts
    - scripts/package-smoke/tsconfig.nodenext.json
    - scripts/package-smoke/tsconfig.bundler.json
    - .changeset/vendor-forked-ts-mls.md
  modified:
    - package.json
    - pnpm-lock.yaml
    - scripts/release-next.sh
    - .changeset/config.json
    - .github/workflows/build.yml
    - README.md
    - AGENTS.md
    - docs/core/index.md
    - docs/core/groups.md
    - docs/core/key-packages.md
    - docs/core/members.md
    - docs/core/state.md
    - docs/core/messages.md

key-decisions:
  - "Regenerated pnpm-lock.yaml with pnpm 10.34.5 (matching CI's floating `version: 10` pin); the resulting 311-line diff was verified reproducible/deterministic and traced entirely to peer-dependency key recomputation cascading from the 5 newly declared HPKE/post-quantum peers plus the exact @hpke/core pin, not to unrelated drift — both `pnpm install --frozen-lockfile` (local pnpm 12.3.4) and `npx -y pnpm@10 install --frozen-lockfile` pass against it with an unchanged lockfileVersion '9.0' header"
  - "Initialized refs/mdk (`git submodule update --init refs/mdk`) to unblock the 3 pre-existing conformance smoke test files that read fixtures from it; this checked out the submodule at its already-pinned commit with zero pointer diff, it is not a Task 1-3 deliverable and is unrelated to the ts-mls vendoring work"

requirements-completed: [QUICK-260912-jlt]

duration: 20min
completed: 2026-09-12
status: complete
---

# Quick Task 260912-jlt: Vendor forked ts-mls into the published pack Summary

**Post-compile vendoring step (`scripts/vendor-ts-mls.mjs`) copies the fork's compiled output into `dist/vendor/ts-mls`, rewrites all 99 emitted `ts-mls` specifiers to a relative vendor path, and two build-failing guards plus a tarball verifier (`scripts/verify-package-tarball.mjs`) and CI package-smoke job prevent the fork from ever being installed as, or accidentally published as, `ts-mls`.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-09-12T19:26:54Z
- **Completed:** 2026-09-12T19:47:00Z
- **Tasks:** 3
- **Files modified:** 21 (8 created, 13 modified)

## Accomplishments

- `pnpm build` now runs `clean → pnpm --filter ts-mls build → compile → vendor`, producing `dist/vendor/ts-mls/{index.js,index.d.ts,LICENSE,VERSION}` (208 fork `.js`/`.d.ts` files, no `.map`, no test/bench) and rewriting `dist/mls.js` (and 98 other files) to import `./vendor/ts-mls/index.js` instead of the bare `ts-mls` specifier.
- Two build-failing guards in `scripts/vendor-ts-mls.mjs`: Guard A rejects any leftover bare/subpath `ts-mls` specifier outside `dist/vendor`; Guard B rejects any vendored bare import that isn't a declared `dependencies`/`peerDependencies` entry (including `node:` builtins). Both were exercised with injected negative cases and confirmed to exit non-zero with the correct file/line, then the tree was restored.
- `package.json`: `ts-mls` moved to `devDependencies` (`workspace:*`); `@hpke/core` pinned to exactly `1.9.0`; the fork's 5 dynamic-import backends (`@hpke/chacha20poly1305`, `@hpke/dhkem-x448`, `@hpke/hybridkem-x-wing`, `@hpke/ml-kem`, `@noble/post-quantum`) added as optional `peerDependencies`/`peerDependenciesMeta`.
- `scripts/verify-package-tarball.mjs` asserts the packed tarball's file list and manifest (no `ts-mls` in `dependencies`/`peerDependencies`/`optionalDependencies`/`bundleDependencies`, correct optional peers, `@hpke/core` pinned) and, with `--check-fork-unpublished`, fails closed unless the fork is `private` or its exact version is already published upstream (today: `ts-mls@2.0.0-rc.14` exists on npm, so this passes). Wired into `pnpm release` and `scripts/release-next.sh`.
- `.changeset/config.json` ignores `ts-mls`; added a `patch` changeset describing the vendoring change for `@internet-privacy/marmot-ts`.
- Committed `scripts/package-smoke/{run.sh,smoke.mjs,consumer.ts,tsconfig.nodenext.json,tsconfig.bundler.json}` and a `package-smoke` CI job in `.github/workflows/build.yml` (Node 20.x/24.x, `needs: build`, Bun+Deno required on the 24.x leg).
- README, 8 `docs/core/*.md` snippets, and `AGENTS.md` now point consumers at `@internet-privacy/marmot-ts/mls` instead of a separately installed `ts-mls`.

## Task Commits

1. **Task 1: Vendor the fork into dist at build time, fix the manifest, and guard the release paths** - `56cce59` (build)
2. **Task 2: Committed package smoke script and CI package-smoke job** - `ef2ab76` (ci)
3. **Task 3: Document the vendored fork and /mls imports** - `c3c242c` (docs)

_No TDD tasks; each task was a single commit._

## Files Created/Modified

- `scripts/vendor-ts-mls.mjs` - copies `ts-mls/dist/src` into `dist/vendor/ts-mls`, strips sourceMappingURL comments, writes LICENSE/VERSION, rewrites specifiers, runs Guards A and B
- `scripts/verify-package-tarball.mjs` - packs (or accepts `--tarball`), asserts tarball contents/manifest, and (`--check-fork-unpublished`) the fork-publish guard
- `scripts/package-smoke/run.sh` - packs, verifies, npm-installs into a throwaway consumer, runs Node/Bun/Deno smoke + nodenext/bundler `tsc`
- `scripts/package-smoke/smoke.mjs` - runtime-neutral consumer smoke creating a real group and encoding its GroupContext
- `scripts/package-smoke/consumer.ts` + `tsconfig.{nodenext,bundler}.json` - type-level consumer contract with non-any guards
- `.changeset/vendor-forked-ts-mls.md` - patch changeset describing the vendoring change
- `package.json` - `ts-mls` → devDependencies (`workspace:*`); `@hpke/core` pinned `1.9.0`; 5 optional peers; `build`/`vendor`/`release` scripts updated
- `pnpm-lock.yaml` - regenerated with pnpm 10.34.5 to match the manifest changes above
- `scripts/release-next.sh` - added `node scripts/verify-package-tarball.mjs --check-fork-unpublished` before `pnpm publish`
- `.changeset/config.json` - added `"ignore": ["ts-mls"]`
- `.github/workflows/build.yml` - added the `package-smoke` job
- `README.md`, `AGENTS.md`, `docs/core/{index,groups,key-packages,members,state,messages}.md` - documentation pointing at `/mls`

## Decisions Made

- Regenerated the lockfile with `npx -y pnpm@10` (10.34.5, matching CI's `version: 10` pin) rather than local pnpm 12.3.4. The resulting diff touched far more of the snapshot section than the manifest change alone (peer-suffix strings like `(supports-color@8.1.1)` disappeared across dozens of unrelated packages, including inside the `ts-mls` importer's own devDependency tree). Verified this is deterministic pnpm-10-vs-original-generator churn, not corruption or scope creep, by: (a) reverting to the original committed `package.json`/`pnpm-lock.yaml` and confirming `pnpm@10 install --frozen-lockfile` passes with zero rewrites against the *original* lockfile ("Lockfile is up to date, resolution step is skipped"), and (b) re-running the modified-`package.json` regeneration twice and getting an identical 311-line diff both times. Both `pnpm install --frozen-lockfile` (local 12.3.4) and `npx -y pnpm@10 install --frozen-lockfile` (10.34.5) pass against the committed lockfile, and the header stays `lockfileVersion: '9.0'`.
- Initialized the `refs/mdk` submodule (`git submodule update --init refs/mdk`) because 3 pre-existing conformance smoke test files (`src/__tests__/conformance/smoke.test.ts`) read fixture vectors from it and failed with `ENOENT` when it was uninitialized in this worktree. This is a read-only checkout at the already-recorded commit — `git status`/`git submodule status` show zero diff for it — and is unrelated to the ts-mls vendoring work; it was necessary only to get a fully green `pnpm vitest run` baseline in this specific worktree.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `.d.ts` files being silently skipped by the vendor copy step**
- **Found during:** Task 1, first run of `scripts/vendor-ts-mls.mjs`
- **Issue:** `path.extname("foo.d.ts")` returns `.ts`, not `.d.ts`, so the copy loop's `ext !== ".js" && ext !== ".d.ts"` check treated every `.d.ts` file as neither and skipped it — only 104 `.js` files were vendored (0 `.d.ts`).
- **Fix:** Replaced the `path.extname` check with explicit `filePath.endsWith(".d.ts")` / `.endsWith(".js")` tests.
- **Files modified:** `scripts/vendor-ts-mls.mjs`
- **Verification:** Re-ran the script; `dist/vendor/ts-mls` now has 104 `.d.ts` + 104 `.js` = 208 files, matching the fork's 104 source files.
- **Committed in:** `56cce59` (part of Task 1 commit; the file was written once with the fix already applied since it was caught before commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Essential correctness fix — without it, no `.d.ts` declarations would have shipped for the vendored MLS types, breaking TypeScript consumers entirely. No scope creep.

## Issues Encountered

None beyond the lockfile-churn investigation and submodule initialization documented above under Decisions Made.

## Exact Verification Outputs

**`pnpm build`:**
```
$ pnpm run clean && pnpm --filter ts-mls build && pnpm run compile && pnpm run vendor
$ rimraf ./dist
$ tsc -p tsconfig.build.json
$ tsc -b tsconfig.build.json
$ node scripts/vendor-ts-mls.mjs
vendor-ts-mls: copied 208 files, rewrote 99 files
```

**Tarball file count** (`pnpm pack`, `tar -tzf`):
- Total entries: **614**
- `dist/vendor/ts-mls/**` entries: **210** (104 `.js` + 104 `.d.ts` + `LICENSE` + `VERSION`; zero `.map`, zero `src/`/`test/`/`bench/` paths)

**`node scripts/verify-package-tarball.mjs --check-fork-unpublished`:**
```
--check-fork-unpublished: ts-mls@2.0.0-rc.14 already exists upstream; changeset publish will skip it.
Notice: the durable fix is to mark the fork private (set "private": true in ts-mls/package.json).
package tarball OK: /tmp/marmot-ts-pack-m4jH98/internet-privacy-marmot-ts-0.6.0.tgz
```

**`pnpm vitest run`:**
```
Test Files  96 passed (96)
     Tests  964 passed (964)
```
(964/964 after initializing `refs/mdk`; before initialization 32 tests across 3 conformance-smoke files failed with `ENOENT` reading `refs/mdk` fixtures — a pre-existing worktree-environment gap, not a Task 1-3 regression.)

**Lockfile frozen-install checks:**
- `pnpm install --frozen-lockfile` (local pnpm **v12.3.4**): exit 0, "Lockfile is up to date, resolution step is skipped"
- `npx -y pnpm@10 install --frozen-lockfile` (pnpm **v10.34.5**, matching CI's `version: 10` pin): exit 0, "Lockfile is up to date, resolution step is skipped"
- Lockfile header: `lockfileVersion: '9.0'` (unchanged)
- Diff scope: 311 lines (161 insertions / 150 deletions) — see Decisions Made for the reproducibility check that confirmed this is legitimate peer-graph churn, not corruption

**`bash scripts/package-smoke/run.sh`** (`PACKAGE_SMOKE_REQUIRE_BUN=1 PACKAGE_SMOKE_REQUIRE_DENO=1`), smoke output lines per runtime:
```
package smoke OK (node v26.4.0)
package smoke OK (Bun)
package smoke OK (Deno)
```
Full script output ended with `package-smoke: PASSED`, after: tarball verification, npm install of the tarball into a fresh consumer with `node_modules/ts-mls` absent, the three runtime smokes above, and both `npx tsc -p tsconfig.nodenext.json` and `npx tsc -p tsconfig.bundler.json` passing.

**Non-any guard sanity check** (scratch-only, not committed): deleting the `// @ts-expect-error` line above `clientStateGuard: ClientState = 42` in a scratch copy of `consumer.ts` made `npx tsc -p tsconfig.nodenext.json` fail with `error TS2322: Type 'number' is not assignable to type 'ClientState'` — confirming `ClientState` does not silently degrade to `any`.

**opentui typecheck** (`pnpm --filter marmot-opentui typecheck`, i.e. `tsc --noEmit`):
- Baseline (before any Task 1-3 changes): 0 errors
- After Task 1 (package.json/lockfile/vendor changes): 0 errors
- Final (after Task 3): 0 errors — no regression

**Guard negative tests** (Task 1 Step 9, scratch-injected, tree restored afterward):
- Guard A: appended `export * from "ts-mls/nonexistent";` to `dist/utils/index.js` → `node scripts/vendor-ts-mls.mjs` exited 1 and printed `dist/utils/index.js:6`
- Guard B: deleted `@hpke/core` from `package.json` `dependencies` → `node scripts/vendor-ts-mls.mjs` exited 1 and listed 10 vendored files importing `@hpke/core`; `package.json` was restored and diffed byte-identical to the intended Step 1 edits afterward

## User Setup Required

None - no external service configuration required.

## Follow-up

Set `private: true` in the fork's ts-mls/package.json (commit in hzrd149/ts-mls, then bump the submodule pointer) so no tool can publish the fork; `--check-fork-unpublished` then passes offline via the private branch.

## Next Phase Readiness

- `pnpm release` and `pnpm release-next` (via `scripts/release-next.sh`) now verify the packed tarball and refuse to publish unless the fork cannot be published — ready to use for the next real release.
- The `ts-mls/` submodule pointer and contents are untouched throughout (confirmed via `git status`/`git submodule status`); `refs/mdk` was initialized (checkout only, zero pointer diff) to get a green baseline `pnpm vitest run` in this worktree.
- CI's new `package-smoke` job (Node 20.x/24.x, Bun+Deno on 24.x) exercises the exact tarball a real `npm install` would resolve, ahead of any future publish.

---
*Phase: 260912-jlt-vendor-forked-ts-mls-into-published-pack*
*Completed: 2026-09-12*

## Self-Check: PASSED

- FOUND: scripts/vendor-ts-mls.mjs
- FOUND: scripts/verify-package-tarball.mjs
- FOUND: scripts/package-smoke/run.sh
- FOUND: scripts/package-smoke/smoke.mjs
- FOUND: scripts/package-smoke/consumer.ts
- FOUND: .changeset/vendor-forked-ts-mls.md
- FOUND commit: 56cce59
- FOUND commit: ef2ab76
- FOUND commit: c3c242c
