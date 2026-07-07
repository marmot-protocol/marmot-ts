# Coding Conventions

**Analysis Date:** 2026-07-07

## Naming Patterns

**Files:**
- kebab-case throughout: `group-engine.ts`, `key-package-event-decode.ts`, `in-memory-key-value-store.ts`, `nip44-binary.ts`
- Helper/utility files use descriptive nouns or verb-noun pairs: `mock-network.ts`, `account-proof.ts`
- Test files mirror the source name with `.test.ts` suffix, placed under a sibling `__tests__/` directory

**Functions:**
- camelCase for all functions: `createGroup`, `generateKeyPackage`, `encodeVarint`, `decodeContent`, `signAccountIdentityProof`
- Async generator ingest pipelines are prefixed with an action verb: `ingestEnvelopes` (`src/engine/ingest.ts`)

**Variables:**
- camelCase everywhere: `clientState`, `adminPubkey`, `ciphersuiteImpl`
- Destructured option objects preserve camelCase from their type
- Native `#` private fields (not the TypeScript `private` keyword): `#state`, `#lifecycle`, `#retained`, `#subscribers` (see `src/engine/group-engine.ts`, `src/__tests__/helpers/mock-network.ts`)

**Types:**
- PascalCase: `MarmotGroupEngine`, `CreateGroupParams`, `SendResult`, `IngestResult`, `GroupPeeler`
- Generic type parameters: single uppercase letter or short PascalCase: `TEnvelope`, `T`
- Discriminated unions use a `kind` string-literal discriminant: `{ kind: "processed" | "skipped" | "rejected" | ... }`

**Constants:**
- Protocol-level constants: SCREAMING_SNAKE_CASE: `ADDRESSABLE_KEY_PACKAGE_KIND`, `MAX_VARINT`, `AGENT_TEXT_STREAM_ROLE_RECEIVE` (`src/core/protocol.ts`, `src/core/binary.ts`)
- Private module-level constants: SCREAMING_SNAKE_CASE: `ROLE_MASK`, `COMPONENT_STATE_LEN`, `ALLOWED_RUMOR_KEYS`
- Enum-like exported object namespaces: camelCase: `groupLifecycleStates`, `convergenceStatuses`, `inputCategories` (`src/core/group-lifecycle.ts`, `src/core/inbound.ts`)
- Test-file top-level constants: SCREAMING_SNAKE_CASE: `ADMIN`, `MEMBER`, `CIPHERSUITE`, `RELAY`

## Code Style

**Formatting:**
- Tool: Prettier 3.9.3
- Config: `.prettierrc` — `tabWidth: 2`, `useTabs: false` (all other options default)
- `pnpm lint` is `prettier --check .`; `pnpm format` is `prettier --write .`
- Pre-commit hook (Husky 9 + lint-staged 17) formats staged files only

**Linting:**
- No root ESLint config — the library relies on Prettier plus the strict TypeScript compiler
- The `ts-mls` subpackage has its own `eslint.config.mjs`
- TypeScript strict mode enforces `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, all `noImplicit*`; the build fails on any violation

## Import Organization

**Order (observed, not enforced by a tool):**
1. External type-only imports and third-party packages (`applesauce-core`, `ts-mls`, `@noble/*`)
2. Local relative imports with the emitted `.js` extension

**Path conventions:**
- All relative imports in `src/` MUST use the emitted `.js` extension even when importing a `.ts` file (NodeNext module resolution). Violating this breaks the build.
- `import type { ... }` is used for type-only imports (e.g. `import type { NostrEvent } from "applesauce-core/helpers/event"`)
- No path aliases; plain relative paths only
- Hex encoding/decoding via `@noble/hashes/utils.js`: `bytesToHex`, `hexToBytes`
- No `Buffer` usage anywhere (must stay runtime-agnostic for Deno and Bun)

## Error Handling

- Throw `new Error(message)` for domain/validation failures: wrong credential type, invalid binary encoding, missing required state
- Custom error subclasses for codec failures: `BinaryDecodeError` in `src/core/binary.ts` subclasses `Error` and sets `this.name`
- Result types (discriminated unions via `kind`) for expected multi-outcome flows rather than try/catch at the caller boundary — e.g. `ingestEnvelopes()` emits `unreadable`/`rejected`/`skipped` rather than throwing
- `transitionLifecycle()` (`src/core/group-lifecycle.ts`) throws on illegal FSM transitions
- Tree/audit subsystems swallow their own errors so they never break protocol processing: `GroupHistoryTree.recordCommit()` logs rather than propagates; `AuditEmitter.emit()` catches and silences
- Async errors propagate as rejected Promises; tests assert with `await expect(...).rejects.toThrow(...)`

## Logging

**Framework:** `debug` ^4.4.3, wrapped in `src/utils/debug.ts`

**Patterns:**
- Scoped namespaces under `marmot:*`
- Module-level, read-only; no global mutable state

## Comments

**When to comment:**
- Doc comments on exported functions and non-obvious helpers explaining protocol intent (see `src/__tests__/helpers/account-proof.ts`)
- Inline comments in tests cite spec worked examples (see `src/core/__tests__/binary.test.ts`)

**JSDoc/TSDoc tags in use:**
- `@param name - description`
- `@returns description`
- `@throws description of what triggers it`
- `@see cross-reference to a spec doc`
- `{@link Symbol}` for cross-references

## Function Design

- `Promise<T>` for async operations
- `AsyncGenerator<IngestResult<TEnvelope>>` for streaming ingest pipelines; callers MUST fully drain the generator before the next batch
- Discriminated unions for multi-outcome results — never `null | result`
- Options passed as a single destructured object preserving camelCase field names

## Module Design

- Named exports only — no default exports anywhere in `src/`
- Each major directory has an `index.ts` barrel that re-exports with `export * from "./module.js"`: `src/core/index.ts`, `src/client/index.ts`, `src/engine/index.ts`
- `src/index.ts` aggregates client, core, utils, and selected engine exports; deep engine internals are reached via the `./engine` subpath
- `src/mls.ts` intentionally re-exports `ts-mls` for downstream apps via the `./mls` subpath
- All binary/protocol data is `Uint8Array`

## Discriminated Union Pattern

Multi-outcome results are modeled as tagged unions keyed on a `kind` literal:

```typescript
type IngestResult<T> =
  | { kind: "processed"; ... }
  | { kind: "skipped"; ... }
  | { kind: "rejected"; ... }
  | { kind: "unreadable"; ... };
```

Callers switch on `result.kind` rather than catching exceptions. This is the canonical pattern for the ingest pipeline, convergence status, and lifecycle results.

---

*Convention analysis: 2026-07-07*
