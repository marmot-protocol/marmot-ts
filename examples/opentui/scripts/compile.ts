/**
 * Compile the OpenTUI app into a single standalone Bun executable.
 *
 * OpenTUI's native renderer ships as per-platform optional dependencies
 * (`@opentui/core-<platform>`), and `@opentui/core` selects one at runtime with
 * `await import("@opentui/core-<platform>")` for every supported target. Only
 * the current platform's package is actually installed, so a naive
 * `bun build --compile` fails trying to resolve the others. We mark every
 * platform package except the current one as `--external`; the current one stays
 * bundled, and its `libopentui.so` is embedded into the binary via Bun's
 * `with { type: "file" }` import, yielding a genuinely single-file executable.
 *
 * Usage: `bun run scripts/compile.ts [--outfile <path>]`
 */
import { spawn } from "bun";

const ALL_NATIVE_PACKAGES = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64-musl",
];

/** Mirror @opentui/core's `resolveNativePackage()` for the host platform. */
function currentNativePackage(): string {
  const { platform, arch } = process;
  const musl = process.env.OPENTUI_LIBC === "musl";
  if (platform === "darwin" && arch === "x64") return "@opentui/core-darwin-x64";
  if (platform === "darwin" && arch === "arm64")
    return "@opentui/core-darwin-arm64";
  if (platform === "linux" && arch === "x64")
    return musl ? "@opentui/core-linux-x64-musl" : "@opentui/core-linux-x64";
  if (platform === "linux" && arch === "arm64")
    return musl ? "@opentui/core-linux-arm64-musl" : "@opentui/core-linux-arm64";
  if (platform === "win32" && arch === "x64") return "@opentui/core-win32-x64";
  if (platform === "win32" && arch === "arm64")
    return "@opentui/core-win32-arm64";
  throw new Error(`unsupported platform for compile: ${platform}-${arch}`);
}

const outIndex = process.argv.indexOf("--outfile");
const ext = process.platform === "win32" ? ".exe" : "";
const outfile =
  outIndex !== -1 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : `dist/marmot-opentui${ext}`;

const keep = currentNativePackage();
const externals = ALL_NATIVE_PACKAGES.filter((pkg) => pkg !== keep).flatMap(
  (pkg) => ["--external", pkg],
);

const args = [
  "build",
  "--compile",
  "--target=bun",
  "./src/index.tsx",
  "--outfile",
  outfile,
  ...externals,
];

console.log(`Compiling for ${process.platform}-${process.arch} (${keep})…`);
const proc = spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
const code = await proc.exited;
if (code === 0) console.log(`\nBuilt ${outfile}`);
process.exit(code);
