export const vectorsRoot = "refs/mdk/crates/cgka-conformance-simulator/vectors";

const named = [
  "convergence-committer-selected",
  "convergence-witness-selected",
  "admin-policy-update",
  "group-data-update",
  "group-data-fork-recovery",
  "concurrent-invite-fork-recovery",
];

/** Explicit execution coverage, not the larger manifest/parser smoke inventory. */
export const cases = [
  ...named.map((name) => ({
    id: `${name}/v1`,
    fixture: `${vectorsRoot}/${name}.v1.json`,
    file: "conformance/tests/named-vectors.test.ts",
    testName: `${name}/v1 executes every step and matches its terminal outcomes`,
  })),
  {
    id: "deferred-tick-catchup/v1",
    fixture: `${vectorsRoot}/deferred-tick-catchup.v1.json`,
    file: "conformance/tests/catchup.test.ts",
    testName:
      "executes the complete pinned scenario with distinct production actors",
  },
];

export const limitations = [
  "Existing fixture-specific adapters, not a general Scenario IR executor",
  "In-memory storage and mock transport; no socket, disk, or process-restart claims",
  "Group formation is preconstructed; publication acknowledgement is synchronous",
  "Assertions are the existing TypeScript test oracles, not MDK strict-oracle parity",
  "Fresh-process scenario timings include setup and assertions; not message latency",
  "No Rust/TypeScript wire interoperability, generated campaigns, or browser coverage",
];
