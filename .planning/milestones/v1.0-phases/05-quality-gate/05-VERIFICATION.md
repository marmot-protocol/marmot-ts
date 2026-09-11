---
phase: 05-quality-gate
verified: 2026-09-06T20:40:00Z
status: passed
score: 18/18 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 17/18
  gaps_closed:
    - "The generated final quality gate and Plan 08 summary now bind source 7a71aa5 to hosted run 34057379785."
    - "The dossier validator now uses absolute worktree and shared Cargo-cache paths, so its documented default replay succeeds without a TMPDIR override."
  gaps_remaining: []
  regressions: []
---

# Phase 5: Quality Gate Verification Report

**Phase Goal:** The full test suite is green on every supported runtime, and every catch-up change with a byte-exact MDK counterpart has been cross-checked against the Rust reference output — the milestone is shippable.
**Verified:** 2026-09-06T20:40:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure commits `168355e` and `e7e267c`

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `pnpm vitest run` exits 0 on Node 20, 22, and 24. | ✓ VERIFIED | Authenticated run `34057379785`, jobs `101551632463`, `101551632408`, and `101551632481`; each immutable log was downloaded and SHA-256 checked by `validate-quality-ci.mjs`, reporting 96 files/964 tests. |
| 2 | The normal suite exits 0 on Deno 2. | ✓ VERIFIED | Job `101551632443`, Deno 2.9.6, passed 96/964; live API facts and log digest independently revalidated. |
| 3 | The normal suite exits 0 on Bun latest and Bun 1.1. | ✓ VERIFIED | Jobs `101551632502` and `101551632406`, Bun 1.4.2 and 1.1.45, passed 96/964; live API facts and log digests independently revalidated. |
| 4 | Every named byte-exact counterpart is cross-checked and recorded. | ✓ VERIFIED | Four marked dossiers exist for proof-v2, lifetime, tags, and SafeAAD. A detached replay regenerated all four Rust fixtures exactly and passed 68 TypeScript parity assertions plus four separately selected negative controls. |
| 5 | Every one of the six hosted rows runs both normal and isolated extended suites. | ✓ VERIFIED | CI logs show 96/964 normal and 1/1 extended in every row; the workflow at the tested source contains both commands for Node, Deno, and Bun matrices. |
| 6 | Locally available Node/Deno/Bun evidence is labeled smoke-only. | ✓ VERIFIED | `05-RUNTIME-EVIDENCE.md` explicitly distinguishes local smoke from hosted authority and does not infer unavailable versions. |
| 7 | CI installs pnpm 10 with `--frozen-lockfile`. | ✓ VERIFIED | All six logs report pnpm 10.34.5 and the exact `pnpm install --frozen-lockfile` step; validator rejects command/version mutations. |
| 8 | Proof-v2 output is independently reproducible at MDK `dbf45c83`, with a sensitive mutation. | ✓ VERIFIED | Rust fixture reproduced byte-for-byte; full 2-test production proof/leaf suite and separately selected mutation test passed. |
| 9 | Lifetime bytes and boundary outcomes are reproducible at MDK `dbf45c83`. | ✓ VERIFIED | Rust KeyPackage fixture reproduced byte-for-byte; 5/5 tests cover exact bytes, cap/one-over, expiry, future, and default span. |
| 10 | Lifetime evidence reflects the `b4649c01` signed-capability delta. | ✓ VERIFIED | Dossier field is schema-required; parity test distinguishes advertised from effective RFC-default extensions/proposals. |
| 11 | Rust-produced kind-30443 tags and spec-derived receiver rejection are separately labeled. | ✓ VERIFIED | Dossier classification is `rust-producer-and-spec-receiver`; 57/57 tests cover production tag equality and the specification-derived malformed matrix. |
| 12 | SafeAAD dictionary bytes are independently reproduced at MDK `dbf45c83`. | ✓ VERIFIED | Public `CgkaEngine::fresh_key_package` Rust path reproduced the fixture; 4/4 TypeScript tests passed, including byte mutation rejection. |
| 13 | SafeAAD/Leaf capability evidence accounts for `b4649c01`. | ✓ VERIFIED | Schema enforces the reviewed SHA and the test checks signed advertisements versus effective defaults. |
| 14 | All four dossiers share one immutable source/spec/MDK/lockfile tuple. | ✓ VERIFIED | Self-test and replay validate source `7a71aa56299e7f4e541f0f71a9ff392896c50243`, Marmot `4a2bc65f`, MDK `dbf45c83`, and committed lockfile digest. |
| 15 | The dossier validator fails closed for incomplete or fabricated provenance. | ✓ VERIFIED | `node scripts/validate-quality-dossiers.mjs --self-test` rejected 104 mutations. |
| 16 | The exact replayed source was pushed before authoritative CI. | ✓ VERIFIED | GitHub run `34057379785` is a push event whose live `head_sha` is exactly `7a71aa56299e7f4e541f0f71a9ff392896c50243`. |
| 17 | Authenticated evidence identifies immutable run/job IDs for all six normal+extended rows at the tested source. | ✓ VERIFIED | Independent live validation passed; CI self-test rejected 66 structurally valid fabricated log claims. |
| 18 | The final gate consolidates the final CI and dossier attestations. | ✓ VERIFIED | `render-quality-gate.mjs --check` proves `05-QUALITY-GATE.md` and `05-08-SUMMARY.md` are deterministically generated from the current CI JSON and four dossiers, naming source `7a71aa5`, run `34057379785`, and all six immutable jobs. |

**Score:** 18/18 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact group | Status | Details |
| --- | --- | --- |
| `.github/workflows/tests.yml` | ✓ VERIFIED | Substantive six-row matrix, pnpm 10, frozen install, resolved version reporting, normal and extended commands. |
| Four Rust probes and locked manifests | ✓ VERIFIED | Executed from a detached worktree; all outputs exactly matched committed fixtures. |
| Four JSON fixtures | ✓ VERIFIED | Committed at the tested source and digest-bound to Rust replay outputs. |
| Four TypeScript parity test files | ✓ VERIFIED | Exercise shipping proof, lifetime, tag-event, and SafeAAD/capability paths; 68 total assertions pass. |
| Four dossier Markdown files and schema | ✓ VERIFIED | Parsed marked JSON, common tuple enforced, negative controls and oracle provenance required. |
| `scripts/validate-quality-ci.mjs` | ✓ VERIFIED | Authenticates run/jobs, downloads logs, verifies hashes and facts, and fails closed under 66 mutations. |
| `scripts/validate-quality-dossiers.mjs` | ✓ VERIFIED | Default invocation now resolves absolute worktree/cache paths and completed all four detached replays without a `TMPDIR` override. |
| `05-CI-EVIDENCE.json` | ✓ VERIFIED | Correct final source `7a71aa5`, run `34057379785`, six unique immutable jobs, and six log hashes. |
| `scripts/render-quality-gate.mjs` | ✓ VERIFIED | Deterministically renders and checks both final evidence records from machine evidence. |
| `05-QUALITY-GATE.md` | ✓ VERIFIED | Current generated record consolidates final source `7a71aa5`, run `34057379785`, six jobs, and four dossiers. |

### Key Link Verification

| From | To | Status | Details |
| --- | --- | --- | --- |
| Workflow matrix | Runtime-specific normal + extended commands | ✓ WIRED | Confirmed in tested-source workflow and immutable logs. |
| Rust probes | Fixtures | ✓ WIRED | Locked replay stdout equals each committed fixture byte-for-byte. |
| Fixtures | Production TypeScript paths | ✓ WIRED | Complete parity files call shipping verification/decoder/event/dictionary APIs. |
| Dossiers | Dossier validator | ✓ WIRED | All four are parsed, tuple/digest/path/version checked, replayed, and mutation tested. |
| GitHub API/logs | CI JSON validator | ✓ WIRED | Live run/job facts and downloaded log hashes agree for all six jobs. |
| CI JSON + dossiers | Final quality-gate record | ✓ WIRED | Renderer `--check` binds both generated records to `7a71aa5`/`34057379785`. |

### Data-Flow Trace (Level 4)

| Artifact | Source | Produces real data | Status |
| --- | --- | --- | --- |
| CI evidence JSON | Authenticated GitHub run/job APIs plus downloaded job logs | Yes — live IDs, SHA, versions, commands, counts, and log digests | ✓ FLOWING |
| Dossier evidence | Detached tested-source worktree, locked Rust probes, committed fixtures, complete TS parity files | Yes — regenerated bytes and executable outcomes | ✓ FLOWING |
| Final quality gate | Current CI JSON and four dossier evidence blocks | Yes — deterministically rendered and `--check` verified | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Authenticate and validate six hosted rows | `node scripts/validate-quality-ci.mjs .planning/phases/05-quality-gate/05-CI-EVIDENCE.json` | Run 34057379785, attempt 1, six rows at `7a71aa5` | ✓ PASS |
| Reject fabricated CI claims | same command with `--self-test` | 66 mutations rejected | ✓ PASS |
| Reject fabricated dossier claims | `node scripts/validate-quality-dossiers.mjs --self-test` | 104 mutations rejected | ✓ PASS |
| Replay four independent dossiers | `node scripts/validate-quality-dossiers.mjs` | Default command: 4/4 fixture reproductions; 68 parity tests; 4 negative controls | ✓ PASS |
| Check generated final records | `node scripts/render-quality-gate.mjs --check` | Both records current for `7a71aa5`/`34057379785` | ✓ PASS |

### Probe Execution

| Probe | Result | Status |
| --- | --- | --- |
| proof-v2 locked Rust generator | Exact fixture equality; parity 2/2; negative 1/1 | PASS |
| lifetime locked Rust generator | Exact fixture equality; parity 5/5; negative 1/1 | PASS |
| tag locked Rust generator | Exact fixture equality; parity 57/57; negative 1/1 | PASS |
| SafeAAD locked Rust generator | Exact fixture equality; parity 4/4; negative 1/1 | PASS |

### Requirements Coverage

| Requirement | Source plans | Status | Evidence |
| --- | --- | --- | --- |
| QA-01 | 05-01, 05-07, 05-08 | ✓ SATISFIED | Authenticated final run `34057379785`: six supported versions, frozen pnpm 10, normal and extended suites all green. |
| QA-02 | 05-02 through 05-08 | ✓ SATISFIED | Four independently replayed Rust/TypeScript dossiers at one final source tuple, with passing negative controls. |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
| --- | --- | --- | --- |
| None | No blocker or warning anti-pattern remains in the re-verified evidence path. | — | — |

No unreferenced `TBD`, `FIXME`, or `XXX` markers were found in Phase 5 source artifacts.

### Human Verification Required

None. All roadmap behaviors have deterministic hosted, replay, and negative-control evidence.

### Gaps Summary

No gaps remain. QA-01 and QA-02 are satisfied at one immutable source: all six hosted runtime rows pass both suites under frozen pnpm 10, all four Rust/TypeScript dossiers replay with their negative controls using the documented default command, and the generated final gate/summary are mechanically checked against the same source and run.

---

_Verified: 2026-09-06T20:40:00Z_
_Verifier: the agent (gsd-verifier)_
