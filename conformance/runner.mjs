import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, platform, arch } from "node:os";
import { cases, limitations, vectorsRoot } from "./catalog.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function parseArgs(args) {
  const options = { repeat: 1, timeoutMs: 120_000, selected: [] };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") continue;
    if (flag === "--list" || flag === "--help") {
      options[flag.slice(2)] = true;
      continue;
    }
    if (!["--case", "--repeat", "--timeout-ms", "--out"].includes(flag))
      throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag === "--case") options.selected.push(value);
    else if (flag === "--out") options.out = resolve(value);
    else {
      const number = Number(value);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number > (flag === "--repeat" ? 10_000 : 2_147_483_647)
      )
        throw new Error(`Invalid value for ${flag}: ${value}`);
      options[flag === "--repeat" ? "repeat" : "timeoutMs"] = number;
    }
  }
  for (const id of options.selected)
    if (!cases.some((entry) => entry.id === id))
      throw new Error(`Unsupported case: ${id}; use --list`);
  return options;
}

function provenance(directory) {
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  return {
    revision: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
  };
}

/** Nearest-rank percentiles; samples are independent full-scenario executions. */
export function distribution(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

export async function runWorker(program, args, directory, timeoutMs) {
  const stdout = await open(join(directory, "stdout.log"), "wx", 0o600);
  let stderr;
  const started = performance.now();
  try {
    stderr = await open(join(directory, "stderr.log"), "wx", 0o600);
    return await new Promise((resolveResult) => {
      // A POSIX process group includes Vitest's worker processes.
      const grouped = process.platform !== "win32";
      const child = spawn(program, args, {
        cwd: root,
        stdio: ["ignore", stdout.fd, stderr.fd],
        detached: grouped,
      });
      let timedOut = false;
      let interrupted = false;
      let spawnError;
      const kill = () => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") spawnError = String(error);
        }
      };
      const interrupt = () => {
        interrupted = true;
        kill();
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      child.on("error", (error) => {
        spawnError = String(error);
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        resolveResult({
          exitCode,
          signal,
          timedOut,
          interrupted,
          spawnError,
          wallMs: performance.now() - started,
        });
      });
    });
  } finally {
    await stdout.close();
    await stderr?.close();
  }
}

export function validateReport(report, entry) {
  const assertions = report.testResults?.flatMap(
    (result) => result.assertionResults ?? [],
  );
  if (!entry.testName) {
    if (
      report.success !== true ||
      !assertions?.length ||
      report.numPassedTests !== assertions.length ||
      report.numFailedTests !== 0 ||
      (report.numRuntimeErrorTestSuites ?? 0) !== 0 ||
      assertions.some(
        (assertion) =>
          assertion.status !== "passed" ||
          !Number.isFinite(assertion.duration) ||
          assertion.duration < 0,
      ) ||
      cases.some(
        (scenario) =>
          !assertions.some(
            (assertion) => assertion.title === scenario.testName,
          ),
      )
    )
      throw new Error(
        "Expected the complete conformance suite with no skipped or failed tests",
      );
    return assertions.reduce(
      (total, assertion) => total + assertion.duration,
      0,
    );
  }
  const selected = assertions?.filter(
    (assertion) => assertion.title === entry.testName,
  );
  if (
    report.success !== true ||
    report.numPassedTests !== 1 ||
    report.numFailedTests !== 0 ||
    (report.numRuntimeErrorTestSuites ?? 0) !== 0 ||
    selected?.length !== 1 ||
    selected[0].status !== "passed" ||
    !Number.isFinite(selected[0].duration) ||
    selected[0].duration < 0
  )
    throw new Error("Expected exactly one successful selected scenario");
  return selected[0].duration;
}

export async function inventory() {
  const manifest = JSON.parse(
    await readFile(join(root, vectorsRoot, "manifest.v1.json"), "utf8"),
  );
  return {
    runnable: cases.map(({ id, fixture }) => ({ id, fixture })),
    notRun: manifest.entries
      .filter(
        (entry) =>
          entry.kind === "scenario_vector" &&
          !cases.some((candidate) => candidate.id === entry.id),
      )
      .map(({ id, status }) => ({ id, upstreamStatus: status })),
    limitations,
  };
}

export async function runCampaign(options) {
  const selected = options.selected.length
    ? cases.filter((entry) => options.selected.includes(entry.id))
    : [{ id: "all" }];
  if (!selected.length) throw new Error("No supported cases selected");
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const out =
    options.out ??
    join(root, "conformance/results", `${Date.now()}-${process.pid}`);
  // Exclusive creation prevents mixing a new run with old evidence.
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 });
  const save = (name, value) =>
    writeFile(join(out, name), json(value), { flag: "wx", mode: 0o600 });
  const metadata = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    source: provenance(root),
    mdk: provenance(join(root, "refs/mdk")),
    marmot: provenance(join(root, "refs/marmot")),
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
    },
    lockfileSha256: digest(await readFile(join(root, "pnpm-lock.yaml"))),
    adapter: "existing-typescript-fixtures/memory-mock-v1",
    options: { ...options, selected: selected.map((entry) => entry.id), out },
    coverage: await inventory(),
    inputs: [],
  };
  await mkdir(join(out, "inputs"), { mode: 0o700 });
  // Snapshot every imported fixture, including those in the shared test module.
  for (const entry of cases) {
    const bytes = await readFile(join(root, entry.fixture));
    if (JSON.parse(bytes.toString()).scenario.name !== entry.id)
      throw new Error(`Fixture identity mismatch: ${entry.id}`);
    const filename = `${entry.id.replaceAll("/", "-")}.json`;
    await writeFile(join(out, "inputs", filename), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    metadata.inputs.push({
      id: entry.id,
      source: entry.fixture,
      saved: `inputs/${filename}`,
      sha256: digest(bytes),
    });
  }
  await save("campaign.json", metadata);
  const results = [];
  campaign: for (let iteration = 1; iteration <= options.repeat; iteration++) {
    for (const entry of selected) {
      const name = `${entry.id.replaceAll("/", "-")}-${iteration}`;
      const directory = join(out, name);
      await mkdir(directory, { mode: 0o700 });
      const args = [
        vitest,
        "run",
        "--config",
        "conformance/vitest.config.mjs",
        ...(entry.testName
          ? [
              entry.file,
              "--testNamePattern",
              `${entry.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ]
          : []),
        "--reporter=json",
        "--outputFile",
        join(directory, "vitest.json"),
      ];
      const execution = await runWorker(
        process.execPath,
        args,
        directory,
        options.timeoutMs,
      );
      const result = {
        id: entry.id,
        iteration,
        artifacts: name,
        command: [process.execPath, ...args],
        ...execution,
        status: "failed",
        testMs: null,
      };
      try {
        if (execution.interrupted) throw new Error("Campaign interrupted");
        if (execution.timedOut) throw new Error("Scenario deadline exceeded");
        if (execution.spawnError) throw new Error(execution.spawnError);
        if (execution.exitCode !== 0)
          throw new Error(
            `Worker exited ${execution.exitCode} (${execution.signal})`,
          );
        const report = JSON.parse(
          await readFile(join(directory, "vitest.json"), "utf8"),
        );
        result.testMs = validateReport(report, entry);
        for (const input of metadata.inputs)
          if (digest(await readFile(join(root, input.source))) !== input.sha256)
            throw new Error(`Fixture changed during campaign: ${input.id}`);
        result.status = "passed";
      } catch (error) {
        result.error = String(error);
      }
      results.push(result);
      await save(`${name}/result.json`, result);
      console.log(
        `${result.status}: ${entry.id} #${iteration} (${Math.round(result.wallMs)} ms)`,
      );
      if (execution.interrupted) break campaign;
    }
  }
  const summary = {
    schemaVersion: 1,
    status: results.every((result) => result.status === "passed")
      ? "passed"
      : "failed",
    completedAt: new Date().toISOString(),
    results,
    timings: selected.map((entry) => ({
      id: entry.id,
      passedTestMs: distribution(
        results
          .filter((r) => r.id === entry.id && r.status === "passed")
          .map((r) => r.testMs),
      ),
      failedRuns: results.filter(
        (r) => r.id === entry.id && r.status !== "passed",
      ).length,
    })),
    limitations,
  };
  await save("summary.json", summary);
  console.log(`Evidence: ${out}`);
  return summary;
}
