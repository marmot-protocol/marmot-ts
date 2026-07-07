# Technology Stack

**Analysis Date:** 2026-07-07

## Languages

**Primary:**
- TypeScript `~6.0.3` - All library source under `src/`, strict mode, ESM, `module`/`moduleResolution: NodeNext`. Requires emitted `.js` extensions on all relative imports.

**Secondary:**
- Shell (bash) - Release automation: `scripts/release-next.sh`, `scripts/publish-nostr.sh`

## Runtime

**Environment:**
- Node.js `>=20.0.0` - Primary target; CI tests on 20.x, 22.x, 24.x (`.github/workflows/tests.yml`)
- Bun `>=1.1.0` - Supported; CI tests latest and 1.1
- Deno `>=2.0.0` - Supported; CI tests via `deno run -A --node-modules-dir=auto npm:vitest run`
- Runtime-agnostic: no `Buffer`, no runtime-specific APIs (stays portable across Node/Bun/Deno)

**Package Manager:**
- pnpm 10 - Workspace with nested package `ts-mls`
- Lockfile: `pnpm-lock.yaml` present; CI installs with `--frozen-lockfile`

## Frameworks

**Core:**
- None - Pure ESM TypeScript library; no web or server framework

**Testing:**
- Vitest `^3.2.6` - Config at `vitest.config.ts`; environment `node`; matches `src/**/*.test.ts`. Run one-shot with `pnpm vitest run`

**Build/Dev:**
- TypeScript compiler (`tsc`) - `tsconfig.build.json` for library emit; `tsconfig.json` (`noEmit`, includes tests) for type-checking
- rimraf `~6.0.1` - Cleans `dist/` before build (`pnpm clean`)
- Prettier `^3.9.3` - Formatting; config `.prettierrc` (2-space indent, no tabs). `pnpm lint` is prettier-only (`prettier --check .`)
- Husky `^9.1.7` + lint-staged `^17.0.8` - Pre-commit hook formats staged files only
- @changesets/cli `^2.31.0` - Changelog/versioning; config `.changeset/config.json`; publishes with npm provenance (`changeset publish --provenance`)
- VitePress `2.0.0-alpha.17` - Docs site; `docs/` source built to `.vitepress/dist`
- TypeDoc `^0.28.19` - API reference generated from `src/index.ts` into `.vitepress/dist/reference` (config `typedoc.json`)

## Key Dependencies

**Critical:**
- `ts-mls` `2.0.0-rc.14` (local workspace `./ts-mls`) - MLS RFC 9420 implementation; the foundational cryptographic group protocol engine. Must be built before the library (`pnpm --filter ts-mls build`, run by `prepare`)
- `@hpke/core` `^1.9.0` - Hybrid Public Key Encryption (HPKE); key encapsulation used by ts-mls and directly
- `applesauce-core` `^6.2.0` - Nostr event model, `NostrEvent`, `Filter`, event/key helpers
- `applesauce-common` `^6.2.0` - Gift-wrap (NIP-59) factories/helpers; used in welcome delivery

**Cryptography:**
- `@noble/ciphers` `^2.2.0` - ChaCha20-Poly1305 (`src/utils/nip44-binary.ts`), AES
- `@noble/curves` `^2.2.0` - secp256k1 ECDH and signing (`src/utils/nip44-binary.ts`, credential derivation)
- `@noble/hashes` `^2.2.0` - SHA-256, HKDF, HMAC, PBKDF2; hex conversion via `@noble/hashes/utils.js`
- `@scure/base` `^2.2.0` - base64/hex encoding utilities

**Infrastructure:**
- `debug` `^4.4.3` - Scoped debug logging (`marmot:*` namespace) throughout the library
- `eventemitter3` `^5.0.4` - EventEmitter used in client layer

**Dev-only (not runtime deps):**
- `applesauce-accounts` `^6.2.0` - `PrivateKeyAccount` used in integration/client tests only
- `@types/node` `^24.13.2`, `@types/debug` `^4.1.13`

## Configuration

**Environment:**
- No `.env` files present in the repo
- Release secrets injected via GitHub Actions environment variables: `NPM_TOKEN`, `NOSTR_KEY`, `GITHUB_TOKEN`
- No `.nvmrc`; Node version enforced via `engines` field in `package.json`

**Build:**
- `tsconfig.build.json` - Library emit config (target `ES2022`, `NodeNext`, strict, `dist/` with declarations + source maps, excludes tests)
- `tsconfig.json` - Extends build config; adds `noEmit`, includes `src` + `__tests__`, types `vitest`/`vitest/globals`/`node`
- `vitest.config.ts` - Test runner config
- `typedoc.json` - Reference generation
- `.changeset/config.json` - Versioning (baseBranch `master`, public access)

## Platform Requirements

**Development:**
- Node.js 20+ with pnpm 10
- `ts-mls` local workspace must build first

**Production:**
- Runtime-agnostic ESM library (Node.js 20+, Bun 1.1+, Deno 2+)
- Published to npm as `@internet-privacy/marmot-ts` (version `0.6.0`), public access, with npm provenance

---

*Stack analysis: 2026-07-07*
