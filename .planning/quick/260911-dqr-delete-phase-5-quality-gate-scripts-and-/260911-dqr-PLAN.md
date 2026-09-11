---
phase: quick-260911-dqr
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/render-quality-gate.mjs
  - scripts/validate-quality-ci.mjs
  - scripts/validate-quality-dossiers.mjs
  - src/__tests__/integration/self-remove.test.ts
autonomous: true
requirements:
  - quick-260911-dqr

must_haves:
  truths:
    - "The three hand-run Phase 5 quality-gate scripts (renderer, CI validator, dossier validator) are gone from scripts/ at HEAD, and no tracked file outside the planning directory still names them"
    - "scripts/publish-nostr.sh, scripts/release-next.sh, and every tracked file under tools/quality-gate/ are unchanged"
    - "src/__tests__/integration/self-remove.test.ts passes 2/2 without reading any planning document from disk"
    - "No file under src/ references the planning directory"
    - "pnpm compile and the test-inclusive root typecheck (tsc -p tsconfig.json --noEmit) both exit 0"
  artifacts:
    - path: "src/__tests__/integration/self-remove.test.ts"
      provides: "SelfRemove integration tests with the appliedNotifications behavioral assertions intact and no filesystem coupling to planning docs"
      contains: 'digest: "03".repeat(32)'
  key_links:
    - from: "src/__tests__/integration/self-remove.test.ts"
      to: "src/client/session/group-session.ts"
      via: "the retained assertions still construct an IngestResult appliedNotifications variant and check consumeApplied's hex digest plus empty notifications array"
      pattern: 'kind: "appliedNotifications"'
---

<objective>
Remove the dead Phase 5 quality-gate scripts and break the one test's dependency on planning documents. Archiving the v1.0 milestone (phase directories moved under the milestones archive) broke both.

User decisions (locked, from orchestrator scoping — no CONTEXT.md D-IDs exist for this quick task):
- Delete all three scripts: scripts/render-quality-gate.mjs, scripts/validate-quality-ci.mjs, scripts/validate-quality-dossiers.mjs.
- KEEP tools/quality-gate/ (the four Rust probe crates regenerate src/__tests__/fixtures/*-rust.json when refs/mdk moves).
- Do NOT touch scripts/publish-nostr.sh or scripts/release-next.sh.
- Do NOT touch submodule paths (ts-mls, refs/marmot, refs/mdk).
- Leave the other tests' refs/mdk conformance-vector file reads alone. They read a vendored upstream submodule, which is legitimate coupling.

Purpose: The scripts hardcode a Phase 5 directory that no longer exists and have no callers. self-remove.test.ts fails with ENOENT on every CI runtime (Node/Deno/Bun) because it reads an archived PLAN file relative to cwd. Tests must assert library behavior, not planning prose.

Output: three deleted scripts (one atomic commit) and one decoupled test file (one atomic commit). Code only. The orchestrator commits PLAN/SUMMARY/STATE separately.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@src/__tests__/integration/self-remove.test.ts

Planner-verified baseline (2026-09-11, before any change):
- `git grep` for the three script names outside the planning directory matched only the scripts referencing each other. Nothing in package.json, .github, docs, or tools/ calls them.
- `pnpm exec tsc -p tsconfig.json --noEmit` exits 0 with no output.
- `pnpm vitest run src/__tests__/integration/self-remove.test.ts` gives 1 failed (ENOENT on the archived 03.1-03 plan) and 1 passed.
- `git grep -n '\.planning' -- src` matches only line 92 of self-remove.test.ts.
- Current branch is `next` (not master), so direct commits are allowed.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Delete the three dead Phase 5 quality-gate scripts</name>
  <files>scripts/render-quality-gate.mjs, scripts/validate-quality-ci.mjs, scripts/validate-quality-dossiers.mjs</files>
  <action>
Per the locked user decision to delete all three, remove scripts/render-quality-gate.mjs, scripts/validate-quality-ci.mjs, and scripts/validate-quality-dossiers.mjs with git rm so the deletions are staged. Planner-verified: nothing in package.json scripts, .github workflows, docs, or tools/ references them. They only reference each other, so no other file needs editing.

Leave untouched (locked user decision): scripts/publish-nostr.sh, scripts/release-next.sh, the entire tools/quality-gate/ tree (the Rust probe crates stay because they regenerate the Rust-oracle fixtures when the MDK submodule moves), and the submodules ts-mls, refs/marmot, refs/mdk. Archived milestone documents mention these script names as history. They are frozen evidence, not live references, so do not edit them.

Commit only the three staged deletions. Pass the explicit paths and never use a bulk add (all or dot), which would sweep in planning artifacts the orchestrator commits separately. Commit subject: chore(scripts): delete dead Phase 5 quality-gate scripts. In the body, note that the scripts hardcoded the pre-archive Phase 5 directory and had no callers. End the message with the session attribution trailer.
  </action>
  <verify>
    <automated>test ! -e scripts/render-quality-gate.mjs && test ! -e scripts/validate-quality-ci.mjs && test ! -e scripts/validate-quality-dossiers.mjs && test -z "$(git ls-tree -r --name-only HEAD -- scripts | grep -E '(render|validate)-quality-')" && test -f scripts/publish-nostr.sh && test -f scripts/release-next.sh && git diff --quiet HEAD~1 HEAD -- . ':!scripts/render-quality-gate.mjs' ':!scripts/validate-quality-ci.mjs' ':!scripts/validate-quality-dossiers.mjs' && git diff --quiet HEAD -- tools scripts/publish-nostr.sh scripts/release-next.sh && ! git grep -qE '(render|validate)-quality-' -- . ':!.planning'</automated>
  </verify>
  <done>The three scripts are absent from the working tree and from the HEAD tree. The HEAD commit changes nothing except those three deletions. publish-nostr.sh, release-next.sh, and tools/quality-gate/ match HEAD. No tracked file outside the planning directory mentions any of the three script names.</done>
</task>

<task type="auto">
  <name>Task 2: Decouple self-remove.test.ts from the archived planning document</name>
  <files>src/__tests__/integration/self-remove.test.ts</files>
  <read_first>src/__tests__/integration/self-remove.test.ts (lines 1-100)</read_first>
  <action>
The test "keeps descriptor-less applied notification results explicit, including empty arrays" starts at line 77. Delete its trailing block on lines 91-97: the synchronous file read of the archived Phase 3.1 plan-03 document, plus the toContain assertion on the planning sentence it loads. That assertion checked planning prose rather than library behavior, and it now throws ENOENT on every runtime because the phase directory was archived.

Keep lines 78-89 exactly as they are: the IngestResult literal with kind appliedNotifications and an all-3s 32-byte commitDigest, the consumeApplied call, the toEqual on a digest of "03" repeated 32 times with an empty notifications array, and the not.toBeNull and toBeDefined checks on consumed notifications. Keep the test name unchanged. Do not delete, skip, or todo the test. Do not replace the removed block with a new fixture file, path lookup, or import of any planning or tools file.

Then delete the Node fs module import on line 16. Its only consumer was the removed block, and noUnusedLocals (inherited by the root tsconfig.json from tsconfig.build.json) fails the typecheck on an unused import. Leave every other import untouched. The applesauce types, the ts-mls symbols, bytesToHex, describe/expect/it, and the relative client/core/extra imports are all still used by the remaining tests.

Run the verify command. Then commit only this file, by explicit path. Commit subject: test(self-remove): drop assertion on archived planning document. End the message with the session attribution trailer. Husky/lint-staged will run Prettier on the staged file; that is expected.
  </action>
  <verify>
    <automated>pnpm vitest run src/__tests__/integration/self-remove.test.ts && pnpm compile && pnpm exec tsc -p tsconfig.json --noEmit && test -z "$(git grep -n '\.planning' -- src)" && ! grep -q 'readFileSync' src/__tests__/integration/self-remove.test.ts && grep -qF 'digest: "03".repeat(32)' src/__tests__/integration/self-remove.test.ts && grep -qF 'keeps descriptor-less applied notification results explicit, including empty arrays' src/__tests__/integration/self-remove.test.ts && grep -qF 'kind: "appliedNotifications"' src/__tests__/integration/self-remove.test.ts</automated>
  </verify>
  <done>self-remove.test.ts reports 2 passed and 0 failed. pnpm compile and the root noEmit typecheck both exit 0. git grep for the planning directory under src/ prints nothing. The appliedNotifications behavioral assertions and the test name are preserved. The commit touches only this one file.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| none (dev tooling + test code) | No runtime input, network, storage, or crypto path is touched. The change deletes uncalled maintainer scripts and removes a test's read of a repo-local document. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-dqr-01 | Repudiation | Phase 5 evidence regeneration (deleted scripts) | low | accept | Phase 5 evidence is already sealed and archived with the v1.0 milestone. Git history retains the scripts. tools/quality-gate/ Rust probe crates stay, so Rust-oracle fixture regeneration remains reproducible (Task 1 verify asserts tools/ is unchanged). |
| T-dqr-02 | Tampering | src/__tests__/integration/self-remove.test.ts (test integrity) | low | mitigate | Only the planning-prose assertion is removed. Task 2 verify positively greps the retained digest, test-name, and appliedNotifications assertions and requires the file to pass 2/2, so the behavioral coverage cannot be silently deleted. |
| T-dqr-03 | Denial of Service | CI test matrix (Node 20/22/24, Deno 2, Bun) | low | mitigate | Removing the cwd-relative read of an archived file eliminates the ENOENT failure on every runtime. Task 2 verify confirms no src/ file references the planning directory anymore. |
</threat_model>

<verification>
Run from the repo root after both tasks:
- `pnpm vitest run src/__tests__/integration/self-remove.test.ts`: Tests 2 passed (2)
- `pnpm compile`: exit 0
- `pnpm exec tsc -p tsconfig.json --noEmit`: exit 0 (this is the typecheck that includes tests; `pnpm compile` excludes them)
- `git grep -n '\.planning' -- src`: prints nothing
- `git log --oneline -2`: exactly the two task commits, in order (scripts deletion, then test decoupling)
- `git status --porcelain -- scripts src tools`: empty

Not a gate: `pnpm lint` has pre-existing noise from refs/mdk/target (logged in STATE.md blockers). The full `pnpm vitest run` suite has a pre-existing stale exports snapshot. Neither is in scope.
</verification>

<success_criteria>
- scripts/ contains only publish-nostr.sh and release-next.sh.
- tools/quality-gate/ is unchanged.
- self-remove.test.ts is green on its own and has no filesystem or planning-directory dependency.
- No file under src/ references the planning directory.
- The library build and the test-inclusive typecheck both pass.
- Two atomic code-only commits on `next`. No planning artifacts are staged in either commit.
</success_criteria>

## Source Coverage Audit

| Source | Item | Status |
|--------|------|--------|
| GOAL | Delete Phase 5 quality-gate scripts | COVERED: Task 1 |
| GOAL | Remove test dependencies on planning docs | COVERED: Task 2 |
| CONTEXT (orchestrator finding 2) | Delete all three scripts; keep tools/quality-gate/, publish-nostr.sh, release-next.sh | COVERED: Task 1 (action and verify) |
| CONTEXT (orchestrator finding 3) | Remove the file read and assertion on lines 91-97; keep lines 78-89; drop the unused fs import | COVERED: Task 2 |
| CONTEXT (orchestrator finding 4) | No other test coupling; refs/mdk vector reads stay | COVERED: objective scope and Task 2 src-wide grep gate |
| CONSTRAINT | Do not touch submodules; code-only atomic commits | COVERED: Task 1 and Task 2 actions |
| REQ | none (quick task, no REQUIREMENTS.md IDs) | n/a |
| RESEARCH | none (no research phase) | n/a |

<output>
Create `.planning/quick/260911-dqr-delete-phase-5-quality-gate-scripts-and-/260911-dqr-SUMMARY.md` when done
</output>
