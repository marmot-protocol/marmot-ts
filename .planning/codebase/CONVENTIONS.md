# Coding Conventions

**Analysis Date:** 2026-07-01

## Naming Patterns

**Files:**
- kebab-case throughout: `group-engine.ts`, `key-package-event-decode.ts`, `in-memory-key-value-store.ts`
- Test files: same name with `.test.ts` suffix, placed under `__tests__/` sibling directories
- Helper/utility files: descriptive nouns or verb-noun pairs: `mock-network.ts`, `account-proof.ts`

**Functions:**
- camelCase for all functions: `createGroup`, `generateKeyPackage`, `encodeVarint`, `decodeContent`
- Async generator functions (ingest pipelines): prefixed with action verb, e.g., `ingestEnvelopes` in `src/engine/ingest.ts`

**Variables and Parameters:**
- camelCase everywhere: `clientState`, `adminPubkey`, `ciphersuiteImpl`
- Destructured option objects preserve camelCase from the type

**Types and Interfaces:**
- PascalCase: `MarmotGroupEngine`, `CreateGroupParams`, `SendResult`, `IngestResult`
- Discriminated union types use a `kind` string literal discriminant: `{ kind: "processed" | "skipped" | "rejected" | ... }`
- Generic type parameters: single uppercase letter or short PascalCase: `TEnvelope`, `T`

**Constants:**
- Protocol-level named constants: SCREAMING_SNAKE_CASE: `ADDRESSABLE_KEY_PACKAGE_KIND`, `MAX_VARINT`, `AGENT_TEXT_STREAM_ROLE_RECEIVE` (see `src/core/protocol.ts`, `src/core/binary.ts`)
- Exported enum-like object namespaces: camelCase: `groupLifecycleStates`, `convergenceStatuses`, `inputCategories` (see `src/core/group-lifecycle.ts`, `src/core/inbound.ts`)
- Private module-level constants: SCREAMING_SNAKE_CASE: `ROLE_MASK`, `COMPONENT_STATE_LEN`, `ALLOWED_RUMOR_KEYS`
- Test-file top-level constants: SCREAMING_SNAKE_CASE: `ADMIN`, `MEMBER`, `CIPHERSUITE`, `RELAY`

**Class Private Fields:**
- Native `#` private fields (not TypeScript `private`): `#state`, `#lifecycle`, `#retained`, `#tree`
- See `src/engine/group-engine.ts` for the canonical pattern

## Code Style

**Formatting:**
- Tool: Prettier
- Config: `.prettierrc` — `tabWidth: 2`, `useTabs: false`
- Pre-commit hook (Husky + lint-staged) formats staged files only

**Linting:**
- No root ESLint config; `ts-mls` subpackage has its own `eslint.config.mjs`
- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` (build fails on violations)

## Import Organization

**Order (conventional, not enforced by a sorter):**
1. External packages: `@noble/hashes/utils.js`, `applesauce-*`, `ts-mls`, `debug`
2. Sibling-layer internal imports with `.js` extension
3. Deeper relative imports with `.js` extension

**Critical rule:** All relative imports inside `src/` MUST use the emitted `.js` extension, even when importing `.ts` source files (NodeNext `moduleResolution`).

```typescript
// Correct
import { createGroup } from "./group.js";
import { logger } from "../utils/debug.js";

// Wrong — omitting .js breaks NodeNext resolution
import { createGroup } from "./group";
```

**`import type`:** Used for type-only imports throughout. Example from `src/engine/group-engine.ts`:
```typescript
import type {
  AutoCommitIngestResult,
  GroupPeeler,
  SendIntent,
} from "./types.js";
```

**Path Aliases:** None — only relative imports within `src/`.

## Error Handling

**Patterns:**
- Throw `new Error(message)` for domain/validation failures: wrong credential type, invalid binary encoding, missing required state
- Custom error subclasses for codec failures: `BinaryDecodeError` in `src/core/binary.ts` — subclasses `Error`, sets `this.name`
- Result types for expected multi-outcome flows (discriminated unions via `kind`) rather than try/catch at caller boundary
- Async errors propagate as rejected Promises; callers use `await expect(...).rejects.toThrow(...)`

**Error subclass pattern:**
```typescript
export class BinaryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryDecodeError";
  }
}
```

## Logging

**Framework:** `debug` package, exposed via `src/utils/debug.ts`

```typescript
export const logger = createDebug("marmot-ts");
```

**Subsystem loggers:**
```typescript
// In each module that needs logging
const log = logger.extend("client");
const log = logger.extend("session");
```

**Enable at runtime:** `DEBUG=marmot-ts:*`

## Comments

**File-level module doc:**
```typescript
/** @module @category Core - Group */
```
Used on almost every `src/core/` and `src/engine/` file.

**JSDoc on public APIs:**
- `@param name - description`
- `@returns description`
- `@throws description of what triggers it`
- `@see cross-reference to spec doc`

**Inline comments:** Used liberally for non-obvious protocol decisions, spec references, and constraint explanations. References to spec documents (e.g., `retained-history.md`, `convergence.md`) are common inside both source and tests.

**Section separators in tests:** `// ====...====` banners for major sections inside long test files.

## Function Design

**Size:** Large complex functions are broken into focused private class methods or standalone module functions. The engine (`src/engine/group-engine.ts`) delegates heavy logic to standalone functions in sibling modules (`ingest.ts`, `ingest-disposition.ts`, `history-tree.ts`).

**Parameters:** Options-object pattern for anything with more than ~3 parameters:
```typescript
export async function createGroup(params: CreateGroupParams): Promise<CreateGroupResult>
export function createAdminCommitPolicyCallback(opts: AdminCommitPolicyOptions): IncomingMessageCallback
```

**Return Values:**
- `Promise<T>` for async operations
- `AsyncGenerator<IngestResult<TEnvelope>>` for streaming ingest pipelines
- Discriminated unions for multi-outcome results (never `null | result`)

## Module Design

**Exports:**
- Named exports only — no default exports anywhere in `src/`
- Re-export aggregators via `index.ts` barrel files per directory: `src/core/index.ts`, `src/client/index.ts`

**Barrel Files:**
- Each major directory has an `index.ts` that re-exports with `export * from "./module.js"`
- `src/index.ts` aggregates only `client`, `core`, and `utils`; engine internals are accessed via the `./engine` subpath export

**Binary Data:**
- All binary protocol data is `Uint8Array`
- Hex encoding/decoding via `@noble/hashes/utils.js`: `bytesToHex`, `hexToBytes`
- No `Buffer` usage (must stay runtime-agnostic for Deno and Bun)

## Discriminated Union Pattern

The dominant pattern for complex result types (used pervasively in the engine):
```typescript
export type IngestResult<TEnvelope> =
  | { kind: "processed"; result: ...; envelope: TEnvelope; message: MlsMessage }
  | { kind: "skipped"; envelope: TEnvelope; reason: "past-epoch" | "self-echo" | "duplicate" }
  | { kind: "unreadable"; envelope: TEnvelope; errors: unknown[] }
  | { kind: "deferred"; ... }
  | ...
```

Narrow with `if (result.kind === "processed")` — never cast.

---

*Convention analysis: 2026-07-01*
