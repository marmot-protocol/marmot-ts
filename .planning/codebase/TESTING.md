# Testing Patterns

**Analysis Date:** 2026-07-07

## Test Framework

**Runner:**
- Vitest 3.2.6
- Config: `vitest.config.ts` — `environment: "node"`, `include: ["src/**/*.test.ts"]`

**Assertion Library:**
- Vitest built-in `expect` (Chai-style); globals imported explicitly, not injected (though `vitest/globals` types are enabled in `tsconfig.json`)

**Run Commands:**
```bash
pnpm test                              # Vitest in watch mode
pnpm vitest run                        # One-shot run of the full suite
pnpm vitest run src/path/to/file.test.ts   # Run a single test file
```

Cross-runtime CI additionally runs:
```bash
deno run -A --node-modules-dir=auto npm:vitest run   # Deno 2
bun run vitest run                                    # Bun latest / 1.1
```
The suite must pass on Node 20/22/24, Deno 2, and Bun latest/1.1.

## Test File Organization

**Location:**
- Co-located under a sibling `__tests__/` directory next to the code under test (e.g. `src/core/__tests__/binary.test.ts` tests `src/core/binary.ts`)
- Cross-cutting integration tests live in `src/__tests__/integration/`
- 65 test files total across `core`, `engine`, `client`, `extra`, and `utils`

**Naming:**
- `<source-name>.test.ts` — mirrors the file under test

**Structure:**
```
src/
├── core/__tests__/            # protocol/crypto/state unit tests
├── engine/__tests__/          # state-machine unit tests
├── client/__tests__/          # client-layer unit tests
├── client/**/__tests__/       # nested per-module tests (runtime, group, session)
├── extra/__tests__/           # store implementation tests
├── utils/__tests__/           # utility tests
└── __tests__/
    ├── helpers/               # shared test doubles (mock-network.ts, account-proof.ts)
    └── integration/           # end-to-end multi-component flows
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from "vitest";
import { MarmotGroupEngine } from "../group-engine.js";

describe("MarmotGroupEngine lifecycle (group-state.md)", () => {
  it("starts Stable, confirmPublished advances epoch, publishFailed resets to Stable", async () => {
    const adminPubkey = "a".repeat(64);
    // ... arrange, act, assert
  });
});
```

**Patterns:**
- `describe` names often cite the spec doc they cover (e.g. `"MarmotGroupEngine lifecycle (group-state.md)"`)
- `it` names are full behavioral sentences describing the observed outcome
- Local `async function` builders inside the test file assemble fixtures (e.g. `createTestGroupState()`, `testPeeler()` in `src/engine/__tests__/group-engine.test.ts`)
- Test pubkeys use repeated hex chars: `"a".repeat(64)`; valid x-only test pubkeys use hex chars `a/d/e/2/3/4`, invalid use `b/c/f/0/1`
- Most tests are `async` because MLS/crypto operations are Promise-based

## Mocking

**Framework:** Vitest `vi` (`vi.fn`, `vi.spyOn`) — used sparingly

**Preferred approach:** Hand-written test doubles over `vi.mock`. No module-level `vi.mock()` is used anywhere; there is no auto-mocking.

**Shared doubles (`src/__tests__/helpers/`):**
- `MockNetwork` (`mock-network.ts`) — an in-memory `NostrNetworkInterface` implementation with a shared `events` array, filter matching, live subscription replay, and `clear()`. Prefer this over inline network mocks.
- `accountProofSignerFor()` (`account-proof.ts`) — builds an `AccountIdentityProofSigner` from a test `PrivateKeyAccount`

**Spot mocking with `vi`:**
```typescript
// Inject a fake fetch (src/extra/audit/__tests__/upload.test.ts)
const fetch = vi.fn(async () => new Response(null, { status: 200 }));

// Spy on a real method (src/core/__tests__/media.test.ts)
const addMediaSpy = vi.spyOn(group.media, "addMedia");

// Assert event handlers fired (src/client/__tests__/leave-group.test.ts)
const destroyedHandler = vi.fn();
```

**What to mock:** Network/relay I/O (via `MockNetwork`), HTTP `fetch` for uploads, EventEmitter handlers to assert emission.

**What NOT to mock:** MLS/crypto (`ts-mls`, ciphersuite impls), binary codecs, convergence/lifecycle logic — these run for real so tests verify byte-for-byte wire behavior.

## Fixtures and Factories

**Test data:**
- `PrivateKeyAccount` from `applesauce-accounts/accounts` provides test identities (dev/test dependency, not a runtime dependency of the library)
- Real ciphersuite implementations built in-test: `getCiphersuiteImpl("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519", defaultCryptoProvider)`
- `unsafeTestingAuthenticationService` from `ts-mls` for tests that need to bypass auth
- Hex fixtures via `@noble/hashes/utils.js` `hexToBytes`/`bytesToHex`; a small local `hex = (s) => hexToBytes(s.replace(/\s+/g, ""))` helper is common in codec tests

**Location:**
- Reusable doubles in `src/__tests__/helpers/`
- Per-file builder functions defined at the top of each test file

## Coverage

**Requirements:** None enforced. No coverage provider is configured in `vitest.config.ts` and there is no coverage threshold.

**View Coverage:**
```bash
pnpm vitest run --coverage   # requires installing a coverage provider; not wired up by default
```

## Test Types

**Unit Tests:**
- Dominant style; located in per-module `__tests__/` dirs
- Cover binary codecs, crypto/protocol helpers, the engine state machine, and client managers in isolation

**Integration Tests:**
- `src/__tests__/integration/` — full flows across engine + client + core using `MockNetwork` and in-memory stores
- Examples: `end-to-end-invite-join-message.test.ts`, `send-chat-message.test.ts`, `rewind-persistence.test.ts`, `ingest-commit-race.test.ts`
- Use in-memory stores and mock Nostr networking, never external relays or services

**Interop/Compatibility Tests:**
- `src/core/__tests__/darkmatter-invite-compat.test.ts` and codec tests assert byte-for-byte wire format against the Rust `darkmatter` reference and spec worked examples

**E2E Tests:**
- No browser/CLI E2E harness; the integration suite is the top of the pyramid

## Common Patterns

**Async Testing:**
```typescript
it("does the thing", async () => {
  const result = await engine.someAsyncOp();
  expect(result.kind).toBe("processed");
});
```

**Error Testing:**
```typescript
await expect(decodeVarint(badBytes)).rejects.toThrow();
// or for sync throws:
expect(() => transitionLifecycle(state, illegal)).toThrow();
```

**Round-trip / boundary testing (codecs):**
```typescript
for (const v of [0n, 1n, 63n, 64n, 16383n, 16384n, ...]) {
  expect(decodeVarint(encodeVarint(v))).toBe(v);
}
```

**Async generator draining:** Engine `ingest()` returns an `AsyncGenerator`; tests must iterate it fully (`for await (const r of engine.ingest(...))`) before asserting or issuing the next batch.

---

*Testing analysis: 2026-07-07*
