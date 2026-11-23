# Conformance campaigns

`pnpm conformance` runs the complete suite: seven MDK-backed scenarios, adapter
validation, manifest/codec smoke checks, negative oracle tests, and campaign-runner
tests. All tests and conformance-specific helpers live in this folder, with one
Vitest configuration. There is no separate extended suite.

Each repetition uses a fresh Node/Vitest process. Optional `--case` selection runs
only the named scenario for diagnosis or repeated measurements. This is not yet a
general MDK Scenario IR or JSONL node adapter.

## Run

From the repository root, with Node 20+ and dependencies installed:

```sh
pnpm conformance --list
pnpm conformance
pnpm conformance --case convergence-witness-selected/v1 --repeat 10
pnpm conformance --case deferred-tick-catchup/v1 --out /tmp/opencode/catchup-first
```

The default worker deadline is 120 seconds for the entire suite (or selected case),
adjustable with `--timeout-ms`.
Existing test-level timeouts remain 60 seconds. Runs are sequential, with no
automatic retry: any failed repetition makes the campaign fail. Unknown cases
are rejected before execution. On POSIX, a deadline kills the worker process group,
including Vitest children. SIGINT/SIGTERM during a worker also kills that group and
stops the campaign with a failed summary.

## Evidence

Each invocation creates a new directory under `conformance/results/` (ignored by
Git), or the exact new directory specified by `--out`. Existing directories are
refused. Preserve the directory for failed runs.

- `campaign.json`: source/reference revisions and dirty flags, runtime, lockfile
  hash, selected cases, input hashes, and explicit coverage limits.
- `inputs/`: exact bytes of the seven registered scenario fixtures.
- Per-run directories: stdout, stderr, Vitest JSON, command, exit/signal,
  deadline status, wall time, and validated result.
- `summary.json`: overall status and suite or selected-case timing distributions.

A successful full-suite worker must report every discovered test as passed and
include all seven registered scenarios. A selected-case worker must report exactly
one passing selected test. Both require unchanged fixture hashes. A missing report,
empty selection, timeout, or unsuccessful process cannot become a green result.
The broad manifest/parser smoke tests run with the suite but are not counted as
additional scenario execution coverage.

The workers currently import fixtures from the checkout. Saved inputs are evidence,
not a standalone replay API: reproduce with the recorded revisions, lockfile,
fixture bytes and command. Dirty-source runs are diagnostic, not exact released
build evidence. If the coordinator is interrupted, completed per-case records remain;
an absent summary means the campaign is incomplete.

## Coverage and timing interpretation

`catalog.mjs` explicitly lists six named convergence/admin/metadata/invite vectors
and the deferred-tick catchup vector. `--list` reports other upstream scenario
vectors as not run. The existing tests and their assertion logic remain in
`conformance/tests/`.

These tests use production TypeScript group logic and cryptography with in-memory
storage and mock networking. Group formation is preconstructed and publication
acknowledgements are synchronous. Their assertions are useful regression coverage,
but do not claim full MDK strict-oracle equivalence, disk crash recovery, real relay
behavior, or Rust/TypeScript interoperability.

`testMs` is the sum of Vitest test durations (or the selected test's duration),
including actor setup, cryptography and assertions. `wallMs` includes process startup,
module loading and shutdown. Percentiles use nearest-rank successful samples only;
failed repetitions are reported separately and still fail the campaign. Small
sample percentiles are descriptive, not performance guarantees. There are no
warmup exclusions or performance thresholds in this first pass.

CPU, RSS, heap, GC, event-loop delay, message latency and throughput are not measured
yet. Each repetition starts fresh; this is not a long-lived memory-leak soak test.

## Extending coverage

New `*.test.ts` and `*.test.mjs` files in this folder are automatically included in
the full run. Add fixture-backed scenarios and their exact test titles to
`catalog.mjs` to expose case selection and saved fixture evidence.
Keep each registered test independently runnable and reject unsupported semantics.
The next adapter boundary is MDK's
`crates/cgka-conformance-simulator/src/node_protocol.rs`; it enables real relay,
persistent participant and mixed Rust/TypeScript campaigns. A general deterministic
adapter should implement whole-scenario capability preflight and complete expected
outcome validation before claiming additional upstream vectors.
