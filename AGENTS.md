# Agent Guidelines for @internet-privacy/marmots

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

## Changesets for Version Management

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs. **Only create changesets when user-facing APIs change or break.**

### When to Create a Changeset

**CREATE a changeset when:**

- ✅ Adding new public functions, classes, or methods
- ✅ Modifying signatures of exported functions/methods
- ✅ Adding/removing/changing public exports
- ✅ Fixing bugs that affect user-facing behavior
- ✅ Changing the behavior of existing APIs
- ✅ Adding new features users can utilize
- ✅ Deprecating or removing public APIs

**DO NOT create a changeset for:**

- ❌ Internal refactoring (no API changes)
- ❌ Test-only changes
- ❌ Documentation updates (unless they reflect API changes)
- ❌ Build configuration changes
- ❌ Changes to dev dependencies
- ❌ Code formatting or linting fixes
- ❌ Internal helper functions not exported

### Determining the Bump Type

Follow [Semantic Versioning](https://semver.org/):

**PATCH (0.0.X) - Bug Fixes**

- Bug fixes in existing APIs
- Performance improvements
- Internal refactoring (if it fixes user-facing issues)

```markdown
---
"@internet-privacy/marmots": patch
---

Fix memory leak in event handler cleanup
```

**MINOR (0.X.0) - New Features (Backwards Compatible)**

- New public functions/classes/methods
- New optional parameters
- New exports
- Deprecation warnings (not removal)

```markdown
---
"@internet-privacy/marmots": minor
---

Add `getGroupMembers()` method to retrieve all members in a group
```

**MAJOR (X.0.0) - Breaking Changes**

- Removing public APIs
- Changing required parameters
- Removing/renaming exports
- Incompatible behavior changes

```markdown
---
"@internet-privacy/marmots": major
---

**Breaking:** Remove deprecated `sendMessage()` method. Use `send()` instead.
```

### How to Create a Changeset

**IMPORTANT: Always use the CLI to create changesets. Never manually create changeset files.**

Use the `pnpm changeset add` command with the `--empty` flag to create a changeset template:

```bash
pnpm changeset add --empty
```

This will:

1. Create a new changeset file with a randomly generated name (e.g., `.changeset/funny-cats-smile.md`)
2. Generate an empty template that you can then edit

After the file is created, you'll see output like:

```
🦋  Empty Changeset added! - you can now commit it
🦋  info /home/user/project/.changeset/funny-cats-smile.md
```

Then, edit the generated file to add the package name, bump type, and **a single line description**:

```markdown
---
"@internet-privacy/marmots": minor
---

Add support for encrypted group messaging
```

**Important Guidelines:**

- Keep the description to a **single line of text**
- This ensures it fits cleanly into the changelog
- Be concise but descriptive

**Why use the CLI?**

- Ensures correct file naming and format
- Prevents formatting errors
- Follows the project's changeset conventions

### Changeset Writing Guidelines

**User-Facing Language:** Write for library users, not developers:

- ✅ "Add `maxRetries` option to connection configuration"
- ❌ "Implement retry logic in ConnectionManager class"

**Action-Oriented:** Start with a verb:

- **Add:** New features
- **Fix:** Bug fixes
- **Update:** Improvements
- **Remove:** Deleted features
- **Change:** Modified behavior

**Be Specific:**

- ✅ "Fix reconnection failure after network timeout"
- ❌ "Fix bug"

**Single Line Only:**

- ✅ "Add group management methods including mute, pin, and stats"
- ❌ Multi-line descriptions with bullet points (these don't format well in changelogs)

### Workflow Integration

When making changes that affect the public API:

1. Make your code changes
2. Run `pnpm format` to format code
3. Run `pnpm test` to ensure tests pass
4. Run `pnpm build` to verify compilation
5. **Create a changeset using `pnpm changeset add --empty`** if the change is user-facing
6. Edit the generated changeset file to add package name, bump type, and **a single line description**
7. Commit both your changes AND the changeset file

```bash
# After making changes to public API
pnpm changeset add --empty
# This creates .changeset/some-random-name.md

# Edit the file to add your changeset details
# Then commit everything together
git add .
git commit -m "Add group encryption feature"
# Both code changes and the changeset file are committed together
```

### Example Scenarios

**Scenario 1: Adding a new public method**

```typescript
// In src/client/marmot-client.ts
export class MarmotClient {
  // New method added
  public async getGroupInfo(groupId: string): Promise<GroupInfo> {}
}
```

Run `pnpm changeset add --empty`, then edit the generated file:

```markdown
---
"@internet-privacy/marmots": minor
---

Add getGroupInfo() method to retrieve group metadata
```

**Scenario 2: Fixing a bug**

```typescript
// Fixed: Connection now properly retries on timeout
```

Run `pnpm changeset add --empty`, then edit the generated file:

```markdown
---
"@internet-privacy/marmots": patch
---

Fix connection retry logic to handle network timeouts
```

**Scenario 3: Breaking change**

```typescript
// Changed signature from:
// createGroup(name: string, relays: string[])
// to:
// createGroup(options: CreateGroupOptions)
```

Run `pnpm changeset add --empty`, then edit the generated file:

```markdown
---
"@internet-privacy/marmots": major
---

Change createGroup() to accept options object instead of positional arguments
```

### Additional Notes

- Changeset files are consumed during the release process by maintainers
- Multiple changesets can exist and will be combined during version bumping
- See `.changeset/README.md` for comprehensive documentation
- The configuration uses `master` as the base branch

## Git Workflow

1. Make changes in appropriate directory (`src/`, `examples/`, etc.)
2. Run `pnpm format` to format code
3. Run `pnpm test` to ensure tests pass
4. Run `pnpm build` to verify compilation
5. **Create a changeset if changes affect user-facing APIs**
6. Commit with descriptive messages (including changeset file if created)
