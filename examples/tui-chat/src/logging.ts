import createDebug from "debug";
import { createWriteStream, type WriteStream } from "node:fs";
import { format } from "node:util";

/** Matches ANSI SGR color escapes that `debug` adds when stderr is a TTY. */
const ANSI = /\x1b\[[0-9;]*m/g;

export interface LogFile {
  /** Absolute path the debug output is being written to. */
  readonly path: string;
  /** Flush and close the underlying file stream. */
  close(): void;
}

/**
 * Route the marmot-ts library's `debug` output to a file instead of stderr.
 *
 * The library logs through the `debug` package under the `marmot-ts:*`
 * namespace. Letting those lines hit stderr would scribble over the live TUI
 * prompt, so when debugging is enabled we redirect every debug line to a file.
 *
 * This hooks the library without it exposing any logging API: `debug` resolves
 * its sink as `instance.log || createDebug.log` *at call time*, and the library
 * never sets a per-instance `.log`. Overriding the module-level
 * `createDebug.log` therefore captures the root logger and every
 * `.extend()`-ed child (e.g. `marmot-ts:client`, `marmot-ts:group-engine:…`).
 * We import the same `debug` singleton the library uses — pnpm resolves both to
 * one physical package, so the override and `enable()` reach its loggers.
 *
 * @param logFile  Path to append debug output to.
 * @param namespaces  `debug` namespace filter; defaults to the existing DEBUG
 *   env var, falling back to all marmot-ts namespaces.
 */
export function redirectDebugToFile(
  logFile: string,
  namespaces: string = process.env.DEBUG || "marmot-ts*",
): LogFile {
  const stream: WriteStream = createWriteStream(logFile, { flags: "a" });

  // `marmot-ts*` (no colon) matches both the bare `marmot-ts` root logger and
  // every `marmot-ts:*` child.
  createDebug.enable(namespaces);
  // `debug` prepends its own ISO date only when stderr is not a TTY; suppress
  // it so our stamp below is the single, consistent timestamp either way.
  // Mutate the existing object in place — `debug`'s internal `getDate()` reads
  // its own reference, so replacing the object wouldn't take effect.
  createDebug.inspectOpts ??= {};
  createDebug.inspectOpts.hideDate = true;
  createDebug.log = (...args: unknown[]): void => {
    // `debug` has already formatted the namespace/timing into `args`; rebuild
    // the line, strip any color escapes, and stamp it for an at-rest log.
    const line = (format as (...a: unknown[]) => string)(...args).replace(
      ANSI,
      "",
    );
    stream.write(`${new Date().toISOString()} ${line}\n`);
  };

  return {
    path: logFile,
    close: () => stream.end(),
  };
}
