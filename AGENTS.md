# Agent Notes for marmot-ts

## Commands

- Use `pnpm` in this workspace; CI installs with pnpm 10 and `--frozen-lockfile`.
- `pnpm build` runs `rimraf ./dist` then `tsc -b tsconfig.build.json` for the library only.
- `pnpm compile` is the focused library typecheck/build step; `pnpm lint` is only `prettier --check .`.
- `pnpm test` starts Vitest watch mode. Use `pnpm vitest run` for a one-shot test run.
- Run one test file with `pnpm vitest run src/path/to/file.test.ts`; tests match only `src/**/*.test.ts`.
- Docs are VitePress: `pnpm docs:dev`, `pnpm docs:build`; `docs:build` also runs TypeDoc via `postdocs:build`.

## CI Expectations

- Test CI runs Vitest on Node 20/22/24, Deno 2 via `deno run -A --node-modules-dir=auto npm:vitest run`, and Bun latest/1.1 via `bun run vitest run`.
- Build CI runs `pnpm build`.
- Pre-commit is Husky + lint-staged and only formats staged files with Prettier.

## Package Shape

- This is an ESM TypeScript library for Marmot (MLS over Nostr). Library source is under `src/`.
- Public entrypoints are controlled by `package.json` `exports`: `.`, `./client`, `./core`, `./extra`, `./utils`, and `./mls`.
- `src/index.ts` re-exports client/core/utils only. Extra utilities are exposed through `@internet-privacy/marmot-ts/extra`.
- `src/mls.ts` intentionally re-exports `ts-mls` for downstream apps through the `./mls` subpath.
- Main architecture split: `src/core` is protocol/crypto/state logic with no app I/O; `src/client` adds storage, network, lifecycle, groups, invites, and event-oriented APIs; `src/extra` contains optional store implementations.

## TypeScript Gotchas

- Library TS uses `module`/`moduleResolution: NodeNext`; all relative imports in `src` need the emitted `.js` extension, even when importing `.ts` files.
- Build config is strict and fails on unused locals/parameters and missing returns; tests are excluded from `tsconfig.build.json` but included by root `tsconfig.json` with `noEmit`.
- Use named exports; existing source has no default exports.
- Binary/protocol data is represented with `Uint8Array`; Nostr/MLS helpers commonly use hex conversion from `@noble/hashes/utils.js`.

## Tests

- Tests are colocated under `src/**/__tests__` plus integration tests in `src/__tests__/integration`.
- Shared test doubles live in `src/__tests__/helpers`; prefer those over inline mocks for network/client flows.
- Integration tests use in-memory stores and mock Nostr networking, not external relays or services.

## Docs

- When adding a docs page under `docs/`, also add it to `.vitepress/config.ts`; VitePress uses `srcDir: "docs"`.
- TypeDoc reference is generated from `src/index.ts` into `.vitepress/dist/reference` using `typedoc.json` and `typedocs/cascade-category.mjs`.

## Git Workflow

- Commit after finishing a feature, once it builds and its tests pass; keep each feature in its own commit rather than batching unrelated work.
- Include any matching changeset (see below) in the same commit as the feature it describes.
- Do not commit on the `master` branch; branch first when needed.

## Changesets

- Add a changeset for user-facing library changes while the PR context is fresh; skip for docs-only, tests-only, and internal refactors with no package behavior/API impact.
- Create one with `pnpm changeset` or add `.changeset/<unique-name>.md` manually; this repo publishes only `@internet-privacy/marmot-ts`.
- Use `patch` for fixes/internal behavior changes, `minor` for new backward-compatible APIs/features, and `major` for breaking API or behavior changes.
- Each changeset body must be one sentence describing one user-facing change; if a PR has multiple user-facing changes, add multiple changesets.
- Do not use markdown lists or tables in changeset bodies.
- Manual changeset shape:

```md
---
"@internet-privacy/marmot-ts": patch
---

Describe the user-facing change in one sentence.
```

- Never publish packages locally; all package releases must happen from the GitHub Changesets workflow on `master`.
