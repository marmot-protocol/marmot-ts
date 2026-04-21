# Agent Guidelines for @internet-privacy/marmot-ts

This document provides essential information for AI coding agents working in this repository.

## Project Overview

This is a TypeScript library implementing the Marmot protocol (MLS over Nostr) using ESM modules with strict TypeScript configuration. The codebase uses pnpm, Vitest for testing, and Prettier for formatting.

## Build, Lint, and Test Commands

### Build

```bash
pnpm build          # Clean and compile (runs clean + compile)
pnpm compile        # TypeScript compilation only
pnpm clean          # Remove dist/ directory
```

### Linting and Formatting

```bash
pnpm lint           # Check code formatting with Prettier
pnpm format         # Auto-format code with Prettier
```

### Testing

```bash
pnpm test           # Run tests in watch mode (default)
pnpm vitest run     # Run all tests once
vitest run src/__tests__/encoding.test.ts    # Run single test file
vitest -t "test name"                        # Run tests matching pattern
```

**Test Framework:** Vitest 3.2.4
**Test Pattern:** `src/**/*.test.ts`
**Test Location:** All tests in `src/__tests__/` directory

## Code Style Guidelines

### Module System and Imports

**CRITICAL:** This project uses ESM with NodeNext module resolution. All imports MUST include `.js` extensions, even when importing `.ts` files:

```typescript
// ✓ Correct
import { createGroup } from "./core/group.js";
import type { NostrEvent } from "../types.js";

// ✗ Wrong - will cause compilation errors
import { createGroup } from "./core/group";
import type { NostrEvent } from "../types";
```

**Import Order:**

1. Third-party libraries
2. Internal absolute imports
3. Relative imports
4. Type-only imports (using `import type`)

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventEmitter } from "eventemitter3";
import { createCredential } from "../core/credential.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
```

### Naming Conventions

- **Files:** kebab-case (`marmot-client.ts`, `key-package-event.ts`)
- **Classes:** PascalCase (`MarmotClient`, `GroupStateStore`, `NoGroupRelaysError`)
- **Functions:** camelCase (`createGroup`, `getCredentialPubkey`, `ensureMarmotCapabilities`)
- **Constants:** UPPER_SNAKE_CASE (`WELCOME_EVENT_KIND`, `KEY_PACKAGE_KIND`)
- **Types/Interfaces:** PascalCase (`CreateGroupParams`, `MarmotClientOptions`)

### Exports

**Use named exports only** - no default exports:

```typescript
// ✓ Correct
export function createGroup(...) { }
export const marmotAuthService = { };
export type CreateGroupParams = { };
export class MarmotClient { }

// ✗ Wrong
export default class MarmotClient { }
```

### TypeScript Style

**Strict Mode:** All strict flags are enabled. Code must satisfy:

- No implicit any types
- Explicit return types on public functions
- No unused locals or parameters
- No implicit returns
- No implicit this

```typescript
// ✓ Good - explicit types and return type
export function encodeData(bytes: Uint8Array, format: EncodingFormat): string {
  if (format === "base64") {
    return bytesToBase64(bytes);
  }
  return bytesToHex(bytes);
}

// ✗ Bad - missing return type, implicit any
export function encodeData(bytes, format) {
  // ...
}
```

**Type Guards:** Use for runtime type checking:

```typescript
export function isRumorLike(value: unknown): value is Rumor {
  return typeof value === "object" && value !== null && "kind" in value;
}
```

### Error Handling

**Custom Error Classes:** Create specific error types:

```typescript
export class NoGroupRelaysError extends Error {
  constructor() {
    super("Group has no relays available to send messages.");
  }
}
```

**Try-Catch:** Provide informative error messages:

```typescript
try {
  return hexToBytes(content);
} catch (error) {
  throw new Error(
    `Failed to decode hex content: ${error instanceof Error ? error.message : String(error)}`,
  );
}
```

### Documentation

Use JSDoc comments for public APIs:

```typescript
/**
 * Encodes binary data to a string using the specified format.
 *
 * @param bytes - The binary data to encode
 * @param format - The encoding format ('base64' or 'hex')
 * @returns The encoded string
 */
export function encodeData(bytes: Uint8Array, format: EncodingFormat): string {
  // ...
}
```

### Formatting

**Prettier Configuration:**

- Tab width: 2 spaces
- No tabs
- Run `pnpm format` before committing

## Architecture Patterns

### Project Structure

```
src/
  client/       # Client implementation (MarmotClient, network interface)
  core/         # Core protocol logic (groups, messages, credentials, extensions)
  store/        # Storage backends (group state, key packages, invites)
  utils/        # Utility functions (encoding, nostr, timestamps)
  extra/        # Extra features (encrypted key-value store)
  __tests__/    # Test files
```

### Common Patterns

**EventEmitter for State Updates:**

```typescript
export class MarmotClient extends EventEmitter<MarmotClientEvents> {
  // ...
}
```

**Interface-Based Abstractions:**

- `NostrNetworkInterface` for network operations
- `GroupStateStoreBackend` for storage
- `KeyPackageStore` for key management

**Async/Await:** Use for all asynchronous operations

**Binary Data:** Use `Uint8Array` for binary data handling

## Testing Guidelines

- Place test files in `src/__tests__/`
- Use `.test.ts` suffix
- Import test utilities: `import { describe, expect, it } from "vitest"`
- Write unit tests for new functions
- Write integration tests for complex workflows
- Use mock implementations in `__tests__/helpers/` when needed

Example test structure:

```typescript
import { describe, expect, it } from "vitest";

describe("encoding utilities", () => {
  it("should encode bytes to hex", () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(encodeData(bytes, "hex")).toBe("48656c6c6f");
  });
});
```

## Key Configuration Files

- `package.json` - Package configuration and scripts
- `tsconfig.build.json` - Production TypeScript config
- `tsconfig.json` - Development TypeScript config (includes tests)
- `vitest.config.ts` - Test configuration
- `.prettierrc` - Code formatting rules
- `pnpm-workspace.yaml` - Monorepo configuration

## Git Workflow

1. Make changes in appropriate directory (`src/`, `examples/`, etc.)
2. Run `pnpm format` to format code
3. Run `pnpm test` to ensure tests pass
4. Run `pnpm build` to verify compilation
5. **Create a changeset if changes affect user-facing APIs**
6. Commit with descriptive messages (including changeset file if created)
