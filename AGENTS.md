# Repository Guidelines

## Project Structure

marmot-ts is an ESM TypeScript library for Marmot (MLS over Nostr).

- `src/core/`: protocol and crypto; no I/O.
- `src/engine/`: transport-independent group state machine.
- `src/client/`: Nostr networking, storage, and client APIs.
- `src/audit/`, `src/extra/`, `src/utils/`: audit logging, optional stores, and utilities.
- `ts-mls/`: MLS fork, vendored into `dist/` during builds.
- `docs/`, `examples/`: VitePress documentation and sample apps.

Public entrypoints are defined in `package.json` exports. Keep dependencies flowing `utils → core → engine → client`; fully drain `ingest()` generators before another batch.

## Development Commands

Use pnpm 10 and Node.js 20+.

- `pnpm install --frozen-lockfile`: install dependencies.
- `pnpm build`: clean, build the MLS fork, compile, and vendor.
- `pnpm compile`: focused library compilation.
- `pnpm vitest run`: run tests once; `pnpm test` starts watch mode.
- `pnpm conformance`: run the complete conformance suite and save campaign evidence.
- `pnpm format` / `pnpm lint`: Prettier formatting/checking.
- `pnpm docs:dev` / `pnpm docs:build`: serve/build docs and API reference.
- `pnpm check`: formatting, types, runtime and conformance tests, and build before a PR.

## Coding and Testing

Use two-space indentation, kebab-case filenames, camelCase functions, PascalCase types, and named exports. NodeNext relative imports require `.js` extensions. Strict TypeScript rejects unused declarations and missing returns.

Use `Uint8Array`, not `Buffer`; preserve Node, Bun, and Deno compatibility. Import the fork through bare `ts-mls`; its imports must have declared dependencies or peers.

Vitest discovers `src/**/*.test.ts`. Colocate tests in `__tests__/`; reuse `src/__tests__/helpers` and mock networking. Run a focused test with `pnpm vitest run src/path/file.test.ts`.

Do not write or run automated tests for `examples/demos/`, including its app,
services, and individual demos. The demo app is a simple, readable demonstration
of the public library APIs, not a test suite. Keep automated behavior coverage in
the library; do not add demo abstractions or infrastructure to support testing.

## Protocol References

At every phase start, fetch `origin` in both `refs/marmot` and `refs/mdk`; inspect `HEAD..origin/HEAD`, review relevant diffs, fast-forward, and commit pointer updates separately as `chore(refs):`.

Check MDK before implementing convergence, recovery, or wire encoding; record deviations. Cite topic-based spec paths; MIP numbering is deprecated.

## Contributions and Agent Workflow

- `next` is the fast-iteration branch: work and commit directly on it, stacking coherent changes without creating a feature branch for each task. Multiple agents may work on `next` concurrently; coordinate overlapping edits, stage only your own changes, and preserve other agents' in-progress work.
- `master` represents the current working state of the library. When starting a feature from `master`, create a feature branch before making changes. Merge that feature branch back into `master` only after confirming the feature works and its behavior and implementation are satisfactory. Never commit feature work directly on `master`.
- On other branches, start development on the current branch; creating another feature branch is not required.

Use focused conventional commits (`fix:`, `feat:`, `docs:`, `chore:`) after relevant checks pass. PRs should explain behavior, link related issues, and report validation.

Commit each significant, coherent change after its relevant checks pass, without waiting for the user to request a commit. Stage only your own changes; preserve unrelated or concurrent work. Report the commit hashes and validation results, including any checks blocked by unrelated changes. Do not push unless requested.

For every user-visible library change, add a short customer-facing description under
`## Unreleased` in `CHANGELOG.md`. Describe the behavior or benefit, and call out
breaking changes with migration guidance.

Add new docs pages to `.vitepress/config.ts`. Use `.agents/skills/applesauce/` for Nostr work and `.agents/skills/opentui/` for terminal UIs.

Use focused checks while developing and `pnpm check` before a PR. Add tests for meaningful library behavior, not the demos app; retire temporary migration and planning checks when they no longer serve the library. Use GSD workflows when requested or when the task benefits from planning; routine changes do not require planning artifacts.

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.

<!-- GSD:profile-end -->
