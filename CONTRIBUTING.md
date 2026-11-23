# Contributing to @internet-privacy/marmot-ts

Thank you for your interest in contributing to marmot-ts! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 20 or newer
- pnpm 10
- TypeScript (installed at the lockfile version via devDependencies)
- Git

### Setting Up Your Development Environment

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/marmot-ts.git
   cd marmot-ts
   ```
3. Install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   ```
4. Create a new branch for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Available Scripts

- `pnpm check` - Check formatting, types, tests, and build before a PR
- `pnpm build` - Clean, build the MLS fork, compile the library, and vendor the fork
- `pnpm clean` - Remove the dist directory
- `pnpm compile` - Compile production TypeScript files
- `pnpm test` - Run Vitest in watch mode
- `pnpm vitest run` - Run the runtime test suite once
- `pnpm conformance` - Run all conformance tests and save campaign evidence
- `pnpm typecheck:tests` - Strictly typecheck all source, test, and helper TypeScript without emitting files
- `pnpm format` / `pnpm lint` - Format code / check formatting with Prettier
- `pnpm prepare` - Build the workspace MLS fork (also runs during installation)

### Making Changes

Use `pnpm test` while working, or run a focused test:

```bash
pnpm vitest run src/path/file.test.ts
```

Before opening a PR, run:

```bash
pnpm check
```

This checks formatting, TypeScript (including tests), runtime and conformance tests, and the
build. Use `pnpm format` to fix formatting. Add or update tests when they protect
meaningful behavior; retire temporary migration checks when they stop being useful.

CI also runs runtime and conformance tests on supported Node, Bun, and Deno versions,
and packaging/release script tests. Run `pnpm conformance`
locally when changing protocol behavior, and `pnpm docs:build` when changing docs.
The release commands verify the packed tarball before publishing; there is no
separate consumer smoke harness to run.

## Changelog

For each user-visible library change, add a short description to `## Unreleased` in
`CHANGELOG.md`. Describe what library users can do or what now works better. Group
entries under Added, Changed, Fixed, or Breaking changes as appropriate, and include
migration guidance for breaking changes. Internal-only maintenance does not need an entry.

## Releases

Configure the npm package's GitHub trusted publisher for `marmot-protocol/marmot-ts`,
workflow `release.yml`, and environment `npm`. Direct publishing is not needed: the
release workflow authenticates through OIDC and stages the publish with
`npm stage publish`, so no npm token secret is needed.

1. Move the Unreleased entries into a section named for the release version and leave
   an empty `## Unreleased` section for future changes.
2. Update the root `package.json` version and run `pnpm install --lockfile-only`.
3. Run `pnpm check` and ensure CI passes.
4. Commit the release metadata through a PR and merge it into `master`.
5. Tag the merged commit as `v<version>` (for example, `v0.6.0`) and push the tag.
   The release workflow verifies the version and changelog, stages the library on
   npm with provenance, and creates a GitHub release from those notes. Each step is
   skipped when its result already exists (the version is on npm, or the GitHub
   release exists), so re-pushing a tag or re-running the workflow does not
   republish or duplicate a release.
6. Approve the staged package on npmjs.com (package → Staged Packages → Approve) or
   with `npm stage approve <stage-id>`; either asks for 2FA. The version is not live
   on npm until it is approved.
7. Mark the release on Nostr with `ngit release publish <version> --tag v<version>`.
   The manifest at `.ngit/release.yaml` holds the application identity, reads the
   notes for the version from `CHANGELOG.md`, and links the version's npm tarball
   as a platform-agnostic URL asset (nothing is uploaded to Blossom).

`pnpm release` publishes the root library package locally; it does not publish
workspace packages. `pnpm release-next` continues to publish temporary prereleases
from the tip of `origin/master`. Log in with `npm login` first. The script builds
and verifies the root package tarball, then publishes that exact tarball under
`next` (for example, `0.6.1-next.20261007211500`), leaving `latest` unchanged.
The original package manifest and lockfile are restored on success or failure.
Run `node --test scripts/__tests__/release-next.test.mjs` to check the release
flow without publishing.
