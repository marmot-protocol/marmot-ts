---
phase: 260912-jlt-vendor-forked-ts-mls-into-published-pack
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - pnpm-lock.yaml
  - scripts/vendor-ts-mls.mjs
  - scripts/verify-package-tarball.mjs
  - scripts/release-next.sh
  - .changeset/config.json
  - .changeset/vendor-forked-ts-mls.md
  - scripts/package-smoke/run.sh
  - scripts/package-smoke/smoke.mjs
  - scripts/package-smoke/consumer.ts
  - scripts/package-smoke/tsconfig.nodenext.json
  - scripts/package-smoke/tsconfig.bundler.json
  - .github/workflows/build.yml
  - README.md
  - AGENTS.md
  - docs/core/index.md
  - docs/core/groups.md
  - docs/core/key-packages.md
  - docs/core/members.md
  - docs/core/state.md
  - docs/core/messages.md
autonomous: true
requirements: [QUICK-260912-jlt]

must_haves:
  truths:
    - "D-01/D-03/D-06: `pnpm build` rebuilds the fork, compiles marmot-ts, and ships the fork's compiled dist/src .js + .d.ts (no .map, no test/bench) plus LICENSE and VERSION under dist/vendor/ts-mls"
    - "D-01/D-07: no emitted .js/.d.ts outside dist/vendor keeps a bare ts-mls module specifier; the build fails if one remains or if vendored code imports a package that is not a marmot-ts dependency or peerDependency"
    - "D-02/D-04/D-05: the packed manifest has no ts-mls in dependencies/peerDependencies/optionalDependencies, pins @hpke/core 1.9.0, and declares the five fork backends as optional peers; pnpm install --frozen-lockfile passes with a lockfileVersion 9.0 lock"
    - "D-10: a fresh npm consumer that installs only the tarball imports `.`, `/mls`, `/core` on Node, Bun and Deno, builds a real one-member Marmot group with the default ciphersuite, and has no node_modules/ts-mls"
    - "D-10: a TypeScript consumer typechecks under nodenext and bundler with real (non-any) /mls types, including the fork-only groupContextEncoder, and /core's ClientState is the same type as /mls's"
    - "D-08/D-09: changesets ignores ts-mls, and both `pnpm release` and `pnpm release-next` verify the tarball and fail closed unless the fork cannot be published, all without modifying the ts-mls submodule"
    - "D-11: README, docs/core snippets and AGENTS.md direct consumers to @internet-privacy/marmot-ts/mls and describe how the fork is shipped"
    - "Source/tests keep importing bare ts-mls and `pnpm vitest run` stays green"
  artifacts:
    - path: scripts/vendor-ts-mls.mjs
      provides: "Post-compile vendoring, specifier rewrite, and build-failing guards"
    - path: scripts/verify-package-tarball.mjs
      provides: "Tarball content/manifest assertions and the fail-closed fork-publish guard"
    - path: scripts/package-smoke/run.sh
      provides: "Packed-tarball consumer smoke (npm install, Node/Bun/Deno runtime, nodenext+bundler tsc)"
    - path: scripts/package-smoke/smoke.mjs
      provides: "Runtime smoke creating a real group through the vendored engine"
    - path: scripts/package-smoke/consumer.ts
      provides: "Type-level consumer contract with non-any guards"
    - path: .github/workflows/build.yml
      provides: "package-smoke CI job"
  key_links:
    - from: package.json scripts.build
      to: scripts/vendor-ts-mls.mjs
      via: "`pnpm run vendor` runs after `pnpm run compile`"
    - from: dist/mls.js
      to: dist/vendor/ts-mls/index.js
      via: "rewritten relative specifier ./vendor/ts-mls/index.js"
    - from: package.json scripts.release and scripts/release-next.sh
      to: scripts/verify-package-tarball.mjs
      via: "`--check-fork-unpublished` runs before changeset publish / pnpm publish"
    - from: .github/workflows/build.yml package-smoke job
      to: scripts/package-smoke/run.sh
      via: "`bash scripts/package-smoke/run.sh` after `pnpm build`"
---

<objective>
Make `@internet-privacy/marmot-ts` publishable as a self-contained package. The forked ts-mls (`ts-mls/` submodule, fork hzrd149/ts-mls) ships inside the package's own `dist/`. There is no `ts-mls` npm dependency and the fork never needs publishing. This implements the user-approved design in /home/robert/.claude/plans/lets-make-a-plan-scalable-conway.md; its decisions are locked:

- D-01: Source, tests and vitest keep importing the bare `ts-mls` specifier. A post-compile step copies the fork's compiled output into `dist/vendor/ts-mls/` and rewrites that specifier in emitted `.js`/`.d.ts` files to a relative path. No `#ts-mls` imports alias.
- D-02: Move `ts-mls` from `dependencies` to `devDependencies` as `workspace:*`. Update the lockfile; frozen install must pass.
- D-03: `build` = `pnpm run clean && pnpm --filter ts-mls build && pnpm run compile && pnpm run vendor`, and `vendor` = `node scripts/vendor-ts-mls.mjs`.
- D-04: Every package the vendored code imports statically is a marmot-ts dependency. `@hpke/core` is aligned to the fork's pinned `1.9.0`.
- D-05: The fork's dynamic-import backends become optional `peerDependencies`, mirroring `ts-mls/package.json`.
- D-06: Vendor only `ts-mls/dist/src` (not test or bench), with no `.map` files. Ship `LICENSE` and a `VERSION` file recording the fork commit.
- D-07: Two guards fail the build: a bare `ts-mls` specifier left outside vendor, and a vendored bare import not covered by dependencies or peerDependencies.
- D-08: Add `"ignore": ["ts-mls"]` to `.changeset/config.json`. Do NOT modify the `ts-mls` submodule (no fork commit, no pointer bump). Guard the release tooling so nothing publishes ts-mls. Record "set private:true in the fork" as a follow-up.
- D-09: `scripts/release-next.sh` keeps its publish logic and gains a pack sanity check before publishing.
- D-10: Add a CI package smoke job to `.github/workflows/build.yml`, backed by a committed smoke script. It packs the library and npm-installs the tarball into a fresh project. A Node smoke imports `.`, `/mls` and `/core` and runs a real ts-mls operation. `tsc --noEmit` checks a consumer under nodenext and bundler. Bun and Deno import the package too.
- D-11: README and docs say MLS primitives come from `@internet-privacy/marmot-ts/mls`, not npm `ts-mls`. The AGENTS.md (CLAUDE.md symlink) key-dependency and constraint lines describe how ts-mls is shipped.

Purpose: today `"ts-mls": "./ts-mls"` sits in `dependencies`. A published tarball would therefore be uninstallable, or silently resolve to upstream npm ts-mls (rc.13–rc.16). Upstream lacks the fork's app_data_dictionary, self-remove, senderLeafIndex and GroupContext encoder. The fork's own version `2.0.0-rc.14` also collides with upstream.

Output: a vendoring build step, a tarball verifier with a fork-publish guard, changesets and release wiring, a committed package smoke with its CI job, and updated docs. Three commits, one per task.

Execution notes:
- Run every command from the root of the checkout that holds this plan. Verify commands are repo-relative, so do not cd into a different checkout.
- Stay on the current non-master branch (`build/vendor-ts-mls`, or the worktree branch created from it). Never commit on `master`.
- Every commit message ends with:
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HDgGNuNLcDHeeW7CFg1TXJ
- Scratch work goes in SCRATCH=/tmp/claude-1000/-home-robert-Projects-marmot-ts/30cf0720-6f83-4e34-a332-6c8f651fc5ef/scratchpad
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@/home/robert/.claude/plans/lets-make-a-plan-scalable-conway.md
@package.json
@scripts/release-next.sh
@.changeset/config.json
@.github/workflows/build.yml
@ts-mls/package.json
@src/mls.ts
@tsconfig.build.json

Established facts, verified during planning against the primary checkout at the same commit (do not re-derive):
- pnpm-workspace.yaml lists packages `.`, `ts-mls` and `examples/*`. The only example is `examples/opentui`. It is private, depends on `@internet-privacy/marmot-ts` as `workspace:*` and resolves it through `dist`. It has a `typecheck: tsc --noEmit` script and does not import ts-mls directly.
- The lock header is `lockfileVersion: '9.0'` with `autoInstallPeers: true`. The root importer resolves `@hpke/core` to 1.9.0 and `ts-mls` to `link:ts-mls`.
- Local tools: pnpm 12.3.4 (CI uses pnpm 10), node v26.4.0, npm 11.17.0, bun 1.3.14, deno 2.9.1.
- Emitted dist today has 99 `from "ts-mls"` forms plus 4 `import("ts-mls")` forms (in d.ts files). Every quoted `"ts-mls"` occurrence in dist is a module specifier. Source has no ts-mls subpath imports, no `declare module`, and no reference-types directive.
- `ts-mls/dist/src` holds `.js`, `.d.ts`, `.map` (104 maps) and `tsdoc-metadata.json`. There are no orphan outputs today, but the fork builds with `incremental: true`.
- The fork output uses no `import.meta` and no `node:` imports. The fork's `dist` is gitignored in the fork, and `ts-mls/LICENSE` exists.
- Vendored bare imports, static: `@hpke/core`, `@noble/ciphers/aes.js`, `@noble/hashes/hmac.js`, `@noble/hashes/sha2.js`.
- Vendored bare imports, dynamic: `@hpke/chacha20poly1305`, `@hpke/dhkem-x448`, `@hpke/hybridkem-x-wing`, `@hpke/ml-kem`, `@noble/ciphers/chacha.js`, `@noble/curves/{ed25519,ed448,nist}.js`, `@noble/post-quantum/ml-dsa.js`.
- Changesets (cli 2.31, config 3.1.4) builds the dependents graph for `ignore` validation with `ignoreDevDependencies: true`. So `ignore: ["ts-mls"]` validates only once ts-mls is a devDependency.
- `changeset publish` does NOT honor `ignore`. It publishes every non-private workspace package whose version is missing from the registry. The fork is skipped today only because upstream already published 2.0.0-rc.14.
- ts-mls API: `getCiphersuiteImpl(cs: CiphersuiteName, provider = defaultCryptoProvider)`; `groupContextEncoder: Encoder<GroupContext>`; `encode(enc, value): Uint8Array`; `GroupContext.epoch: bigint`; `ClientState.groupContext`.
- Marmot core API: `createCredential(pubkey)`; `generateKeyPackage({ credential, ciphersuiteImpl })`; `createSimpleGroup(kp, impl, name, { adminPubkeys, relays })`. The root barrel re-exports `MarmotClient`.
- The default Marmot suite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. `"a".repeat(64)` is the valid x-only pubkey used in src/core/__tests__/media.test.ts.
- `pnpm pack` supports `--pack-destination`.
- `pnpm lint` already fails on refs noise, so format and check only touched files with `pnpm exec prettier`. `.prettierignore` covers `ts-mls/`, `.planning/` and `pnpm-lock.yaml`.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Vendor the fork into dist at build time, fix the manifest, and guard the release paths (D-01..D-09)</name>
  <files>package.json, pnpm-lock.yaml, scripts/vendor-ts-mls.mjs, scripts/verify-package-tarball.mjs, scripts/release-next.sh, .changeset/config.json, .changeset/vendor-forked-ts-mls.md</files>
  <read_first>package.json, scripts/release-next.sh, .changeset/config.json, ts-mls/package.json, src/mls.ts, tsconfig.build.json, pnpm-workspace.yaml</read_first>
  <action>
Step 0 (checkout prerequisites and baseline):
- If `ts-mls/package.json` is missing (for example, a fresh git worktree), run `git submodule update --init ts-mls`. Do not change the recorded submodule commit.
- If `node_modules` is missing, run `pnpm install --frozen-lockfile`. Its `prepare` script builds the fork.
- Run `pnpm build`, then `pnpm --filter marmot-opentui typecheck`, and record the exit status and error count.
- opentui consumes the library through dist, so after this task its typecheck must not gain new errors.

Step 1, package.json (per D-02, D-03, D-04, D-05):
- Dependencies:
  - Remove `ts-mls` from `dependencies` and add `"ts-mls": "workspace:*"` to `devDependencies`, keeping keys alphabetical.
  - Change `@hpke/core` from `^1.9.0` to exactly `1.9.0` (per D-04).
  - Leave `@noble/ciphers`, `@noble/curves` and `@noble/hashes` as ordinary dependencies.
- Peers:
  - Add `peerDependencies` with exactly the fork's versions: `@hpke/chacha20poly1305` 1.8.0, `@hpke/dhkem-x448` 1.8.0, `@hpke/hybridkem-x-wing` 0.7.0, `@hpke/ml-kem` 0.3.0, `@noble/post-quantum` 0.6.1.
  - Add `peerDependenciesMeta` marking each of these five `optional: true` (per D-05).
  - Do not add `@noble/ciphers` or `@noble/curves` as peers; they are real dependencies.
- Scripts:
  - Set `scripts.build` to exactly `pnpm run clean && pnpm --filter ts-mls build && pnpm run compile && pnpm run vendor` (per D-03).
  - Add `scripts.vendor` = `node scripts/vendor-ts-mls.mjs`.
  - Set `scripts.release` = `pnpm build && node scripts/verify-package-tarball.mjs --check-fork-unpublished && changeset publish --provenance` (per D-08).
- Leave `prepare`, `prepublishOnly`, `compile`, `files` and `exports` unchanged. `files` already ships `dist`, so `dist/vendor` is included automatically.

Step 2, lockfile (per D-02):
- Regenerate it with CI's pnpm major: `npx -y pnpm@10 install`.
- The first line must still read `lockfileVersion: '9.0'`.
- `git diff pnpm-lock.yaml` must stay within the root importer: ts-mls moves under devDependencies (specifier `workspace:*`, version `link:ts-mls`), the `@hpke/core` specifier becomes `1.9.0`, plus any peer bookkeeping.
- If unrelated churn appears, discard the lockfile changes with `git checkout pnpm-lock.yaml` and retry with pnpm 10. Only if pnpm 10 cannot be fetched, use the local pnpm under the same header and diff-scope rule.
- Finish when both `npx -y pnpm@10 install --frozen-lockfile` and `pnpm install --frozen-lockfile` exit 0.

Step 3, create scripts/vendor-ts-mls.mjs (per D-01, D-06, D-07):
- Write plain Node ESM that uses only `node:` builtins (fs, path, url, child_process).
- It must run on Node 20, so walk directories with manual recursion instead of the recursive readdir option.
- Resolve the repo root from `import.meta.url`.

The script runs these steps in order:

(a) Preconditions: `dist/mls.js` and `ts-mls/dist/src/index.js` must exist. Otherwise exit 1 with a message telling the user to run `pnpm build`.

(b) Copy the fork output:
- Remove `dist/vendor/ts-mls` (recursive, force). Then copy files from `ts-mls/dist/src` only, keeping their relative paths.
- Copy only files ending in `.js` or `.d.ts`. Skip `.map` files, `tsdoc-metadata.json` and anything else. Never read `ts-mls/dist/test` or `ts-mls/dist/bench`.
- Skip any output that has no matching `ts-mls/src/<relative path>.ts` source. This drops orphans left by the fork's incremental build.
- In each copied `.js` file, strip the trailing sourceMappingURL comment line, since maps are not shipped.

(c) Copy `ts-mls/LICENSE` to `dist/vendor/ts-mls/LICENSE`. Write `dist/vendor/ts-mls/VERSION` containing:
- the fork package name and version, from `ts-mls/package.json`
- the output of `git -C ts-mls rev-parse HEAD`
- clean or dirty, from `git -C ts-mls status --porcelain`

If git fails, write commit unknown and warn on stderr instead of failing.

(d) Rewrite pass over `dist`, recursively, excluding `dist/vendor`. In every `.js` and `.d.ts` file:
- Match each module specifier that is exactly the bare fork package name, in either quote style. It can sit in `from` position (covers import-from, export-from and export-star) or in dynamic `import(` position.
- Replace it with the POSIX relative path from that file's directory to `dist/vendor/ts-mls/index.js`. Prefix `./` when the path does not start with a dot.
  - Example: `dist/mls.js` gets `./vendor/ts-mls/index.js`.
  - Example: `dist/engine/group-engine.js` gets `../vendor/ts-mls/index.js`.
- Keep the original quote character.
- Write a file only when it changed, and count the rewrites.
- The pass must be idempotent. Do not touch marmot's own `.map` files.

(e) Guard A (per D-07): rescan the same non-vendor files for any quoted specifier that equals the fork name, or the fork name followed by a slash. Subpath imports are unsupported and never rewritten. If anything matches, print file:line for each hit and exit 1.

(f) Guard B (per D-07):
- Scan vendored `.js` and `.d.ts` files for module specifiers in `from`, dynamic `import(` and side-effect import forms.
- Ignore specifiers that start with a dot. Reduce the rest to a package name: `@scope/name`, or the first path segment.
- The allowed set is the keys of the root package.json `dependencies` plus `peerDependencies`.
- Anything outside it fails: list each offender and exit 1. This includes `node:` builtins, because the library must stay runtime-agnostic.
- The expected set today is `@hpke/core`, `@hpke/chacha20poly1305`, `@hpke/dhkem-x448`, `@hpke/hybridkem-x-wing`, `@hpke/ml-kem`, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum`.

(g) On success, log the copied-file count and the rewrite count.

Step 4, create scripts/verify-package-tarball.mjs (per D-07, D-08, D-09):
- Write plain Node ESM that uses only `node:` builtins. It is used by `release`, by `release-next.sh` and by Task 2's smoke runner.
- Flags:
  - `--tarball <path>` verifies that tarball.
  - Without `--tarball`, the script runs `pnpm pack --pack-destination <fresh mkdtemp under os.tmpdir()>` from the repo root, picks the single `.tgz`, and deletes the temp dir at the end.
  - `--check-fork-unpublished` enables the publish guard below.
- Read the tarball through `execFileSync`: `tar -tzf` for the file listing, and `tar -xzOf <tgz> package/package.json` or `package/dist/mls.js` for file contents.
- Required entries: `package/dist/index.js`, `package/dist/mls.js`, `package/dist/mls.d.ts`, `package/dist/vendor/ts-mls/index.js`, `package/dist/vendor/ts-mls/index.d.ts`, `package/dist/vendor/ts-mls/LICENSE`, `package/dist/vendor/ts-mls/VERSION`.
- Forbidden entries: any `.map` under `package/dist/vendor/ts-mls/`, and any path under `package/dist/vendor/ts-mls/src/`, `.../test/` or `.../bench/`. Those would mean the wrong copy root.
- Manifest checks:
  - The fork package name must be absent from `dependencies`, `peerDependencies`, `optionalDependencies` and `bundleDependencies`. Ignore `devDependencies`: pnpm pack rewrites `workspace:*` there, and consumers never install devDependencies.
  - All five optional peers from Step 1 must be present, each with `peerDependenciesMeta` optional true.
  - The `@hpke/core` dependency must be exactly `1.9.0`.
- The packed `dist/mls.js` text must contain `./vendor/ts-mls/index.js`.
- With `--check-fork-unpublished` (per D-08; the submodule stays untouched), read `ts-mls/package.json`:
  - If `private` is true, pass.
  - Otherwise run `npm view <name>@<version> version`. Pass only if it prints exactly that version, because changeset publish then skips the fork (it only publishes versions missing from the registry). Print a notice that the durable fix is to mark the fork private.
  - Any other outcome, including an npm or network error, exits 1 (fail closed) with an explanatory message.
- On success print `package tarball OK: <path>`. Otherwise list every failure and exit 1.

Step 5, .changeset/config.json (per D-08):
- Add `"ignore": ["ts-mls"]`.
- If changesets reports a skipped-package dependent error, ts-mls is still under `dependencies`; fix Step 1.
- Do not edit anything under `ts-mls/`.

Step 6, create .changeset/vendor-forked-ts-mls.md:
- Write a `patch` changeset for `@internet-privacy/marmot-ts` (Claude's discretion: this publish changes the manifest, so it needs release notes). It states:
  - the package now bundles the forked ts-mls build under `dist/vendor/ts-mls` instead of depending on a `ts-mls` package
  - MLS primitives are imported from `@internet-privacy/marmot-ts/mls`
  - the X448, ChaCha20, ML-KEM, X-Wing and ML-DSA backends are optional peer dependencies

Step 7, scripts/release-next.sh (per D-09):
- The only change is a new line, `node scripts/verify-package-tarball.mjs --check-fork-unpublished`, placed right after `pnpm build` and before `pnpm publish`.
- `set -euo pipefail` makes a bad tarball abort before publish, and the existing EXIT trap still restores package files.
- This implements the design's pack sanity check with a real `pnpm pack` and tar inspection instead of grepping dry-run output.

Step 8, local tarball check:
- Run `pnpm build`, then `pnpm pack --pack-destination $SCRATCH/t1-pack`.
- In a fresh `$SCRATCH/t1-consumer` directory run `npm init -y`, then `npm pkg set type=module`, then `npm install <that tgz>`. Use npm, not pnpm, and no ignore-scripts flag.
- Confirm that importing `@internet-privacy/marmot-ts/mls` via `node --input-type=module -e` exposes `getCiphersuiteImpl` as a function.
- Confirm `node_modules/ts-mls` does not exist.
- The full runtime and typecheck smoke is Task 2.

Step 9, guard negative tests (dist is not committed; restore afterwards):
- (i) Append a re-export of a fork subpath (the fork name plus `/nonexistent`) to `dist/utils/index.js`. Run `node scripts/vendor-ts-mls.mjs` and confirm it exits non-zero and names that file. Then run `pnpm build` to regenerate dist.
- (ii) Copy package.json to `$SCRATCH/package.json.bak` and delete `@hpke/core` from `dependencies` with a node one-liner. Run `node scripts/vendor-ts-mls.mjs` and confirm it exits non-zero and names `@hpke/core`. Restore package.json from the backup immediately, and check that `git diff package.json` shows only the Step 1 edits.

Step 10, format and commit:
- Run `pnpm exec prettier --write package.json .changeset/config.json .changeset/vendor-forked-ts-mls.md scripts/vendor-ts-mls.mjs scripts/verify-package-tarball.mjs`.
- Commit all Task 1 files, including pnpm-lock.yaml, with the message `build: vendor forked ts-mls into the published package` followed by the two trailer lines from the objective.
  </action>
  <verify>
    <automated>pnpm build && test -f dist/vendor/ts-mls/index.js && test -f dist/vendor/ts-mls/index.d.ts && test -f dist/vendor/ts-mls/LICENSE && test -f dist/vendor/ts-mls/VERSION && grep -q './vendor/ts-mls/index.js' dist/mls.js && node scripts/vendor-ts-mls.mjs && node scripts/verify-package-tarball.mjs && pnpm install --frozen-lockfile && head -1 pnpm-lock.yaml | grep -q "lockfileVersion: '9.0'" && pnpm exec prettier --check package.json .changeset/config.json .changeset/vendor-forked-ts-mls.md scripts/vendor-ts-mls.mjs scripts/verify-package-tarball.mjs && pnpm vitest run</automated>
  </verify>
  <done>
- `pnpm build` produces `dist/vendor/ts-mls`: the fork's `.js` and `.d.ts` files only, plus LICENSE and VERSION.
- Every emitted fork specifier is rewritten to a relative vendor path, and the vendor script is idempotent.
- Guard A and Guard B each fail on their injected negative case, and the tree is restored afterwards.
- `node scripts/verify-package-tarball.mjs` passes on a fresh pack. With `--check-fork-unpublished` it also passes today, because upstream `ts-mls@2.0.0-rc.14` exists.
- Both `npx -y pnpm@10 install --frozen-lockfile` and `pnpm install --frozen-lockfile` pass. The lock header is unchanged and the diff stays within the root importer.
- `pnpm vitest run` is green, and the opentui typecheck has no new errors compared with the baseline.
- The scratch npm consumer imports `/mls` without a `node_modules/ts-mls` directory.
- `release`, `release-next.sh` and `.changeset/config.json` are wired as specified.
- The `ts-mls/` submodule pointer and contents are untouched.
- One commit is created.
  </done>
</task>

<task type="auto">
  <name>Task 2: Committed package smoke script and CI package-smoke job (D-10)</name>
  <files>scripts/package-smoke/run.sh, scripts/package-smoke/smoke.mjs, scripts/package-smoke/consumer.ts, scripts/package-smoke/tsconfig.nodenext.json, scripts/package-smoke/tsconfig.bundler.json, .github/workflows/build.yml</files>
  <read_first>.github/workflows/build.yml, .github/workflows/tests.yml (setup-bun / setup-deno step shapes), scripts/verify-package-tarball.mjs, src/core/__tests__/media.test.ts (lines 1-50: impl, credential, key package, group setup)</read_first>
  <action>
Step 1, create scripts/package-smoke/smoke.mjs (per D-10):
- It must be runtime-neutral ESM that runs unchanged under node, bun and deno. Use no `node:` imports, and have failed assertions throw a plain Error.
- Imports:
  - Import the root package `@internet-privacy/marmot-ts` as a namespace, and assert that `MarmotClient` is a function.
  - From `@internet-privacy/marmot-ts/mls`, import `getCiphersuiteImpl`, `defaultCryptoProvider`, `encode` and `groupContextEncoder`.
  - From `@internet-privacy/marmot-ts/core`, import `createCredential`, `generateKeyPackage` and `createSimpleGroup`.
- Mirror the setup in `src/core/__tests__/media.test.ts`:
  - The pubkey is `"a".repeat(64)`.
  - `impl = await getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", defaultCryptoProvider)` (the default Marmot suite).
  - Create a credential, then call `generateKeyPackage({ credential, ciphersuiteImpl: impl })`.
  - Call `createSimpleGroup(kp, impl, "Package Smoke", { adminPubkeys: [pubkey], relays: [] })`.
- Assert `clientState.groupContext.epoch === 0n`.
- Assert that `encode(groupContextEncoder, clientState.groupContext)` returns a Uint8Array longer than zero. This exercises the fork-only encoder at runtime.
- Print `package smoke OK` with the runtime name: Deno if `globalThis.Deno` exists, Bun if `globalThis.Bun` exists, otherwise node plus `process.version`.

Step 2, create scripts/package-smoke/consumer.ts (per D-10). This is a type-level consumer contract:
- Imports:
  - type-only `ClientState` and `GroupContext` from `/mls`
  - values `encode` and `groupContextEncoder` from `/mls`
  - `createSimpleGroup` from `/core`
  - `MarmotClient` from the root
- Export a function that takes a GroupContext and returns a Uint8Array via `encode(groupContextEncoder, gc)`.
- Define `CoreState` as the awaited return type of `createSimpleGroup`, indexed by `clientState`. Export two identity functions: one converting CoreState to ClientState, one converting ClientState to CoreState. Together they prove that `/core` and `/mls` resolve to the same vendored declaration.
- Non-any guards: for each of ClientState, GroupContext and MarmotClient, export a const annotated with that type and initialized to the number 42, preceded by a ts-expect-error directive comment. If a type silently degrades to any under skipLibCheck, its directive becomes unused and tsc fails.

Step 3, create the two tsconfigs:
- Both use `"files": ["consumer.ts"]` and compilerOptions `strict: true`, `noEmit: true`, `skipLibCheck: true`, `target: "ES2022"`, `lib: ["ES2022", "DOM"]`, `types: []`.
- `tsconfig.nodenext.json` sets both `module` and `moduleResolution` to `NodeNext`.
- `tsconfig.bundler.json` sets `module` to `ESNext` and `moduleResolution` to `Bundler`.

Step 4, create scripts/package-smoke/run.sh:
- Write bash with `set -euo pipefail`, and make the file executable with chmod +x so git records the mode.
- Setup:
  - ROOT is two directories above the script. WORK is `$PACKAGE_SMOKE_WORKDIR` if set, otherwise `mktemp -d`.
  - Remove and recreate `WORK/pack` and `WORK/consumer`.
  - If `ROOT/dist/vendor/ts-mls/index.js` does not exist, fail with a "run pnpm build first" message. The script never builds; CI builds in an earlier step.
- Pack and verify:
  - From ROOT, run `pnpm pack --pack-destination "$WORK/pack"` and require exactly one `.tgz`.
  - Run `node "$ROOT/scripts/verify-package-tarball.mjs" --tarball <tgz>`, without the fork-publish flag.
- Consumer install, in WORK/consumer:
  - Run `npm init -y` and `npm pkg set type=module`.
  - Run `npm install --no-audit --no-fund <tgz>`. npm is deliberate: it surfaces undeclared-dependency leaks that pnpm workspaces hide. Keep lifecycle scripts enabled, as they are for real consumers.
  - Run `npm install --no-audit --no-fund --save-dev typescript@<range>`, reading the range from ROOT package.json `devDependencies.typescript` with `node -p`.
  - Fail if `node_modules/ts-mls` exists in the consumer.
- Checks:
  - Copy `smoke.mjs`, `consumer.ts` and both tsconfigs into the consumer.
  - Run `node smoke.mjs`, then `npx tsc -p tsconfig.nodenext.json`, then `npx tsc -p tsconfig.bundler.json`.
  - Bun: if bun is on PATH, run `bun smoke.mjs`. If it is missing, fail when `PACKAGE_SMOKE_REQUIRE_BUN=1`; otherwise print a skip notice.
  - Deno: same pattern, using `deno run -A smoke.mjs` and `PACKAGE_SMOKE_REQUIRE_DENO`. If Deno needs an explicit flag to resolve the consumer's node_modules, add `--node-modules-dir=manual` to that command only.
- End by echoing a pass line.

Step 5, .github/workflows/build.yml:
- Add a job named `package-smoke` with `needs: build`: `name: Package smoke (Node ${{ matrix.node-version }})`, `runs-on: ubuntu-latest`, matrix `node-version: [20.x, 24.x]`.
- Its steps mirror the build job's order and versions:
  1. checkout v4 with submodules recursive
  2. pnpm/action-setup v4 with version 10
  3. actions/setup-node v4 with the matrix node-version and cache pnpm
  4. the same pnpm store-path and actions/cache steps as the build job
  5. `pnpm install --frozen-lockfile`
  6. `pnpm build`
  7. oven-sh/setup-bun v2 (bun-version latest) and denoland/setup-deno v2 (deno-version v2.x), both conditioned on `matrix.node-version == '24.x'`
  8. a final step that runs `bash scripts/package-smoke/run.sh`, with env `PACKAGE_SMOKE_REQUIRE_BUN` and `PACKAGE_SMOKE_REQUIRE_DENO` set by a GitHub expression to `'1'` on the 24.x leg and `'0'` otherwise
- Leave the existing build job unchanged.

Step 6, local run:
- Run `PACKAGE_SMOKE_WORKDIR=$SCRATCH/package-smoke PACKAGE_SMOKE_REQUIRE_BUN=1 PACKAGE_SMOKE_REQUIRE_DENO=1 bash scripts/package-smoke/run.sh`; it must pass. Local node is 26, and the CI matrix covers 20 and 24.
- If a check fails because the packaged output really is broken (a missing file, an undeclared import, a wrong specifier), fix Task 1's scripts or manifest in a separate fix commit. Never weaken the smoke assertions.
- Sanity-check the non-any guards: in `$SCRATCH/package-smoke/consumer` only, delete one ts-expect-error line and confirm that `npx tsc -p tsconfig.nodenext.json` now fails. Nothing from this step is committed.

Step 7, format and commit:
- Run `pnpm exec prettier --write scripts/package-smoke/smoke.mjs scripts/package-smoke/consumer.ts scripts/package-smoke/tsconfig.nodenext.json scripts/package-smoke/tsconfig.bundler.json .github/workflows/build.yml`.
- Commit with the message `ci: add packed-tarball smoke test for the vendored ts-mls build` followed by the two trailer lines.
  </action>
  <verify>
    <automated>test -x scripts/package-smoke/run.sh && grep -q 'package-smoke:' .github/workflows/build.yml && pnpm exec prettier --check .github/workflows/build.yml scripts/package-smoke/smoke.mjs scripts/package-smoke/consumer.ts scripts/package-smoke/tsconfig.nodenext.json scripts/package-smoke/tsconfig.bundler.json && test -f dist/vendor/ts-mls/index.js && PACKAGE_SMOKE_WORKDIR=/tmp/claude-1000/-home-robert-Projects-marmot-ts/30cf0720-6f83-4e34-a332-6c8f651fc5ef/scratchpad/package-smoke PACKAGE_SMOKE_REQUIRE_BUN=1 PACKAGE_SMOKE_REQUIRE_DENO=1 bash scripts/package-smoke/run.sh</automated>
  </verify>
  <done>
- `run.sh` passes locally end to end:
  - the tarball verifies
  - the npm consumer installs without `node_modules/ts-mls`
  - Node, Bun and Deno each print `package smoke OK` after creating a real group and encoding its GroupContext
  - tsc passes under both nodenext and bundler
- Removing a ts-expect-error guard in scratch makes tsc fail.
- `build.yml` has a `package-smoke` job: needs build, runs Node 20.x and 24.x, and requires Bun and Deno on 24.x. The existing build job is unchanged.
- Files are prettier-clean, and one commit is created.
  </done>
</task>

<task type="auto">
  <name>Task 3: Document the vendored fork and /mls imports (D-11)</name>
  <files>README.md, AGENTS.md, docs/core/index.md, docs/core/groups.md, docs/core/key-packages.md, docs/core/members.md, docs/core/state.md, docs/core/messages.md</files>
  <read_first>README.md (lines 1-10 and 225-262), AGENTS.md (Commands, CI Expectations, Package Shape, Key Dependencies near line 139, Architectural Constraints near line 379), docs/core/index.md (Key Dependencies section)</read_first>
  <action>
Step 1, README.md (per D-11):
- Get the fork URL from `git -C ts-mls remote get-url origin` and normalize it to https.
- In the Package entrypoints table, change the `/mls` row to say it exposes the forked ts-mls MLS engine bundled inside the package, linking the fork URL.
- Directly below the table, add a short note:
  - Import MLS primitives (ciphersuites, ClientState, processMessage and so on) from `@internet-privacy/marmot-ts/mls`, not from a separately installed `ts-mls`.
  - npm `ts-mls` is the upstream build. It lacks the fork's additions (app_data_dictionary, self-remove, senderLeafIndex, GroupContext encoder), and its classes and types are distinct from the copy marmot-ts uses.
  - The X448, ChaCha20-Poly1305, ML-KEM, X-Wing and ML-DSA backends are optional peer dependencies, needed only for those ciphersuites.
- In the Development block, change the `pnpm build` comment to say it compiles TypeScript and bundles the ts-mls fork.

Step 2, docs/core snippets (per D-11):
- Change every import whose source is the bare fork package name so it imports from `@internet-privacy/marmot-ts/mls`. That is 8 snippets: `groups.md` (2), `key-packages.md` (2), `members.md` (1), `state.md` (1), `messages.md` (2). The named imports stay the same.
- In the Key Dependencies section of `docs/core/index.md`, extend the ts-mls bullet: it is a fork bundled with the package and exposed through `@internet-privacy/marmot-ts/mls`.
- Add no new docs pages, so `.vitepress/config.ts` needs no change.

Step 3, AGENTS.md (per D-11). CLAUDE.md is a symlink to AGENTS.md, so edit AGENTS.md only, and change only these lines:
- Commands:
  - Replace the `pnpm build` bullet. The build now cleans dist, builds the fork with `pnpm --filter ts-mls build`, runs `tsc -b tsconfig.build.json`, then runs `scripts/vendor-ts-mls.mjs`.
  - That script copies the fork's `dist/src` into `dist/vendor/ts-mls` and rewrites emitted specifiers. It fails the build on a leftover bare specifier or an undeclared vendored import.
  - Add a bullet: after `pnpm build`, `bash scripts/package-smoke/run.sh` runs the packed-tarball consumer smoke (npm install, Node/Bun/Deno import, nodenext and bundler tsc).
- CI Expectations: Build CI also runs the `package-smoke` job on Node 20 and 24, with Bun and Deno on the 24 leg.
- Package Shape: extend the `src/mls.ts` bullet to say that in published output the re-export resolves to the vendored fork in `dist/vendor/ts-mls`.
- Key Dependencies, the ts-mls line (about line 139):
  - It is the fork hzrd149/ts-mls, a submodule at `./ts-mls`, v2.0.0-rc.14.
  - It is a root devDependency (`workspace:*`), not a published dependency, and is vendored into `dist/vendor/ts-mls` at build time.
  - Its optional HPKE and post-quantum backends are optional peerDependencies.
- Architectural Constraints, the ts-mls local workspace bullet (about line 379):
  - Source and tests import only the bare root specifier; subpath imports fail the vendor guard.
  - Every package the fork imports must be a marmot-ts dependency or peerDependency.
  - The fork build is part of `pnpm build`.
  - `release` and `release-next` verify the tarball and refuse to proceed unless the fork cannot be published.
  - Open follow-up: mark the fork `private`.

Step 4, format and commit:
- Run `pnpm exec prettier --write README.md AGENTS.md docs/core/index.md docs/core/groups.md docs/core/key-packages.md docs/core/members.md docs/core/state.md docs/core/messages.md`.
- Commit with the message `docs: document the vendored ts-mls build and /mls imports` followed by the two trailer lines.
  </action>
  <verify>
    <automated>pnpm exec prettier --check README.md AGENTS.md docs/core && ! grep -rqF 'from "ts-mls"' docs && grep -q '@internet-privacy/marmot-ts/mls' README.md && grep -q '@internet-privacy/marmot-ts/mls' docs/core/groups.md && grep -q 'vendor-ts-mls' AGENTS.md && grep -q 'package-smoke' AGENTS.md</automated>
  </verify>
  <done>
- The README `/mls` row and the note below it send consumers to `@internet-privacy/marmot-ts/mls` and name the optional peers.
- All 8 docs/core snippets import from `/mls`, and docs/core/index.md describes the bundled fork.
- The AGENTS.md build, CI, package-shape, key-dependency and constraint lines match the new pipeline.
- Files are prettier-clean, and one commit is created.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ts-mls submodule to published tarball | Fork code compiled at build time ends up in every consumer install |
| Build output to npm registry | The manifest and file list decide what consumers resolve and execute |
| Release scripts to npm registry | Publish commands could push an unintended workspace package under an upstream name |
| Consumer resolver to npm namespace | A leftover bare `ts-mls` specifier would resolve to an unrelated upstream package |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-jlt-01 | Tampering | dist/vendor/ts-mls contents | medium | mitigate | `vendor-ts-mls.mjs` copies only the fork output compiled in the same `pnpm build` at the pinned submodule commit, with no downloads. It drops orphan outputs that have no source file, and VERSION records the commit plus clean/dirty state. |
| T-jlt-02 | Spoofing | A leftover bare specifier resolves to upstream npm ts-mls (dependency confusion) | high | mitigate | Guard A fails the build on any bare or subpath fork specifier outside vendor. `verify-package-tarball.mjs` asserts the fork name is absent from dependencies, peer, optional and bundle dependencies. The smoke asserts `node_modules/ts-mls` is absent after an npm install. |
| T-jlt-03 | Tampering | Accidental publish of the fork as ts-mls@2.0.0-rc.14 | high | mitigate | changesets config has `ignore: ["ts-mls"]`. `--check-fork-unpublished` fails closed in both `release` and `release-next.sh` unless the fork is private or its exact version already exists upstream, which changeset publish skips. Follow-up: set `private: true` in the fork. |
| T-jlt-04 | Denial of Service | An undeclared vendored import crashes consumer installs or imports | medium | mitigate | Guard B limits vendored imports to declared dependencies and peers and rejects `node:` builtins. The CI smoke installs with npm and imports on Node 20/24, Bun and Deno. |
| T-jlt-05 | Information Disclosure | Source maps point at fork sources that are not shipped | low | mitigate | No vendored `.map` files ship, and sourceMappingURL comments are stripped from vendored `.js`. |
| T-jlt-SC | Tampering | Package installs (lockfile regeneration, smoke consumer) | low | accept | No new third-party package enters pnpm-lock.yaml: the peers mirror versions already locked through the fork's devDependencies. `npx -y pnpm@10` is CI's own package manager. The smoke consumer installs only the local tarball, its already-locked dependencies and the repo's pinned `typescript` range, in a throwaway scratch or CI directory. |
</threat_model>

<verification>
1. `pnpm build` passes.
   - `dist/vendor/ts-mls/{index.js,index.d.ts,LICENSE,VERSION}` exist.
   - `dist/mls.js` points at `./vendor/ts-mls/index.js`.
   - Both guards fail on their injected negative cases.
2. `pnpm vitest run` is green. `pnpm install --frozen-lockfile` passes with both local pnpm and pnpm 10. The lock header still reads `lockfileVersion: '9.0'`.
3. `node scripts/verify-package-tarball.mjs --check-fork-unpublished` passes on a fresh pack.
4. `bash scripts/package-smoke/run.sh` passes locally with Bun and Deno required: the npm consumer installs, the Node/Bun/Deno runtime smoke runs, and tsc passes under nodenext and bundler.
5. `git status` shows no change to the `ts-mls` submodule pointer or contents, and three commits exist on the working branch.
6. The opentui typecheck has no new errors compared with the pre-change baseline.
</verification>

<success_criteria>
- A tarball from `pnpm pack` installs with npm into an empty project and works on Node, Bun and Deno with no `ts-mls` npm package involved. Its types resolve under nodenext and bundler.
- The manifest:
  - pins `@hpke/core` to 1.9.0
  - keeps `@noble/*` as dependencies
  - lists the five fork backends as optional peers
  - has no ts-mls runtime or peer dependency
- Release tooling (`pnpm release`, `pnpm release-next`) cannot publish a tarball that lacks the vendored fork, and cannot publish the fork itself.
- Consumer docs and agent notes point to `@internet-privacy/marmot-ts/mls`.
</success_criteria>

<output>
Create `.planning/quick/260912-jlt-vendor-forked-ts-mls-into-published-pack/260912-jlt-SUMMARY.md` when done. It must record:
- the three commit hashes
- the opentui typecheck baseline against the result
- the lockfile diff scope and the pnpm version used
- the local smoke output lines for Node, Bun and Deno
- this follow-up, verbatim: "Set `private: true` in the fork's ts-mls/package.json (commit in hzrd149/ts-mls, then bump the submodule pointer) so no tool can publish the fork; `--check-fork-unpublished` then passes offline via the private branch."
</output>
