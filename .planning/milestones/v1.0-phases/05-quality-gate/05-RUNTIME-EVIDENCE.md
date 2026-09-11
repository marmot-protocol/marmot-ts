# Phase 5 Runtime Smoke Evidence

> Local results in this document are **SMOKE evidence only**. The GitHub Actions
> six-runtime matrix is the release authority. No result is inferred for a runtime
> version that was not installed and executed locally.

## Provenance

| Field | Value |
| --- | --- |
| Captured (UTC) | `2026-09-06T18:09:37Z` |
| Superproject | `d425bac0d59fd2f0768f234107274835c9b7dfbc` |
| Marmot specification | `4a2bc65f8db5866cec3b2a127dedb37818eaf207` |
| MDK reference | `dbf45c83a8e157302edd13010944ad2c6a9cf9a5` |
| Local pnpm | `12.3.4` |
| CI dependency contract | `pnpm/action-setup@v4`, `version: 10`, then `pnpm install --frozen-lockfile` |
| Local dependency install | Not rerun; smoke commands used the existing workspace installation. Local pnpm is not claimed to be pnpm 10. |

The normal suite contained 92 test files and 896 passing tests. The isolated
extended suite contained 1 test file and 1 passing test. Counts were stable
across the three locally available runtime executions.

## Available Runtime Smoke Results

| Evidence | Exact resolved runtime | Command | Exit | Test files | Tests | Wall duration |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| SMOKE | Node `v22.23.1`; pnpm `12.3.4`; Vitest `3.2.6` | `pnpm vitest run` | 0 | 92 passed | 896 passed | 27s |
| SMOKE | Node `v22.23.1`; pnpm `12.3.4`; Vitest `3.2.6` | `pnpm conformance:extended` | 0 | 1 passed | 1 passed | 3s |
| SMOKE | Deno `2.9.4` (`v8 15.0.245.2-rusty`, TypeScript `6.0.3`); pnpm `12.3.4`; npm Vitest `3.2.7` | `deno run -A --node-modules-dir=auto npm:vitest run` | 0 | 92 passed | 896 passed | 28s |
| SMOKE | Deno `2.9.4` (`v8 15.0.245.2-rusty`, TypeScript `6.0.3`); pnpm `12.3.4`; npm Vitest `3.2.7` | `deno run -A --node-modules-dir=auto npm:vitest run --config vitest.extended.config.ts` | 0 | 1 passed | 1 passed | 5s |
| SMOKE | Bun `1.3.14`, revision `1.3.14+0d9b296af`; pnpm `12.3.4`; Vitest `3.2.7` | `bun run vitest run` | 0 | 92 passed | 896 passed | 25s |
| SMOKE | Bun `1.3.14`, revision `1.3.14+0d9b296af`; pnpm `12.3.4`; Vitest `3.2.7` | `bun run vitest run --config vitest.extended.config.ts` | 0 | 1 passed | 1 passed | 3s |

The Deno command populated its runtime cache and generated an untracked
`deno.lock`; that generated file was removed and is not part of the evidence or
repository state.

## Locally Unavailable Matrix Rows

| CI row | Local status | Required authority |
| --- | --- | --- |
| Node 20.x | **UNAVAILABLE LOCALLY — NOT RUN** | GitHub Actions `test-node` matrix |
| Node 24.x | **UNAVAILABLE LOCALLY — NOT RUN** | GitHub Actions `test-node` matrix |
| Bun 1.1 | **UNAVAILABLE LOCALLY — NOT RUN** | GitHub Actions `test-bun` matrix |

Deno is declared as `v2.x` and Bun as `latest` in CI. Their exact resolved CI
versions must come from the workflow's version-reporting steps; these local
versions do not substitute for those CI records.

## Separate Local Gates

| Gate | Command | Exit | Result | Wall duration | Detail |
| --- | --- | ---: | --- | ---: | --- |
| TypeScript emit | `pnpm compile` | 0 | PASS | <1s | `tsc -b tsconfig.build.json` completed. |
| Clean library build | `pnpm build` | 0 | PASS | 5s | `rimraf ./dist` followed by the focused compile completed. |
| Formatting check | `pnpm lint` | 1 | FAIL | 9s | Prettier reported 9 existing unformatted files; this formatting-only gate is not described as semantic linting. |

The formatting failure is recorded rather than repaired here because Plan 05-01
only changes the CI workflow and this evidence file. Its nine reported files are
outside this plan's task scope.

## CI Release Contract

The workflow at `.github/workflows/tests.yml` defines all six authoritative rows:
Node 20.x/22.x/24.x, Deno v2.x, and Bun latest/1.1. Every job family reports its
resolved runtime plus pnpm version, installs through pinned pnpm 10 with the
frozen lockfile, and runs both the normal and isolated extended configuration.
CI job URLs and conclusions are intentionally absent until GitHub Actions has
executed this revision; local smoke results are not promoted into CI evidence.
