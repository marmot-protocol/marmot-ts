# Agent Notes for marmot-ts

## Commands

- Use `pnpm` in this workspace; CI installs with pnpm 10 and `--frozen-lockfile`.
- `pnpm build` runs `rimraf ./dist` then `tsc -b tsconfig.build.json` for the library only.
- `pnpm compile` is the focused library typecheck/build step; `pnpm lint` is only `prettier --check .`.
- `pnpm test` starts Vitest watch mode. Use `pnpm vitest run` for a one-shot test run.
- Run one test file with `pnpm vitest run src/path/to/file.test.ts`; tests match only `src/**/*.test.ts`.
- Examples are a separate workspace package: `pnpm --filter examples build`, `pnpm --filter examples dev`, or root `pnpm dev`.
- Docs are VitePress: `pnpm docs:dev`, `pnpm docs:build`; `docs:build` also runs TypeDoc via `postdocs:build`.

## CI Expectations

- Test CI runs Vitest on Node 20/22/24, Deno 2 via `deno run -A --node-modules-dir=auto npm:vitest run`, and Bun latest/1.1 via `bun run vitest run`.
- Build CI runs `pnpm build` and `pnpm --filter examples build`; verify examples when changing public APIs or workspace exports.
- Pre-commit is Husky + lint-staged and only formats staged files with Prettier.

## Package Shape

- This is an ESM TypeScript library for Marmot (MLS over Nostr). Library source is under `src/`; examples live under `examples/` and consume the package as `workspace:*`.
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

## Docs And Release

- When adding a docs page under `docs/`, also add it to `.vitepress/config.ts`; VitePress uses `srcDir: "docs"`.
- TypeDoc reference is generated from `src/index.ts` into `.vitepress/dist/reference` using `typedoc.json` and `typedocs/cascade-category.mjs`.
- User-facing package changes should include a Changesets entry. `.changeset/config.json` ignores the `examples` package and targets `master` as the base branch.
