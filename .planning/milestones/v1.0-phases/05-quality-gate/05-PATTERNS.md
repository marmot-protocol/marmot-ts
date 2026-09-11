# Phase 5: Quality Gate - Pattern Map

**Mapped:** 2026-09-06
**Files analyzed:** 8 likely new/modified files
**Analogs found:** 8 / 8

## File Classification

Phase 5 has no `CONTEXT.md` or `RESEARCH.md` yet. The file set below is inferred from QA-01/QA-02 and the Phase 5 success criteria in `ROADMAP.md`. This is principally a verification/evidence phase: do not invent production changes before a supported runtime or reference cross-check demonstrates a defect.

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `.github/workflows/tests.yml` | config/CI | batch | same file, existing Node/Deno/Bun matrix | exact |
| `.github/workflows/build.yml` | config/CI | batch | same file, frozen install + library build | exact |
| `package.json` | config/script | batch | existing `compile`, `test`, and `conformance:extended` scripts | exact |
| `vitest.config.ts` | config | batch | same file, portable default-suite discovery | exact |
| `vitest.extended.config.ts` | config | batch | same file, isolated pressure suite | exact |
| `src/__tests__/conformance/*.test.ts` | test/harness | file-I/O, batch, event-driven | existing manifest, smoke, named-vector, and adapter suites | exact |
| catch-up parity tests and fixtures | test/fixture | transform, request-response | proof-v2, KeyPackage, tag-cardinality, and dictionary tests | exact |
| `.planning/phases/05-quality-gate/05-QUALITY-GATE.md` (new, likely) | verification record | batch/transform | `04-VERIFICATION.md` behavioral spot-check and requirement tables | role-match |

## Pattern Assignments

### `.github/workflows/tests.yml` (CI runtime matrix)

**Analog:** the existing workflow already names all Phase 5 runtime targets.

**Node matrix and hermetic install pattern** (lines 11-18, 20-24, 31-34, 50-54):

```yaml
jobs:
  test-node:
    name: Test on Node.js ${{ matrix.node-version }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20.x, 22.x, 24.x]

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          submodules: recursive
      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run tests
        run: pnpm vitest run
```

**Deno and Bun command pattern** (lines 56-62, 94-98, 100-106, 138-142):

```yaml
test-deno:
  strategy:
    matrix:
      deno-version: [v2.x]
  # ... frozen pnpm install ...
  - name: Run tests with Deno
    run: deno run -A --node-modules-dir=auto npm:vitest run

test-bun:
  strategy:
    matrix:
      bun-version: [latest, "1.1"]
  # ... frozen pnpm install ...
  - name: Run tests with Bun
    run: bun run vitest run
```

Preserve these exact commands because they are also the Phase 5 acceptance criteria. If the extended conformance suite is added to CI, add an explicit step rather than broadening default Vitest discovery: `extended.spec.ts` is intentionally excluded by its suffix.

---

### `.github/workflows/build.yml` and `package.json` (compile/build gate)

**Analog:** existing build workflow and scripts.

**Build gate** (`.github/workflows/build.yml` lines 18-31, 48-52):

```yaml
- name: Checkout Repo
  uses: actions/checkout@v4
  with:
    submodules: recursive
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: "pnpm"
- name: Install Dependencies
  run: pnpm install --frozen-lockfile
- name: Build Library
  run: pnpm build
```

**Script separation** (`package.json` lines 8-19):

```json
"prepare": "pnpm --filter ts-mls build",
"build": "pnpm run clean && pnpm run compile",
"compile": "tsc -b tsconfig.build.json",
"lint": "prettier --check .",
"test": "vitest",
"conformance:extended": "vitest run --config vitest.extended.config.ts"
```

Use `pnpm vitest run` for the normal one-shot suite and `pnpm conformance:extended` for the isolated pressure suite. Do not use `pnpm test`, which enters watch mode. Keep CI on pnpm 10 and `--frozen-lockfile`.

---

### `vitest.config.ts` and `vitest.extended.config.ts` (suite boundaries)

**Analog:** the two current minimal configs (both lines 1-8).

```typescript
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

The extended config uses the same shape with:

```typescript
include: ["src/__tests__/conformance/extended.spec.ts"];
```

Preserve the `.test.ts`/`.spec.ts` split so the expensive deterministic pressure corpus remains opt-in and cannot accidentally run twice. Runtime fixes belong in tests/helpers when possible; production modules must not acquire Node-only APIs to satisfy the harness.

---

### `src/__tests__/conformance/*` (reference corpus execution)

**Analogs:** `manifest.ts` and `smoke.test.ts`.

**Strict pinned-artifact boundary** (`manifest.ts` lines 64-75, 77-90):

```typescript
export function resolveManifestArtifact(vectorsRoot: string, artifact: string): string {
  if (!artifact || path.isAbsolute(artifact))
    throw new Error("artifact must be a relative path");
  const root = path.resolve(vectorsRoot);
  const resolved = path.resolve(root, artifact);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`))
    throw new Error("artifact escapes vectors root");
  return resolved;
}

export function validateConformanceManifest(raw: unknown, vectorsRoot: string) {
  if (!isRecord(raw)) throw new Error("manifest must be an object");
  requireExactKeys(raw, MANIFEST_KEYS, "manifest");
  // validate version/header/entries before execution
}
```

**Every portable fixture stays visible** (`smoke.test.ts` lines 22-30, 39-49, 93-101):

```typescript
const manifest = validateConformanceManifest(manifestJson, VECTORS_ROOT);
const portable = manifest.entries.filter((entry) => entry.status === "portable");
const represented = new Set<string>();

for (const entry of portable) {
  it(entry.id, async () => {
    // Byte fixtures execute through the production codec.
    represented.add(entry.id);
  });
}

it("represents every portable manifest entry", () => {
  expect(represented.size).toBe(portable.length);
  expect([...represented].sort()).toEqual(portable.map((entry) => entry.id).sort());
});
```

Phase 5 should run, not rewrite, this seam. If upstream refs changed, validate manifest identity and fixture meaning before refreshing evidence. Unsupported capabilities remain explicit `{ kind: "unsupported" }`; never turn missing execution into a skip or silently drop manifest entries.

---

### Catch-up byte parity evidence (proof, KeyPackage lifetime, tags, SafeAAD)

#### Proof v2

**Analog:** `src/core/__tests__/darkmatter-invite-compat.test.ts` lines 202-240, 243-276.

```typescript
expect(accountIdentityProofEventId(req)).toBe(RUST_FIXTURE_EVENT_ID_HEX);
expect(bytesToHex(accountIdentityProofSigningDigest(req))).toBe(
  RUST_FIXTURE_EVENT_ID_HEX,
);
expect(schnorr.verify(signature, digest, req.accountIdentity)).toBe(true);
expect(() =>
  verifyLeafAccountIdentityProof(leaf, RUST_FIXTURE_CIPHERSUITE),
).not.toThrow();
```

Record the pinned Rust fixture source/revision and the exact focused command. Retain the mutation-negative assertion (lines 243-256) so the fixture is evidence of binding, not merely decodability. `account-identity-proof.test.ts` lines 49-87 is the companion independent event reconstruction: exact six-tag order, kind 450, decimal signature scheme, and matching event ID.

#### KeyPackage lifetime

**Analog:** `src/core/__tests__/key-package.test.ts` lines 251-305.

```typescript
await expect(
  generateKeyPackage({
    credential,
    ciphersuiteImpl,
    lifetime: { notBefore: now, notAfter: now + 7261201n },
  }),
).rejects.toThrow();

const lifetime = { notBefore: now, notAfter: now + 7261200n };
// ... generate ...
expect(keyPackage.publicPackage.leafNode.lifetime).toEqual(lifetime);
```

The quality record should distinguish reference byte/output comparison from local boundary behavior. Pair the at-cap and one-over-cap TS tests with the MDK/Rust output or source command used for QA-02; a passing TS-only test is insufficient proof of a cross-check.

#### Required-tag cardinality

**Analog:** `src/utils/__tests__/tag-cardinality.test.ts` lines 22-56, 58-106.

```typescript
expect(getSingletonTagValue(makeEvent([["h", "abc"]]), "h")).toBe("abc");
expect(
  getSingletonTagValue(makeEvent([["h", "abc"], ["h", "def"]]), "h"),
).toBeUndefined();
expect(getListTag(makeEvent([["relays", "r1", "r1"]]), "relays"))
  .toBeUndefined();
expect(TAG_CARDINALITY[30443]["app_components"]).toBe("list");
```

Record the Rust/reference cases for repeated, empty, extra-value, and duplicate-list tags. Preserve table-driven coverage for kinds 445, 1059, 444, and 30443; do not collapse the evidence to a single representative `h` tag.

#### SafeAAD dictionary bytes

**Analog:** `src/core/components/__tests__/dictionary.test.ts` lines 133-179.

```typescript
expect(getAppComponents(extensions)).toEqual([
  APP_COMPONENTS_COMPONENT_ID,
  ...SUPPORTED_APP_COMPONENT_IDS,
]);
expect(getComponentData(extensions, SAFE_AAD_COMPONENT_ID)).toEqual(
  new Uint8Array([0]),
);
expect(bytesToHex(/* real KeyPackage leaf extension bytes */)).toBe(
  "00061b1a0001131200018001800380048005800680078008800c00020100",
);
expect(() =>
  makeAppComponentsExtension([
    componentEntry(SAFE_AAD_COMPONENT_ID, new Uint8Array([0])),
  ]),
).toThrow(/SafeAAD.*LeafNode/i);
```

This is the canonical Phase 5 byte-exact pattern: construct a real production KeyPackage, extract the serialized extension, and compare the complete hex sequence. Record the MDK command/revision that produced the expected hex.

---

### `.planning/phases/05-quality-gate/05-QUALITY-GATE.md` (new evidence record)

**Analog:** `04-VERIFICATION.md` lines 30-44, 81-99.

Use two explicit tables:

```markdown
| Runtime | Version | Exact command | Result | Tests/files | Evidence date |
|---|---:|---|---|---:|---|
| Node | 20.x | `pnpm vitest run` | PASS | ... | ... |

| Counterpart | TS artifact/test | Rust source/vector revision | Reproduction command | Exact output | Result |
|---|---|---|---|---|---|
| Proof v2 | `proof-v2-rust.json` | ... | ... | event id/signature | PASS |
```

The existing verification style records the exact command, numeric result, and PASS status (`04-VERIFICATION.md` lines 83-88), then maps requirements to evidence (`04-VERIFICATION.md` lines 94-99). Follow that structure for QA-01 and QA-02. Capture tool versions, git commit, both submodule SHAs, and UTC date so "latest" is reproducible. Separate normal suite, extended suite, compile, and formatting results; do not summarize a local Node run as cross-runtime success.

## Shared Patterns

### Reference Pinning

- Checkout submodules recursively in CI.
- Before Phase 5 planning, perform the AGENTS-required upstream fetch/log check for both `refs/marmot` and `refs/mdk`; any pointer bump is a separate `chore(refs):` commit.
- Evidence names the repository commit plus exact `refs/marmot` and `refs/mdk` SHAs. Immutable checked-in fixture bytes are preferable to generating expected values during the TS test.

### Test Integrity

- Drive production encoders/decoders/verifiers; do not duplicate the implementation under test in the assertion.
- Include negative mutation/boundary cases beside positive reference bytes.
- Keep all portable manifest entries represented and all unsupported behavior explicit.
- Run async/state-machine tests to completion; never leave an async generator partially drained.

### Cross-Runtime Constraints

- The acceptance matrix is Node 20/22/24, Deno 2, Bun latest/1.1.
- Use the exact repository commands from `.github/workflows/tests.yml` with a frozen pnpm install.
- `node:fs` and `node:path` are test-only in the conformance harness; production code remains runtime-agnostic (`Uint8Array`, Web/ES APIs, no `Buffer`).
- Do not add dependencies merely to make the gate easier to run.

### Failure Handling

- A red runtime is a concrete diagnostic input. Narrow to the failing file, fix only the demonstrated incompatibility, rerun the focused file, then rerun that runtime's full suite.
- A flaky pressure vector must be reproduced in fresh processes; Phase 4's precedent is three consecutive passes (`04-VERIFICATION.md` line 87).
- Do not mark QA-02 complete from historical prose alone: retain exact output, fixture/source revision, and reproduction command in the Phase 5 evidence record.

## No Analog Found

No likely Phase 5 file lacks an analog. The only new artifact is the consolidated quality-gate record, and the Phase 1-4 verification reports provide its reporting structure. Exact Rust reproduction commands may vary by counterpart and must be taken from the pinned MDK source/fixture generation path rather than invented from TypeScript patterns.

## Metadata

**Analog search scope:** `.github/workflows`, root package/Vitest configuration, `src/__tests__/conformance`, proof/KeyPackage/tag/dictionary tests, Phase 1-4 verification reports  
**Strong analogs inspected:** 15 files  
**Pattern extraction date:** 2026-09-06
