#!/usr/bin/env node
// Verifies the packed npm tarball for @internet-privacy/marmot-ts:
// - the vendored ts-mls fork is present with the right shape and nothing extra
// - the manifest has no runtime/peer/optional dependency on the fork itself
// - the optional HPKE/post-quantum peers and the pinned @hpke/core version are correct
// - dist/mls.js resolves to the vendored copy
//
// With --check-fork-unpublished it also fails closed unless the fork cannot be published
// (either it is marked private, or its exact version is already published upstream, which
// `changeset publish` will then skip).
//
// Used by `pnpm release`, `scripts/release-next.sh`, and `scripts/package-smoke/run.sh`.
// Uses only Node.js builtins.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const FORK_DIR = path.join(REPO_ROOT, "ts-mls");

const args = process.argv.slice(2);
const tarballFlagIndex = args.indexOf("--tarball");
const explicitTarball =
  tarballFlagIndex !== -1 ? args[tarballFlagIndex + 1] : undefined;
const checkForkUnpublished = args.includes("--check-fork-unpublished");

const failures = [];

function fail(message) {
  failures.push(message);
}

function readTarballEntries(tarballPath) {
  const output = execFileSync("tar", ["-tzf", tarballPath], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readTarballFile(tarballPath, entryPath) {
  return execFileSync("tar", ["-xzOf", tarballPath, entryPath], {
    encoding: "utf8",
  });
}

function packFreshTarball() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marmot-ts-pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", tmpDir], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const entries = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one .tgz in ${tmpDir}, found ${entries.length}`,
    );
  }
  return { tarballPath: path.join(tmpDir, entries[0]), cleanupDir: tmpDir };
}

function verifyEntries(entries) {
  const required = [
    "package/dist/index.js",
    "package/dist/mls.js",
    "package/dist/mls.d.ts",
    "package/dist/vendor/ts-mls/index.js",
    "package/dist/vendor/ts-mls/index.d.ts",
    "package/dist/vendor/ts-mls/LICENSE",
    "package/dist/vendor/ts-mls/VERSION",
  ];
  for (const req of required) {
    if (!entries.includes(req)) {
      fail(`missing required tarball entry: ${req}`);
    }
  }

  for (const entry of entries) {
    if (!entry.startsWith("package/dist/vendor/ts-mls/")) continue;
    if (entry.endsWith(".map")) {
      fail(`forbidden .map file shipped under dist/vendor/ts-mls: ${entry}`);
    }
    if (
      entry.includes("/dist/vendor/ts-mls/src/") ||
      entry.includes("/dist/vendor/ts-mls/test/") ||
      entry.includes("/dist/vendor/ts-mls/bench/")
    ) {
      fail(
        `forbidden path under dist/vendor/ts-mls (wrong copy root): ${entry}`,
      );
    }
  }
}

function verifyManifest(tarballPath) {
  const raw = readTarballFile(tarballPath, "package/package.json");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    fail(`packed package.json is not valid JSON: ${err.message}`);
    return null;
  }

  const forkName = "ts-mls";
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
  ]) {
    const section = pkg[field];
    if (section && Object.prototype.hasOwnProperty.call(section, forkName)) {
      fail(`packed manifest still lists "${forkName}" under ${field}`);
    }
  }

  const expectedOptionalPeers = {
    "@hpke/chacha20poly1305": "1.8.0",
    "@hpke/dhkem-x448": "1.8.0",
    "@hpke/hybridkem-x-wing": "0.7.0",
    "@hpke/ml-kem": "0.3.0",
    "@noble/post-quantum": "0.6.1",
  };
  const peerDeps = pkg.peerDependencies || {};
  const peerMeta = pkg.peerDependenciesMeta || {};
  for (const [name, version] of Object.entries(expectedOptionalPeers)) {
    if (peerDeps[name] !== version) {
      fail(
        `expected peerDependencies["${name}"] === "${version}", found ${JSON.stringify(peerDeps[name])}`,
      );
    }
    if (!peerMeta[name] || peerMeta[name].optional !== true) {
      fail(`expected peerDependenciesMeta["${name}"].optional === true`);
    }
  }

  const hpkeCore = (pkg.dependencies || {})["@hpke/core"];
  if (hpkeCore !== "1.9.0") {
    fail(
      `expected dependencies["@hpke/core"] === "1.9.0", found ${JSON.stringify(hpkeCore)}`,
    );
  }

  return pkg;
}

function verifyMlsSpecifier(tarballPath) {
  const mlsJs = readTarballFile(tarballPath, "package/dist/mls.js");
  if (!mlsJs.includes("./vendor/ts-mls/index.js")) {
    fail("packed dist/mls.js does not reference ./vendor/ts-mls/index.js");
  }
}

function checkForkUnpublishedGuard() {
  const forkPkgPath = path.join(FORK_DIR, "package.json");
  if (!fs.existsSync(forkPkgPath)) {
    fail(`--check-fork-unpublished: ${forkPkgPath} not found`);
    return;
  }
  const forkPkg = JSON.parse(fs.readFileSync(forkPkgPath, "utf8"));

  if (forkPkg.private === true) {
    console.log("--check-fork-unpublished: fork is marked private, OK");
    return;
  }

  try {
    const output = execFileSync(
      "npm",
      ["view", `${forkPkg.name}@${forkPkg.version}`, "version"],
      {
        encoding: "utf8",
      },
    ).trim();
    if (output === forkPkg.version) {
      console.log(
        `--check-fork-unpublished: ${forkPkg.name}@${forkPkg.version} already exists upstream; ` +
          "changeset publish will skip it. Notice: the durable fix is to mark the fork private " +
          '(set "private": true in ts-mls/package.json).',
      );
      return;
    }
    fail(
      `--check-fork-unpublished: npm view returned "${output}", expected exactly "${forkPkg.version}". ` +
        "The fork could be published under an unexpected version. Refusing to proceed.",
    );
  } catch (err) {
    fail(
      `--check-fork-unpublished: could not verify ${forkPkg.name}@${forkPkg.version} against the npm ` +
        `registry (${err.message}). Failing closed rather than risk publishing the fork.`,
    );
  }
}

function main() {
  let tarballPath = explicitTarball;
  let cleanupDir;

  if (!tarballPath) {
    const packed = packFreshTarball();
    tarballPath = packed.tarballPath;
    cleanupDir = packed.cleanupDir;
  }

  try {
    const entries = readTarballEntries(tarballPath);
    verifyEntries(entries);
    verifyManifest(tarballPath);
    verifyMlsSpecifier(tarballPath);

    if (checkForkUnpublished) {
      checkForkUnpublishedGuard();
    }

    if (failures.length > 0) {
      console.error("verify-package-tarball: FAILED");
      for (const failure of failures) {
        console.error(`  - ${failure}`);
      }
      process.exit(1);
    }

    console.log(`package tarball OK: ${tarballPath}`);
  } finally {
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

main();
