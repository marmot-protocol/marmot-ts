# Shelved: Quality Gate (was Phase 4 of milestone v1.0)

**Shelved:** 2026-07-21 — moved to backlog when milestone v1.0 was reset in favor of a different milestone.
**Original position:** Phase 4 of 4 (dark-matter single-device wire-complete).
**Depends on:** 999.5 (Wire / Conformance & Docs).
**Requirements:** QA-01, QA-02

## Goal

The full test suite passes on every supported runtime and every closure change with a byte-exact Rust
reference vector is verified against it — the milestone is shippable.

## Success Criteria

1. `pnpm vitest run` exits 0 on Node 20, Node 22, and Node 24.
2. `deno run -A --node-modules-dir=auto npm:vitest run` exits 0 on Deno 2.
3. `bun run vitest run` exits 0 on Bun latest and Bun 1.1.
4. Every closure change that has a byte-exact counterpart in `darkmatter/crates/` is cross-checked
   against the Rust reference output and the result documented in SPEC_GAP_REVIEW.md.

## To resume

`/gsd-review-backlog` to promote back into an active milestone, or `/gsd-discuss-phase 999.6`.
