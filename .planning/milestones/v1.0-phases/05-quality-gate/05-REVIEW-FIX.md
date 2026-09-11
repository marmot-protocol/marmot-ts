---
phase: 05-quality-gate
fixed_at: 2026-09-06T19:46:00Z
review_path: .planning/phases/05-quality-gate/05-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 5: Code Review Fix Report

**Fixed at:** 2026-09-06T19:46:00Z
**Source review:** `.planning/phases/05-quality-gate/05-REVIEW.md`
**Iteration:** 1

**Summary:**

- Findings in scope: 4
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: CI validator trusts fabricated JSON instead of authenticating the run and parsing logs

**Files modified:** `scripts/validate-quality-ci.mjs`, `.planning/phases/05-quality-gate/05-CI-EVIDENCE.json`
**Commit:** 91dfe8f
**Applied fix:** Authenticated the immutable run and each job through the GitHub API, downloaded and SHA-256-bound every job log, parsed exact runtime/pnpm/Vitest versions, frozen-install commands, suite commands, and normal/extended counts, and added 66 adversarial mutations. Fixed; validation logic requires human verification.

### CR-02: Dossier validator validates declarations, not provenance or reproduced results

**Files modified:** `scripts/validate-quality-dossiers.mjs`, `.planning/phases/05-quality-gate/05-DOSSIER-SCHEMA.json`
**Commits:** 1aaeafe, 7a71aa5, 168355e
**Applied fix:** Recomputed lockfile and fixture digests from the tested commit, verified all oracle blobs and reviewed independent paths, and replayed in a detached worktree. The strengthened replay runs every positive assertion in each complete parity test file before executing its negative control separately. Exact commands, Node/pnpm/Cargo/rustc/Vitest versions, derived result tuples, and result digests are mechanically bound; 104 command/version/result/provenance tampering cases are rejected. Replay paths now resolve through an absolute shared repository root, create temporary worktrees on the workspace filesystem, and reuse stable absolute Cargo targets instead of consuming `/tmp`; the path regression is included in self-test. Fixed; validation logic requires human verification.

### CR-03: Tag-cardinality negative control never exercises parity or shipping code

**Files modified:** `src/core/__tests__/key-package-tag-parity.test.ts`
**Commit:** b8e2feb
**Applied fix:** Routed a mutated Rust tag oracle through `createKeyPackageEvent` and asserted the production parity comparison rejects it. Fixed; requires human verification.

### WR-01: Deno bypasses the frozen dependency graph for Vitest

**Files modified:** `.github/workflows/tests.yml`
**Commit:** 78ea437
**Applied fix:** Pinned both Deno suites and the reported runner version to `npm:vitest@3.2.6`, matching the workspace lockfile.

## Verification

- `pnpm compile`: PASS
- `pnpm build`: PASS
- `pnpm vitest run`: PASS — 96 files, 964 tests
- `pnpm conformance:extended`: PASS — 1 file, 1 test
- Dossier replay at `7a71aa56299e7f4e541f0f71a9ff392896c50243`: PASS — four frozen, detached, locked Rust generators; all four full parity files (2 + 5 + 57 + 4 positive/negative assertions) and separately selected negative controls
- Dossier adversarial self-test: PASS — 104 plausible provenance, command, version, result, and digest mutations rejected
- Hosted runtime matrix: PASS — run `34057379785`, all six immutable jobs completed successfully at `7a71aa56299e7f4e541f0f71a9ff392896c50243`
- CI evidence validation: PASS — authenticated run/job API facts and six SHA-256-bound logs
- CI adversarial self-test: PASS — 66 fabricated runtime, pnpm, Vitest, command, digest, and suite-count claims rejected
- Default dossier replay without `TMPDIR`: PASS — workspace-backed temporary worktree and stable shared Cargo caches
- Machine evidence rendering: PASS — `scripts/render-quality-gate.mjs --check` proves `05-QUALITY-GATE.md` and `05-08-SUMMARY.md` derive from current CI/dossier evidence (`e7e267c`)

## Hosted CI Checkpoint

The final tested-source candidate `7a71aa56299e7f4e541f0f71a9ff392896c50243` was pushed with explicit approval to `quality-gate-tested-7a71aa5`. Tests run `34057379785` passed all six rows. The authenticated, SHA-256-bound CI evidence and both hardened validator self-tests pass. No further external mutation is authorized without new explicit user approval.

---

_Fixed: 2026-09-06T19:46:00Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
