# Testing Patterns

**Analysis Date:** 2026-07-01

## Test Framework

**Runner:**
- Vitest 3.x
- Config: `vitest.config.ts` (root)
- Environment: `node`
- Includes: `src/**/*.test.ts` only

**Assertion Library:**
- Vitest built-ins (`expect`, `it`, `describe`, `beforeEach`, `beforeAll`, `afterEach`, `vi`)

**Run Commands:**
```bash
pnpm test                   # Watch mode (vitest)
pnpm vitest run             # One-shot full suite
pnpm vitest run src/path/to/file.test.ts  # Single file
```

**CI Targets:**
- Node.js 20, 22, 24
- Deno 2: `deno run -A --node-modules-dir=auto npm:vitest run`
- Bun latest and 1.1: `bun run vitest run`

## Test File Organization

**Location:**
- Tests are colocated in `__tests__/` subdirectories alongside source:
  - `src/core/__tests__/`
  - `src/engine/__tests__/`
  - `src/client/__tests__/`
  - `src/extra/__tests__/` and `src/extra/audit/__tests__/`
  - `src/client/group/__tests__/`
  - `src/client/session/__tests__/`
- Cross-module integration tests: `src/__tests__/integration/`
- Shared test doubles: `src/__tests__/helpers/`

**Naming:**
- `<module-name>.test.ts` matching the source file name
- Integration tests named after the scenario: `end-to-end-invite-join-message.test.ts`, `ingest-commit-race.test.ts`

**Structure:**
```
src/
├── __tests__/
│   ├── helpers/
│   │   ├── mock-network.ts         # MockNetwork class
│   │   └── account-proof.ts        # accountProofSignerFor()
│   └── integration/
│       ├── end-to-end-invite-join-message.test.ts
│       ├── group-connect.test.ts
│       └── ...
├── core/__tests__/
│   ├── binary.test.ts
│   ├── convergence.test.ts
│   └── ...
└── engine/__tests__/
    ├── group-engine.test.ts
    └── ...
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ComponentName behavior (spec-doc.md)", () => {
  let sharedState: SomeType;

  beforeEach(async () => {
    sharedState = await setupFn();
  });

  it("does the thing in the normal case", async () => {
    // arrange + act + assert inline
  });

  it("rejects bad input", async () => {
    await expect(fn()).rejects.toThrow("message");
  });
});
```

**Multiple `describe` blocks per file** are the norm for different behavioral groups. Each file may contain 2–5 `describe` blocks, each covering a distinct aspect: `src/engine/__tests__/group-engine.test.ts` has separate blocks for lifecycle, dedup, admin verification, retained-history pruning, and content dedup.

**Naming convention for `it` strings:** Plain English, present tense: `"starts Stable, confirmPublished advances epoch"`, `"rejects commit send from non-admin members"`.

**Reference to spec in `describe` name:** Many describe blocks include the spec document name in parentheses for traceability: `"MarmotGroupEngine lifecycle (group-state.md)"`, `"convergence policy"`.

**Patterns:**
- `beforeEach` for per-test isolation (most common)
- `beforeAll` when setup is expensive and tests are read-only (e.g., `src/engine/__tests__/history-tree.test.ts`, `src/client/group/__tests__/invite.test.ts`)
- `afterEach` for filesystem cleanup (only in `src/extra/audit/__tests__/upload.test.ts`)
- No `afterAll` usage found

## Mocking

**Framework:** `vi` from Vitest (no separate mock library)

**Patterns:**
```typescript
// Inline function mock
const fetch = vi.fn(async () => new Response(null, { status: 200 }));

// Spy on a method
const addMediaSpy = vi.spyOn(group.media, "addMedia");

// Inline object mock with vi.fn() for each method
const historyBackend = {
  saveMessage: vi.fn(async () => {}),
  purgeMessages: vi.fn(async () => {}),
};

// Callback mock for event listener patterns
const onApplicationMessage = vi.fn();
```

**What to Mock:**
- External I/O: HTTP `fetch` (injected as a parameter), filesystem ops only when unavoidable
- Nostr network layer: use `MockNetwork` class instead of mocking (`src/__tests__/helpers/mock-network.ts`)
- Timers/clocks: inject `now` and `scheduler` options into `MarmotGroupEngine` (see `src/engine/group-engine.ts` `ConvergenceScheduler` interface)

**What NOT to Mock:**
- Cryptographic operations (`ts-mls`, `@noble/curves`, `@noble/hashes`) — real crypto runs in all tests
- Binary encoding/decoding — tested against real bytes
- MLS state machine — integration tests use real `ts-mls` functions

## Fixtures and Factories

**Test Data — Pubkeys:**
```typescript
// Valid schnorr pubkeys used throughout tests
const ADMIN = "a".repeat(64);    // 64-char hex — valid x-only pubkey
const MEMBER = "d".repeat(64);   // another valid pubkey
const nonAdminPubkey = "e".repeat(64);
```

**Test Data — Setup factory functions:**
```typescript
// Common pattern: async factory returning a shared multi-party setup
async function twoMemberGroup() {
  const impl = await getCiphersuiteImpl(...);
  const adminKp = await generateKeyPackage(...);
  const { clientState: adminEpoch0 } = await createSimpleGroup(...);
  const memberKp = await generateKeyPackage(...);
  const { newState: adminE1, welcome } = await createCommit(...);
  const memberState = await joinGroup(...);
  const peeler = testPeeler(impl);
  const engine = new MarmotGroupEngine({ state: adminE1, ciphersuite: impl, peeler });
  return { impl, ctx, peeler, engine, memberState, memberPubkey };
}
```

**In-memory stores:**
- `InMemoryKeyValueStore` from `src/extra/in-memory-key-value-store.ts` — used for `groupStateStore` and `keyPackageStore` in all integration/client tests

**MockNetwork:**
- `src/__tests__/helpers/mock-network.ts` implements `NostrNetworkInterface`
- Shares a single `events: NostrEvent[]` array (simulates relay storage)
- Supports live subscriptions: replays existing events, then delivers future publishes
- `mockNetwork.clear()` resets state between test scenarios

**Account helpers:**
- `accountProofSignerFor(account)` from `src/__tests__/helpers/account-proof.ts` — builds an `AccountIdentityProofSigner` from a `PrivateKeyAccount`

**Location:**
- Shared doubles: `src/__tests__/helpers/`
- Per-module helpers: inline factory functions within the test file

## Coverage

**Requirements:** None enforced — no coverage threshold in `vitest.config.ts` or `package.json`

**View Coverage:**
```bash
# No built-in coverage script — run manually:
pnpm vitest run --coverage
```

## Test Types

**Unit Tests (majority):**
- Scope: single function, class, or module in isolation
- Location: `src/<module>/__tests__/<file>.test.ts`
- Crypto is real; I/O is avoided or provided via simple in-memory fakes
- Binary encoding tests (`src/core/__tests__/binary.test.ts`): verify spec byte sequences with hex literals

**Integration Tests:**
- Location: `src/__tests__/integration/`
- Scope: full `MarmotClient` → `GroupsManager` → `MarmotGroupEngine` flows with `MockNetwork` and `InMemoryKeyValueStore`
- No external relays; no external crypto providers beyond the library's defaults
- Cover invite→join→message, convergence, persistence/restart, race conditions

**Engine Unit Tests:**
- Located at `src/engine/__tests__/`
- Use `testPeeler` helper (local to each test file) that wraps real `decryptGroupMessages`/`createGroupEvent`
- Drive the `MarmotGroupEngine` directly with real MLS state (no mock ciphersuite)

## Common Patterns

**Async Testing:**
```typescript
it("does something async", async () => {
  const result = await someAsyncFn();
  expect(result.kind).toBe("processed");
});
```

**Async generator drain:**
```typescript
for await (const result of engine.ingest(events)) {
  results.push(result as { kind: string });
}
// or drain without collecting:
for await (const _ of group.ingest(groupEvents)) { /* drain */ }
```

**Error Testing:**
```typescript
// Async rejection
await expect(
  engine.send({ kind: "commit", actorPubkey: nonAdminPubkey, extraProposals: [] }),
).rejects.toThrow("Not a group admin");

// Sync throw
expect(() => encodeVarint(-1)).toThrow(RangeError);
expect(() => decodeVarint(hex("4005"))).toThrow(BinaryDecodeError);

// Regex match on message
await expect(uploadAuditLogFile(...)).rejects.toThrow(/audit-\*\.jsonl/);
```

**Discriminated union narrowing in tests:**
```typescript
const result = await engine.send({ kind: "commit", ... });
expect(result.kind).toBe("groupEvolution");
if (result.kind !== "groupEvolution") throw new Error("expected groupEvolution");
// Now TypeScript knows result is the groupEvolution branch
engine.confirmPublished(result.pending);
```

**Ciphersuite constant:**
```typescript
const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
```
This is the only ciphersuite used across all tests.

---

*Testing analysis: 2026-07-01*
