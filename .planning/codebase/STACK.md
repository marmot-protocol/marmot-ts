# Technology Stack

**Analysis Date:** 2026-07-01

## Languages

**Primary:**
- TypeScript 6.0.3 — all library source under `src/`, strict mode, `module: NodeNext`

**Secondary:**
- Shell — `scripts/publish-nostr.sh` (release notification)

## Runtime

**Environment:**
- Node.js >=20.0.0 (primary target; tested on 20.x, 22.x, 24.x in CI)
- Bun >=1.1.0 (supported; tested on latest and 1.1 in CI)
- Deno >=2.0.0 (supported; tested via `deno run -A --node-modules-dir=auto npm:vitest run` in CI)

**Package Manager:**
- pnpm 10
- Lockfile: `pnpm-lock.yaml` present; CI always runs with `--frozen-lockfile`

## Frameworks

**Core:**
- None (pure ESM TypeScript library; no web or server framework)

**Testing:**
- Vitest 3.2.6 — config at `vitest.config.ts`; environment: `node`; matches `src/**/*.test.ts`

**Docs:**
- VitePress 2.0.0-alpha.17 — `docs/` as source; built to `.vitepress/dist`
- TypeDoc 0.28.19 — generates API reference from `src/index.ts` into `.vitepress/dist/reference`

**Build/Dev:**
- TypeScript compiler (`tsc`) — `tsconfig.build.json` for library emit; `tsconfig.json` for type-checking (includes tests, `noEmit`)
- rimraf ~6.0.1 — cleans `dist/` before build

**Code Quality:**
- Prettier 3.9.3 — formatting; config at `.prettierrc` (2-space indent, spaces not tabs)
- Husky 9.1.7 + lint-staged 17.0.8 — pre-commit hook formats staged files only

**Release:**
- @changesets/cli 2.31.0 — changelog management; config at `.changeset/config.json`; publishes with npm provenance (`changeset publish --provenance`)

## Key Dependencies

**Core Protocol:**
- `ts-mls` (workspace `./ts-mls`, v2.0.0-rc.14) — MLS RFC 9420 implementation; the foundational cryptographic group protocol engine
- `@hpke/core` ^1.9.0 — Hybrid Public Key Encryption (HPKE); used by ts-mls and directly for key encapsulation
- `@noble/ciphers` ^2.2.0 — ChaCha20-Poly1305 (`src/utils/nip44-binary.ts`), AES (`src/core/`)
- `@noble/curves` ^2.2.0 — secp256k1 ECDH and signing (`src/utils/nip44-binary.ts`, credential derivation)
- `@noble/hashes` ^2.2.0 — SHA-256, HKDF, HMAC, PBKDF2 (`src/utils/`, `src/core/`)
- `@scure/base` ^2.2.0 — base64/hex encoding utilities

**Nostr Ecosystem:**
- `applesauce-core` ^6.2.0 — Nostr event model, event store, helpers; provides `NostrEvent`, `Filter`, key helpers
- `applesauce-common` ^6.2.0 — gift-wrap (NIP-59) factories and helpers; used in welcome delivery

**Utilities:**
- `debug` ^4.4.3 — scoped debug logging throughout library
- `eventemitter3` ^5.0.4 — EventEmitter used in client layer

**Dev-Only Critical:**
- `applesauce-accounts` ^6.2.0 — `PrivateKeyAccount` used in all integration and client tests; not a runtime dependency of the library itself

## Workspace Layout

The pnpm workspace (`pnpm-workspace.yaml`) includes:
- `.` — the main library (`@internet-privacy/marmot-ts`)
- `ts-mls` — local MLS implementation (submodule / nested package)
- `examples/*` — example applications (`opentui`, `forker`, `tunnels`)

The `darkmatter/integrations/openclaw/marmot/` directory has its own `package.json` but is not in the workspace packages list.

## TypeScript Configuration

**Build config** (`tsconfig.build.json`):
- Target: `ES2022`
- Module/ModuleResolution: `NodeNext` (requires `.js` extension on all relative imports in `src/`)
- Strict: all `noImplicit*`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitReturns`
- Output: `dist/` with declarations and source maps
- Excludes: test files and `__tests__` directories

**Root config** (`tsconfig.json`):
- Extends `tsconfig.build.json`
- Adds `noEmit: true`; includes `src` and `__tests__`; types: `vitest`, `vitest/globals`, `node`

## Public Entrypoints

Controlled by `exports` in `package.json`:
- `.` → `dist/index.js` — re-exports client + core + utils + engine surface
- `./mls` → `dist/mls.js` — re-exports `ts-mls` for downstream apps
- `./client` → `dist/client/index.js`
- `./core` → `dist/core/index.js`
- `./engine` → `dist/engine/index.js`
- `./audit` → `dist/audit/index.js`
- `./extra` → `dist/extra/index.js`
- `./extra/audit/node` → `dist/extra/audit/node.js`
- `./extra/audit/browser` → `dist/extra/audit/browser.js`
- `./utils` → `dist/utils/index.js`

## Configuration

**Environment:**
- No `.env` files present in repo
- Required secrets are injected via GitHub Actions environment variables (`NPM_TOKEN`, `NOSTR_KEY`, `GITHUB_TOKEN`)

**Build:**
- `tsconfig.build.json` — TypeScript emit config
- `typedoc.json` — TypeDoc reference generation
- `vitest.config.ts` — test runner config

## Platform Requirements

**Development:**
- Node.js 20+ with pnpm 10

**Production:**
- Runtime-agnostic ESM library (Node.js 20+, Bun 1.1+, Deno 2+)
- Published to npm as `@internet-privacy/marmot-ts` with public access

---

*Stack analysis: 2026-07-01*
