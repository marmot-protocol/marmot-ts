# Phase 5: Quality Gate - Research

**Researched:** 2026-09-06  
**Domain:** Cross-runtime release qualification and Rust/TypeScript wire-conformance evidence  
**Confidence:** HIGH — the plan is derived primarily from repository CI, executable tests, pinned specification/reference submodules, and completed verification artifacts. [VERIFIED: codebase grep]

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Runtime evidence

- **D-01:** Run both the normal and isolated extended conformance suites in every required runtime job.
- **D-02:** Local Node 22, Deno 2, and Bun latest runs are smoke evidence; authoritative missing-version evidence comes from CI jobs, never inferred from local substitutes.
- **D-03:** CI must pin pnpm 10 and preserve the frozen lockfile contract.

#### Cross-reference dossiers

- **D-04:** Record separate reproducible dossiers for proof v2, KeyPackage lifetime, tag cardinality, and SafeAAD with exact repository SHAs, commands, outputs/digests, and negative controls.
- **D-05:** For tag cardinality, distinguish Rust-produced kind-30443 byte parity from specification-derived inbound rejection parity; do not claim a Rust oracle where MDK exposes none.
- **D-06:** MDK `b4649c01` changes signed MLS capability advertisements, so KeyPackage and SafeAAD evidence must be regenerated against the updated pinned reference.

### the agent's Discretion

- CI job factoring, artifact naming, and report layout, provided every required runtime/version and both suite classes are unambiguous.
- Whether runtime defects are fixed in one or several plans, with atomic regression commits.

### Deferred Ideas (OUT OF SCOPE)

None — this phase is strictly the milestone release gate.
</user_constraints>

## Summary

Phase 5 is an evidence and defect-closure gate, not a feature phase: execute the already-declared runtime matrix, run the isolated extended conformance suite, reproduce every named Rust/TypeScript catch-up comparison, and record immutable evidence for one repository commit. [VERIFIED: `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.github/workflows/tests.yml`, `package.json`] The normal suite is already separated from the extended pressure suite by `vitest.config.ts` (`src/**/*.test.ts`) and `vitest.extended.config.ts` (`extended.spec.ts` only), so both must be invoked explicitly. [VERIFIED: codebase grep]

Local execution can prove Node 22.23.1, Deno 2.9.4, and Bun 1.3.14 only; it cannot prove Node 20, Node 24, or Bun 1.1 because those executables are not installed under a local version manager. [VERIFIED: local command probe] The existing GitHub Actions matrix owns the missing versions and uses Node 20.x/22.x/24.x, Deno v2.x, Bun latest/1.1, pnpm 10, recursive submodule checkout, and `pnpm install --frozen-lockfile`. [VERIFIED: `.github/workflows/tests.yml`] The local pnpm is 12.3.4, so local results must not be represented as pnpm-10 CI equivalence. [VERIFIED: local command probe]

The MDK submodule was safely fast-forwarded from `6479419e` to `dbf45c83` and committed separately as `f24e107`; `b4649c01` is relevant because it distinguishes implicit default MLS support from signed capability advertisements, while `dbf45c83` changes Marmot app relay discovery rather than Phase 5 wire outputs. [VERIFIED: git history and MDK diff] The new capability behavior raises one additional release risk: rerun real-KeyPackage capability and SafeAAD bytes after the bump so a stale golden value cannot conceal divergence. [VERIFIED: `refs/mdk` diff and `src/core/components/__tests__/dictionary.test.ts`]

**Primary recommendation:** Create one quality-gate evidence artifact tied to exact superproject/spec/MDK SHAs; require all six runtime jobs plus compile, normal suite, extended suite, and four explicit interop dossiers to be green before marking QA-01/QA-02 complete. [VERIFIED: roadmap, CI, completed verification artifacts]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Runtime matrix execution | CI / build system | Library test harness | GitHub Actions installs each declared runtime and invokes the repository suite. [VERIFIED: `.github/workflows/tests.yml`] |
| Normal and extended suite discovery | Test harness | CI / build system | Vitest configs define disjoint file sets; CI or a release-gate script must call both. [VERIFIED: `vitest.config.ts`, `vitest.extended.config.ts`] |
| Byte-exact encoding and verification | Core protocol layer | Test fixtures | Production encoders/verifiers own the bytes; fixtures contain immutable expected outputs. [VERIFIED: `src/core/**`, `src/__tests__/fixtures`] |
| Nostr tag cardinality | Client transport boundary | Core test helpers | Required tags are verified before routing, storage, or decryption, with shared strict getters. [VERIFIED: Phase 2 verification and `src/utils/tag-cardinality.ts`] |
| Rust reference reproduction | `refs/mdk` test crates | TypeScript conformance tests | MDK produces/reference-checks Rust results; TS tests compare production behavior without importing Rust at runtime. [VERIFIED: Phase 1/4 verification artifacts] |
| Release evidence | Planning/verification artifact | CI job logs | A durable record maps requirements to exact commands, versions, outputs, and immutable revisions. [VERIFIED: Phase 1-4 verification artifact pattern] |

## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| QA-01 | Full test suite green across all supported runtimes (Node 20/22/24, Deno 2, Bun latest/1.1) at milestone end. [VERIFIED: `.planning/REQUIREMENTS.md`] | Preserve the existing six-job runtime matrix, execute both the normal and isolated extended suite in every job, and record per-job versions and immutable CI links. [VERIFIED: `.github/workflows/tests.yml`, Vitest configs; RESOLVED Phase 5 research decision] |
| QA-02 | Every catch-up change with a byte-exact MDK counterpart is cross-checked against the Rust reference output and the result recorded. [VERIFIED: `.planning/REQUIREMENTS.md`] | Produce four dossiers: proof v2, KeyPackage lifetime boundary, tag-cardinality event shapes/rejections, and SafeAAD/LeafNode dictionary bytes. [VERIFIED: roadmap success criterion and Phase 1/2/4 artifacts] |

## Project Constraints (from AGENTS.md)

- Use pnpm; CI uses pnpm 10 with `--frozen-lockfile`. [VERIFIED: `AGENTS.md`]
- Use `pnpm build` for the library build, `pnpm compile` for focused compilation, `pnpm vitest run` for one-shot tests, and never use `pnpm test` as a release command because it starts watch mode. [VERIFIED: `AGENTS.md`, `package.json`]
- Tests must remain under `src/**/*.test.ts`; the extended `.spec.ts` corpus is intentionally isolated behind its separate config. [VERIFIED: `AGENTS.md`, Vitest configs]
- CI support is Node 20/22/24, Deno 2, and Bun latest/1.1. [VERIFIED: `AGENTS.md`, `.github/workflows/tests.yml`]
- Production remains ESM TypeScript with NodeNext `.js` relative imports, named exports, strict compiler checks, `Uint8Array` binary data, and no runtime-specific API that breaks Deno or Bun. [VERIFIED: `AGENTS.md`, TypeScript configs]
- Integration tests use in-memory stores and mock Nostr networking, not live relays. [VERIFIED: `AGENTS.md`]
- Preserve the existing Applesauce-backed Nostr event/verifier surface and public package imports; Phase 5 needs regression execution, not a second event store, signer, or transport stack. [VERIFIED: project Applesauce skill and existing client imports]
- The spec and MDK submodules are wire-format sources of truth; check both for upstream changes at phase start, inspect relevant diffs, fast-forward safe linear updates, and commit pointer bumps separately as `chore(refs):`. [VERIFIED: `AGENTS.md`]
- Do not hand-roll convergence, fork recovery, or wire encoding without first checking MDK; any divergence must be recorded. [VERIFIED: `AGENTS.md`]
- Use current topic-organized spec citations rather than deprecated `MIP-NN` citations. [VERIFIED: `AGENTS.md`]
- Commit a completed feature only after build/tests pass, keep unrelated work separate, and do not commit on `master`; the current branch is `dark-matter`. [VERIFIED: `AGENTS.md`, git branch probe]
- Single-device wire interoperability is the milestone finish line; multi-device and push are out of scope. [VERIFIED: `AGENTS.md`]

## Standard Stack

### Core

| Tool | Version / target | Purpose | Why Standard |
|---|---|---|---|
| Vitest | 3.2.6 resolved in the project metadata | Normal and extended test execution | It is the existing repository runner and `vitest run` is its one-shot command. [VERIFIED: `package.json`, `pnpm-lock.yaml`] [CITED: https://vitest.dev/guide/cli.html] |
| TypeScript | 6.0.3 project target | Strict library compile | `pnpm compile` invokes the established `tsc -b tsconfig.build.json` gate. [VERIFIED: `package.json`] |
| pnpm | CI 10; local 12.3.4 | Frozen dependency installation and executable dispatch | CI explicitly pins 10; the local binary is not version-equivalent and is smoke-only evidence. [VERIFIED: CI config and local probe] |
| GitHub Actions | Existing test/build workflows | Authoritative missing-version matrix | It already provisions all QA-01 targets with recursive submodules. [VERIFIED: `.github/workflows/tests.yml`, `.github/workflows/build.yml`] |
| Cargo/Rust | cargo 1.97.1, rustc 1.97.1 locally | Reproduce MDK outputs/tests | The checked-out MDK is a Rust workspace and the required toolchain is locally executable. [VERIFIED: local command probe, `refs/mdk/Cargo.toml`] |

### Supporting

| Tool | Version / target | Purpose | When to Use |
|---|---|---|---|
| Node.js | CI 20.x/22.x/24.x; local 22.23.1 | Primary suite and build | Use local Node 22 for fast feedback and CI for the complete Node matrix. [VERIFIED: CI config and local probe] |
| Deno | CI v2.x; local 2.9.4 | npm-compatibility runtime gate | Invoke the exact repository command with `--node-modules-dir=auto`. [VERIFIED: CI config and local probe] |
| Bun | CI latest/1.1; local 1.3.14 | alternate runtime gate | Use `bun run vitest run`, which invokes the package executable; do not substitute Bun's native test runner. [VERIFIED: CI config] [CITED: https://bun.sh/docs/runtime] |
| Existing conformance harness | Repository-local | MDK manifest, canonical snapshots, named scenarios, pressure suite | Reuse it for reference evidence rather than creating a second runner. [VERIFIED: `src/__tests__/conformance/*`] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Existing GitHub Actions matrix | Local runtime installers/containers | Local installation would add unneeded state and still would not provide immutable hosted job evidence; CI is already configured for every required version. [VERIFIED: CI config and local tool audit] |
| Checked-in Rust-produced fixtures | Generate expectations dynamically during every TS test | Dynamic generation couples two toolchains and can let simultaneous regressions agree; immutable fixtures plus separate regeneration preserve an independent oracle. [VERIFIED: Phase 1/4 verification pattern] |
| Existing normal/extended split | Broaden root Vitest discovery to include `.spec.ts` | Broadening can run the pressure corpus twice or make every runtime job unnecessarily expensive. [VERIFIED: Vitest configs and Phase 4 verification] |

**Installation:** No external package installation is required for Phase 5; use the existing frozen lockfile and checked-out submodules. [VERIFIED: package/CI audit]

## Package Legitimacy Audit

No new packages are recommended or required, so the package-legitimacy gate does not apply. [VERIFIED: research scope and existing stack audit]

## Architecture Patterns

### System Architecture Diagram

```text
immutable superproject commit + recursive submodule SHAs
                         |
        +----------------+----------------+
        |                                 |
        v                                 v
 CI runtime matrix                 Rust reference probes
 Node 20/22/24                     proof / lifetime /
 Deno 2                            tags / SafeAAD
 Bun latest/1.1                           |
        |                                 v
        v                          exact bytes/outcomes
 normal Vitest suite                      |
 + explicit extended suite                |
        +----------------+----------------+
                         v
             consolidated quality record
            commands + versions + counts
             SHAs + outputs + job URLs
                         |
                         v
                  QA-01 / QA-02 gate
```

The diagram reflects the existing CI/test/reference boundaries; the quality record is the new aggregation point, not a new protocol layer. [VERIFIED: codebase architecture and verification artifacts]

### Recommended Project Structure

```text
.github/workflows/tests.yml                 # authoritative runtime matrix
src/__tests__/conformance/                  # reusable MDK scenario harness
src/__tests__/fixtures/                     # immutable Rust outputs
src/core/**/__tests__/                      # focused byte/boundary tests
.planning/phases/05-quality-gate/
├── 05-RESEARCH.md                          # planning input
└── 05-QUALITY-GATE.md                      # execution evidence (recommended)
```

This structure reuses current ownership boundaries and adds only the consolidated evidence record unless a demonstrated failure requires a focused test/fix. [VERIFIED: repository structure]

### Pattern 1: Evidence Bound to an Immutable Revision

**What:** Record the superproject commit, `refs/marmot` SHA, `refs/mdk` SHA, UTC date, runtime/tool versions, exact command, exit status, test-file/test counts, and CI run/job URL for each gate. [VERIFIED: completed verification artifact conventions plus QA requirement scope]

**When to use:** For every matrix row and every cross-implementation dossier. [VERIFIED: QA-01/QA-02]

```markdown
| Runtime | Version | pnpm | Command | Files/Tests | Exit | Evidence |
|---|---:|---:|---|---:|---:|---|
| Node | 20.x | 10.x | `pnpm vitest run` | ... | 0 | CI job URL |
```

The exact counts must come from the actual run rather than this research document. [VERIFIED: evidence integrity requirement]

### Pattern 2: Independent Oracle Plus Negative Control

**What:** Generate or locate the Rust result at the pinned MDK revision, compare TS production output byte-for-byte or outcome-for-outcome, and retain a mutation/one-over-boundary case proving the comparison is sensitive. [VERIFIED: Phase 1 proof fixture and Phase 4 conformance patterns]

**When to use:** Proof v2, lifetime limits, required-tag cardinality, and SafeAAD dictionary bytes. [VERIFIED: roadmap criterion 4]

### Pattern 3: Local Smoke, CI Authority

**What:** Run available local versions first for rapid diagnosis, then require the hosted matrix for versions missing locally. [VERIFIED: local environment and CI audit]

**When to use:** QA-01, because no local Node 20/24 or Bun 1.1 executable is installed; the authoritative CI gate executes both the normal and isolated extended suite on all six required runtime jobs. [VERIFIED: local probe; RESOLVED Phase 5 research decision]

### Anti-Patterns to Avoid

- **Claiming matrix coverage from one local binary:** a Node 22 pass is not evidence for Node 20 or 24. [VERIFIED: QA-01 wording and local probe]
- **Calling `pnpm test`:** it starts Vitest watch mode and is unsuitable for a terminating gate. [VERIFIED: `AGENTS.md`, `package.json`]
- **Running only the root config:** `extended.spec.ts` is excluded from `src/**/*.test.ts`; every one of the six runtime jobs must invoke the isolated extended suite separately. [VERIFIED: Vitest configs; RESOLVED Phase 5 research decision]
- **Regenerating expected bytes inside the assertion:** this can turn the reference into a shared implementation rather than an independent oracle. [VERIFIED: existing immutable fixture pattern]
- **Treating historical verification prose as current evidence:** Phase 5 must bind results to the final candidate commit and current submodule SHAs. [VERIFIED: QA-01 says “at milestone end”]
- **Silently skipping unsupported or failing conformance entries:** the current harness requires explicit representation and typed unsupported outcomes. [VERIFIED: Phase 4 verification]
- **Changing production code preemptively:** first isolate a reproducible failing runtime/reference case, then make the smallest portable fix and rerun the full gate. [VERIFIED: quality-gate scope and project constraints]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Runtime provisioning | Ad-hoc shell version downloader | Existing setup-node/setup-deno/setup-bun CI jobs | The declared versions and commands already exist in versioned workflow configuration. [VERIFIED: `.github/workflows/tests.yml`] |
| Test orchestration | A second custom runner | Vitest normal and extended configs | Existing discovery and reporters provide consistent exit status/counts. [VERIFIED: Vitest configs] |
| Wire encoding oracle | A TS reimplementation of MDK rules | Checked-in MDK fixtures and focused Rust probes | An independent implementation is necessary for meaningful interop evidence. [VERIFIED: QA-02 and Phase 1/4 precedent] |
| Cryptography | Custom hashes/signatures | Existing production noble/MLS functions and Rust reference APIs | The comparison must exercise shipping code, not a test-only crypto clone. [VERIFIED: existing proof/conformance tests] |
| Tag parsing | Per-call `find()` logic | `getSingletonTagValue` / `getListTag` | The shared functions enforce repeated, empty, extra-value, and duplicate-list rejection consistently. [VERIFIED: `src/utils/tag-cardinality.ts`] |

**Key insight:** Phase 5 should aggregate independent evidence and repair demonstrated defects; duplicating runners or codecs would weaken the gate. [VERIFIED: project test architecture]

## Byte-Exact MDK Cross-Check Requirements

### 1. Proof v2

- Use the repository fixture `src/__tests__/fixtures/proof-v2-rust.json`, generated from MDK's account-identity-proof implementation, and verify its event id and 64-byte signature through production TS functions. [VERIFIED: Phase 1/4 verification and fixture test]
- Record the exact fixture fields, MDK SHA, Rust reproduction command, and focused TS command; do not record only “test passed.” [VERIFIED: QA-02 evidence need]
- Retain the canonical-event mutation negative control and full leaf verification path. [VERIFIED: `darkmatter-invite-compat.test.ts`]
- Because MDK now supports a current component profile in addition to the milestone's legacy version-byte-2 proof format, state explicitly which profile the fixture covers rather than conflating the two. [VERIFIED: `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`]

### 2. KeyPackage Lifetime

- Cross-check the accepted cap `not_after - not_before == 7,261,200` and rejected one-over value `7,261,201`, plus expired/not-yet-current cases, against MDK/OpenMLS validation outcomes. [VERIFIED: spec, TS timestamp tests, MDK `validate_key_package_lifetime_policy`]
- Record both decoded `not_before`/`not_after` integers and the serialized Lifetime extension/KeyPackage bytes for a deterministic fixed-time case; behavior-only booleans are insufficient when a byte counterpart is available. [VERIFIED: QA-02 wording and MLS KeyPackage structure]
- Keep the produced default distinct from the maximum: TS produces an 84-day `7,257,600`-second interval while accepting up to `7,261,200`. [VERIFIED: `src/utils/timestamp.ts`]
- Run the Rust focused lifetime tests and TS timestamp/KeyPackage tests, then include their exact commands and outputs in the record. [VERIFIED: MDK `group_creation.rs` and TS test inventory]

### 3. Required-Tag Cardinality

- Cover every table row: 445 `h`; 1059 `p`; 444 `e` and `relays`; 30443 `d`, `i`, `mls_protocol_version`, `mls_ciphersuite`, `mls_extensions`, `mls_proposals`, and `app_components`. [VERIFIED: `refs/marmot/transports/nostr.md`, `TAG_CARDINALITY`]
- For singleton tags compare canonical one-value arrays and reject missing, repeated, empty, and extra-value arrays; for list tags additionally reject empty and duplicate-value arrays. [VERIFIED: spec and TS helper implementation]
- MDK's KeyPackage publisher provides a deterministic canonical 30443 tag order, but the inspected adapter source does not expose a general inbound cardinality oracle for all listed event kinds. [VERIFIED: `refs/mdk/crates/transport-nostr-adapter/src/key_package.rs` and codebase grep] Therefore the dossier must separate byte-exact producer comparison from spec-derived rejection-matrix comparison and must not falsely label the latter as Rust-produced. [VERIFIED: source audit]
- If a Rust probe is added, keep it test-only in MDK or use an existing public parser; do not add production code to either project solely for evidence generation. [VERIFIED: Phase 1 fixture-generation precedent]

### 4. SafeAAD / Leaf Dictionary

- Reproduce MDK `leaf_app_components_extension` bytes at the pinned revision using the same deterministic component set/ciphersuite as TS, then compare the complete serialized `app_data_dictionary` extension hex. [VERIFIED: MDK `app_components.rs` and TS dictionary test]
- Assert component `0x0002` contains `encode_components_list(empty) == 00`, is advertised only in LeafNode data, and is rejected from GroupContext state. [VERIFIED: MDK/TS SafeAAD tests and spec registry]
- Rerun after MDK `b4649c01`, because default MLS capability advertisements changed even though the SafeAAD component encoding did not. [VERIFIED: MDK diff]
- The current TS golden hex is `00061b1a0001131200018001800380048005800680078008800c00020100`; Phase 5 must regenerate the Rust side rather than merely restating this string. [VERIFIED: `dictionary.test.ts`]

## Evidence Format

The recommended `05-QUALITY-GATE.md` should contain: [VERIFIED: QA-01/QA-02 and prior verification patterns]

1. A provenance header with superproject, Marmot spec, and MDK SHAs plus UTC timestamp. [VERIFIED: submodule-based reference model]
2. A runtime table with exact resolved runtime and pnpm versions, install command, test command, exit code, test-file/test counts, duration, and CI job URL. [VERIFIED: CI matrix and prior verification records]
3. Separate compile, `pnpm build`, normal suite, extended suite, and formatting results; none should be implied by another row, and every runtime row must contain results for both Vitest configs. [VERIFIED: distinct package scripts/configs; RESOLVED Phase 5 research decision]
4. A QA-02 table with counterpart, TS artifact/test, Rust source/test, reproduction command, expected and actual bytes/outcomes, result, and negative control. [VERIFIED: existing proof/vector evidence pattern]
5. A failure/repair ledger naming the failing runtime/vector, root cause, commit, focused rerun, and complete rerun. [VERIFIED: quality-gate diagnostic workflow]
6. A final requirement map that marks QA-01/QA-02 complete only when every required row has primary evidence. [VERIFIED: GSD verification format]

## Common Pitfalls

### Pitfall 1: “Latest” Is Not Reproducible

**What goes wrong:** A Bun “latest” pass cannot later be tied to a concrete runtime build. [VERIFIED: matrix uses `latest`]  
**Why it happens:** Workflow input is a moving label. [VERIFIED: `.github/workflows/tests.yml`]  
**How to avoid:** Capture `bun --version` and `bun --revision` inside the evidence-producing job. [CITED: https://bun.sh/docs/installation]  
**Warning signs:** The record contains only `latest`, without the resolved version/revision. [VERIFIED: evidence completeness rule]

### Pitfall 2: Extended Conformance Is Accidentally Omitted

**What goes wrong:** The normal suite passes while `extended.spec.ts` never executes. [VERIFIED: config include patterns]  
**Why it happens:** Root discovery matches `.test.ts`, not `.spec.ts`. [VERIFIED: `vitest.config.ts`]  
**How to avoid:** Run the isolated extended config as a separate gate on Node 20/22/24, Deno 2, and Bun latest/1.1, using the runtime-appropriate executable form. [VERIFIED: package script and Vitest config; RESOLVED Phase 5 research decision]
**Warning signs:** Output has no `extended.spec.ts` row. [VERIFIED: test inventory]

### Pitfall 3: Local pnpm Drift Is Hidden

**What goes wrong:** A local pass under pnpm 12.3.4 is reported as equivalent to CI's pnpm 10 frozen install. [VERIFIED: local/CI probes]  
**Why it happens:** Commands look identical after dependencies are already installed. [VERIFIED: environment audit]  
**How to avoid:** Record package-manager version and make CI the release authority. [VERIFIED: evidence strategy]  
**Warning signs:** Evidence lacks `pnpm --version` or install output. [VERIFIED: evidence completeness rule]

### Pitfall 4: A Golden Hex Becomes Self-Referential

**What goes wrong:** TS expected bytes are regenerated by TS or copied from the TS assertion and called MDK evidence. [VERIFIED: oracle independence requirement]  
**Why it happens:** The existing golden string is convenient. [VERIFIED: `dictionary.test.ts`]  
**How to avoid:** Capture the Rust output independently at the pinned SHA and retain its command/output. [VERIFIED: Phase 1 fixture precedent]  
**Warning signs:** No Rust command or MDK source revision accompanies the value. [VERIFIED: QA-02]

### Pitfall 5: Tag Semantics Are Misnamed Byte Parity

**What goes wrong:** A TS-only rejection table is described as byte-exact MDK output. [VERIFIED: MDK adapter audit]  
**Why it happens:** Cardinality is primarily a validation rule rather than an encoded binary structure. [VERIFIED: transport spec]  
**How to avoid:** Compare canonical producer arrays byte-for-byte where MDK emits them, and label rejection cases as spec/behavior parity unless a Rust parser/probe actually produced the outcomes. [VERIFIED: source audit]  
**Warning signs:** The record has no Rust function/test for a claimed Rust rejection result. [VERIFIED: provenance requirement]

### Pitfall 6: Current MDK Capability Change Is Ignored

**What goes wrong:** Leaf/KeyPackage bytes are compared against a pre-`b4649c01` expectation that includes default MLS capability advertisements. [VERIFIED: MDK diff]  
**Why it happens:** The commit leaves implicit support intact while changing signed advertisements. [VERIFIED: MDK diff]  
**How to avoid:** Regenerate current MDK output and add an explicit assertion that default MLS extension/proposal types are omitted from advertised lists but accepted as supported. [VERIFIED: MDK `capabilities.rs`]  
**Warning signs:** RequiredCapabilities/default proposals appear in leaf advertisement hex. [VERIFIED: RFC-commented MDK implementation]

## Code Examples

### Exact Runtime Commands

```bash
# Node matrix (each CI-provisioned version: 20.x, 22.x, 24.x)
pnpm install --frozen-lockfile
pnpm vitest run

# Deno 2
deno run -A --node-modules-dir=auto npm:vitest run
deno run -A --node-modules-dir=auto npm:vitest run --config vitest.extended.config.ts

# Bun latest and 1.1
bun run vitest run
bun run vitest run --config vitest.extended.config.ts

# Node 20/22/24 isolated pressure suite
pnpm conformance:extended

# Library gates
pnpm compile
pnpm build
pnpm lint
```

These commands are repository-defined; `pnpm lint` is formatting-only and must not be described as semantic linting. [VERIFIED: `AGENTS.md`, CI, `package.json`]

### Exact Byte Comparison Pattern

```typescript
expect(bytesToHex(actualProductionBytes)).toBe(rustFixture.expectedHex);
expect(() => decodeProductionBytes(mutatedBytes)).toThrow();
```

This pattern mirrors the existing immutable Rust fixture and mutation-control approach; actual Phase 5 code should reuse current production helpers and fixture loaders. [VERIFIED: proof and conformance tests]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Advertise default MLS extension/proposal capabilities explicitly | Treat RFC 9420 defaults as implicit support and omit them from signed advertisements | MDK `b4649c01`, 2026-09-06 | Regenerate capability/KeyPackage bytes at the current reference SHA. [VERIFIED: MDK commit diff] |
| One-off proof fixture generation | Repository-local Rust fixture exercised permanently through production verification | Phases 1 and 4 | Phase 5 can reproduce and record rather than invent a new harness. [VERIFIED: Phase summaries/verification] |
| Manual MDK vector spot checks | Strict manifest, canonical snapshot, named-vector runner, and isolated pressure suite | Phase 4 | Phase 5 should execute all established seams and record results. [VERIFIED: Phase 4 verification] |
| MIP-number source citations | Topic-organized `refs/marmot/...` citations | Current project rule | New evidence and any repairs must cite current paths. [VERIFIED: `AGENTS.md`] |

**Deprecated/outdated:** `pnpm test` for release verification is inappropriate because it is watch mode; stale `MIP-NN` citations are deprecated; explicit advertisement of RFC-default MLS capabilities is outdated after MDK `b4649c01`. [VERIFIED: `AGENTS.md`, package scripts, MDK diff]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A2 | No production changes will be required once the current matrix and MDK probes execute. [ASSUMED] | Scope | Any demonstrated failure must become a focused defect-fix task with full reruns. |

## Resolved Decisions

1. **(RESOLVED) The extended pressure suite runs on all six runtime jobs.**
   - What we know: it is separate from the normal suite and Phase 4 verified it on Node in three fresh processes. [VERIFIED: configs and Phase 4 verification]
   - Decision: execute both the normal suite and isolated extended suite under Node 20, Node 22, Node 24, Deno 2, Bun latest, and Bun 1.1; no runtime receives an extended-suite exemption. [VERIFIED: RESOLVED Phase 5 research decision]

2. **(RESOLVED) The tag-cardinality dossier separates Rust-produced bytes from specification-derived rejection parity.**
   - What we know: MDK emits canonical 30443 tag arrays, while the spec defines exact rejection semantics and TS implements the full table. [VERIFIED: MDK adapter, spec, TS source]
   - Decision: record Rust-produced canonical kind-30443 tag/event byte parity, then record the complete rejection matrix as specification-derived TS behavior; do not create or claim a Rust rejection oracle that MDK does not expose. [VERIFIED: RESOLVED Phase 5 research decision]

3. **(RESOLVED) Include the MDK `b4649c01` implicit-capability delta inside the SafeAAD/KeyPackage dossier.**
   - What we know: the delta can change signed Leaf/KeyPackage capability bytes and arrived at Phase 5 start. [VERIFIED: MDK diff]
   - Decision: compare against the current reference and document implicit-default capability omission in that existing dossier rather than creating a separate fifth dossier. [VERIFIED: RESOLVED Phase 5 research decision]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---:|---:|---|
| Node.js | Local normal/extended suite and compile | ✓ | 22.23.1 | GitHub Actions for 20.x/24.x. [VERIFIED: local probe, CI] |
| pnpm | Install and Node commands | ✓ | 12.3.4 local; 10 in CI | CI is authoritative for frozen pnpm-10 evidence. [VERIFIED: local probe, CI] |
| Deno | Deno runtime gate | ✓ | 2.9.4 | CI v2.x for immutable evidence. [VERIFIED: local probe, CI] |
| Bun | Bun runtime gate | ✓ | 1.3.14 | CI latest/1.1; no local 1.1 binary found. [VERIFIED: local probe, CI] |
| Cargo | MDK reproduction | ✓ | 1.97.1 | CI or documented Rust toolchain if local MDK constraints reject it. [VERIFIED: local probe] |
| rustc | MDK reproduction | ✓ | 1.97.1 | Same as Cargo. [VERIFIED: local probe] |
| Node 20 executable | Local matrix | ✗ | — | Existing GitHub Actions job. [VERIFIED: local probe, CI] |
| Node 24 executable | Local matrix | ✗ | — | Existing GitHub Actions job. [VERIFIED: local probe, CI] |
| Bun 1.1 executable | Local matrix | ✗ | — | Existing GitHub Actions job. [VERIFIED: local probe, CI] |

**Missing dependencies with no fallback:** None; hosted CI provisions all missing matrix versions. [VERIFIED: `.github/workflows/tests.yml`]

**Missing dependencies with fallback:** Node 20, Node 24, and Bun 1.1 are absent locally and must use their existing CI matrix jobs. [VERIFIED: local probe, CI]

## Security Domain

Security enforcement is enabled because `.planning/config.json` does not set `security_enforcement: false`. [VERIFIED: `.planning/config.json`]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | yes | Proof-v2 signature verification and Nostr event signature verification remain in the regression suite. [VERIFIED: Phase 1/2 verification] |
| V3 Session Management | no | This library has MLS group state/lifecycle, not web login sessions. [VERIFIED: project architecture] |
| V4 Access Control | yes | Admin authorization, member coupling, terminal-state outbound gates, and convergence legality remain regression-gated. [VERIFIED: Phase 3/04.1 verification] |
| V5 Input Validation | yes | Strict tag cardinality, KeyPackage lifetime, manifest validation, fixture path containment, and binary decoder failures are tested. [VERIFIED: Phase 2/4 verification] |
| V6 Cryptography | yes | Use ts-mls, noble primitives, and MDK outputs; no custom cryptographic implementation is introduced. [VERIFIED: package/code architecture] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Forged Nostr metadata reaches routing before signature verification | Spoofing / Tampering | Verify event id/signature before tag reads, dedup, decrypt, or storage; keep Phase 2 regressions green. [VERIFIED: Phase 2 verification] |
| Duplicate/empty required tags exploit first-match parsing | Tampering | Shared exact-cardinality getters plus entry-point tests for every required shape. [VERIFIED: tag-cardinality source/tests] |
| Malicious manifest artifact escapes fixture root | Tampering / Information disclosure | Strict relative path and resolved-root containment checks. [VERIFIED: Phase 4 verification] |
| Over-long or stale KeyPackage remains eligible | Spoofing / Elevation of privilege | Validate current Lifetime and maximum range at every consumption path. [VERIFIED: Phase 2 verification]
| Runtime-specific API silently breaks Deno/Bun | Denial of service | Execute identical suite under each runtime and keep Node APIs test-only. [VERIFIED: CI/project constraints] |
| Reference drift invalidates golden bytes | Tampering / Integrity failure | Pin and record submodule SHAs, inspect updates, and regenerate Rust outputs before release. [VERIFIED: `AGENTS.md` and current MDK update] |

## Sources

### Primary (HIGH confidence)

- `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` — Phase 5 goal, QA-01, QA-02, and acceptance matrix. [VERIFIED: codebase grep]
- `AGENTS.md`, `.github/workflows/tests.yml`, `.github/workflows/build.yml`, `package.json`, and Vitest configs — commands, versions, suite boundaries, and project constraints. [VERIFIED: codebase grep]
- Phase 1-4.1 `*-VERIFICATION.md`, `*-REVIEW.md`, and summaries — completed behavior/evidence and known prior risks. [VERIFIED: codebase grep]
- `refs/marmot/transports/nostr.md`, `foundation/key-packages.md`, and registries — exact tag, lifetime, and SafeAAD contracts. [VERIFIED: pinned spec submodule]
- `refs/mdk/crates/cgka-engine/{src,tests}` and `refs/mdk/crates/transport-nostr-adapter` — Rust proof, lifetime, SafeAAD, capabilities, and 30443 event behavior. [VERIFIED: pinned MDK submodule]
- Local executable/version and git ancestry probes performed 2026-09-06. [VERIFIED: local command probe]

### Secondary (MEDIUM confidence)

- Vitest CLI documentation — `vitest run` is the explicit one-shot command. [CITED: https://vitest.dev/guide/cli.html]
- Bun runtime/installation documentation — `bun run` package-executable behavior and resolved version/revision commands. [CITED: https://bun.sh/docs/runtime] [CITED: https://bun.sh/docs/installation]

### Tertiary (LOW confidence)

- No source-dependent LOW-confidence claim remains; the only assumption is whether execution will reveal production defects. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — directly inspected package metadata, lockfile, CI, and local binaries. [VERIFIED: codebase/local probes]
- Architecture: HIGH — the test/reference seams already exist and have passed Phase 4 verification. [VERIFIED: Phase 4 verification]
- Pitfalls: HIGH — they are direct consequences of config boundaries, environment drift, current MDK diffs, and the resolved all-runtime suite requirement. [VERIFIED: codebase/local probes; RESOLVED Phase 5 research decision]

**Research date:** 2026-09-06  
**Valid until:** 2026-09-13 — the reference submodules move independently and the matrix contains a moving `latest` target. [VERIFIED: `AGENTS.md`, CI config]
