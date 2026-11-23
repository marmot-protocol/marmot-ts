import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { cases } from "./catalog.mjs";
import {
  distribution,
  parseArgs,
  runWorker,
  validateReport,
} from "./runner.mjs";

test("unknown cases and invalid deadlines fail before launching workers", () => {
  for (const args of [
    ["--case", "unimplemented/v1"],
    ["--repeat", "0"],
    ["--repeat", "1.5"],
    ["--timeout-ms", "Infinity"],
    ["--timeout-ms", "2147483648"],
    ["--out"],
    ["--unknown"],
  ])
    assert.throws(() => parseArgs(args));
});

test("success requires actual selected execution, not an empty or skipped run", () => {
  const entry = { testName: "expected scenario" };
  const report = {
    success: true,
    numPassedTests: 1,
    numFailedTests: 0,
    testResults: [
      {
        assertionResults: [
          { title: entry.testName, status: "passed", duration: 12 },
        ],
      },
    ],
  };
  assert.equal(validateReport(report, entry), 12);
  for (const invalid of [
    { ...report, success: false },
    { ...report, numPassedTests: 0 },
    { ...report, numFailedTests: 1 },
    { ...report, numRuntimeErrorTestSuites: 1 },
    { ...report, testResults: [] },
    {
      ...report,
      testResults: [
        { assertionResults: [{ title: entry.testName, status: "pending" }] },
      ],
    },
  ])
    assert.throws(() => validateReport(invalid, entry));
  assert.throws(() =>
    validateReport(report, { testName: "different scenario" }),
  );
});

test("timings distinguish no successful samples from zero elapsed time", () => {
  assert.equal(distribution([]), null);
  assert.deepEqual(distribution([10, 0, 20]), {
    samples: 3,
    min: 0,
    p50: 10,
    p95: 20,
    p99: 20,
    max: 20,
  });
});

test("the full-suite gate rejects missing scenarios, skips and partial success", () => {
  const assertions = [
    ...cases.map((entry) => ({
      title: entry.testName,
      status: "passed",
      duration: 1,
    })),
    { title: "adapter check", status: "passed", duration: 2 },
  ];
  const report = {
    success: true,
    numPassedTests: assertions.length,
    numFailedTests: 0,
    testResults: [{ assertionResults: assertions }],
  };
  assert.equal(validateReport(report, { id: "all" }), cases.length + 2);
  assert.throws(() =>
    validateReport(
      {
        ...report,
        numPassedTests: assertions.length - 1,
        testResults: [{ assertionResults: assertions.slice(1) }],
      },
      { id: "all" },
    ),
  );
  assert.throws(() =>
    validateReport(
      {
        ...report,
        testResults: [
          {
            assertionResults: [
              ...assertions,
              { title: "skipped", status: "pending" },
            ],
          },
        ],
      },
      { id: "all" },
    ),
  );
});

test("workers retain failure logs and enforce deadlines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marmot-campaign-"));
  try {
    const failed = await runWorker(
      "node",
      ["-e", "console.error('failure evidence'); process.exit(7)"],
      directory,
      10_000,
    );
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.timedOut, false);
    assert.match(
      await readFile(join(directory, "stderr.log"), "utf8"),
      /failure evidence/,
    );
    // Reusing a case directory cannot overwrite existing evidence.
    await assert.rejects(runWorker("node", [], directory, 100), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const timeoutDirectory = await mkdtemp(join(tmpdir(), "marmot-timeout-"));
  try {
    const result = await runWorker(
      "node",
      ["-e", "setInterval(() => {}, 1000)"],
      timeoutDirectory,
      200,
    );
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await rm(timeoutDirectory, { recursive: true, force: true });
  }
});
