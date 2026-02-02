# Agent Guidelines for marmot-ts

This document provides guidelines for AI coding agents working in the marmot-ts library.

## Project Overview

**marmot-ts** is a TypeScript implementation of the [Marmot protocol](https://github.com/parres-hq/marmot) using [ts-mls](https://github.com/LukaJCB/ts-mls). It provides MLS (Messaging Layer Security) functionality for Nostr-based group messaging.

This is a **pnpm monorepo** with the following structure:

- **Root package**: Core marmot-ts library (`/src`)
- **`/chat`**: React + Vite chat application (see `/chat/AGENTS.md`)
- **`/examples`**: Example implementations

## Build, Lint, and Test Commands

### Building

```bash
pnpm build          # Clean and compile TypeScript
pnpm compile        # Compile TypeScript only
pnpm clean          # Remove dist directory
```

### Linting and Formatting

```bash
pnpm lint           # Check code formatting with Prettier
pnpm format         # Auto-format code with Prettier
```

**Always run `pnpm format` after making changes.** This handles all formatting, import ordering, and style automatically.

### Testing

```bash
pnpm test           # Run all tests with Vitest (watch mode)
pnpm test run       # Run tests once (CI mode)

# Run a single test file
pnpm test src/__tests__/marmot-group-data.test.ts

# Run tests matching a pattern
pnpm test encoding

# Run tests in a specific directory
pnpm test src/__tests__/
```

### Development

```bash
pnpm dev            # Start chat application dev server
pnpm examples       # Start examples dev server
```

## Code Style Guidelines

### Imports

**IMPORTANT: Use explicit relative paths in `src/` to avoid over-importing.**

Always import from specific files rather than index files when working in the `src/` directory:

```typescript
// ✅ Correct - explicit paths
import { getCredentialPubkey } from "./credential.js";
import { MarmotGroupData } from "../core/protocol.js";
import { generateKeyPackage } from "../core/key-package.js";

// ❌ Wrong - importing from index files
import { getCredentialPubkey } from "../core/index.js";
import { MarmotGroupData } from "../core/index.js";
```

**Note**: Relative imports must use `.js` extension (TypeScript ESM requirement).

### Error Handling

**Throw descriptive errors** for invalid input:

```typescript
if (!encryptionKey) throw new Error("Storage locked");
if (bytes.length === 0) throw new Error("Invalid padding: empty data");
throw new Error("Invalid padding: padding length out of range");
```

**Use early returns** to avoid deep nesting:

```typescript
export function supportsMarmotExtensions(extensions: Extension[]): boolean {
  if (!extensions.length) return false;
  return extensions.some((ext) => ext.extensionType === EXTENSION_TYPE);
}
```

### Documentation

**Use JSDoc** for exported functions, types, and classes:

```typescript
/**
 * Gets all leaf node indexes for a given nostr pubkey in a group.
 *
 * @param state - The ClientState to search
 * @param pubkey - The nostr pubkey to find
 * @returns Array of leaf node indexes (numbers) for the given pubkey
 */
export function getPubkeyLeafNodeIndexes(
  state: ClientState,
  pubkey: string,
): number[] {
  // ...
}

/** Gets all the nostr pubkey keys in a group */
export function getGroupMembers(state: ClientState): string[] {
  // ...
}
```

### File Organization

**Index files** re-export public API:

```typescript
// src/index.ts
export * from "./client/index.js";
export * from "./core/index.js";
export * from "./store/index.js";
export * from "./utils/index.js";
```

**Test files** are colocated in `src/__tests__/`:

- Pattern: `src/__tests__/*.test.ts`
- Use descriptive test names with `describe` and `it`

## Git Workflow

Always run `pnpm format` before committing.
