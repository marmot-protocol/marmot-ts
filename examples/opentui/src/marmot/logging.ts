import createDebug from "debug";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { format } from "node:util";

import type { StatusLine } from "./controller.js";

const ANSI = /\x1b\[[0-9;]*m/g;

export interface LogFile {
  readonly path: string;
  status(line: StatusLine): void;
  close(): void;
}

export function redirectDebugToFile(logPath: string): LogFile {
  const path = resolve(logPath);
  mkdirSync(dirname(path), { recursive: true });

  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  let closed = false;

  createDebug.enable(process.env.DEBUG || "*");
  createDebug.inspectOpts ??= {};
  createDebug.inspectOpts.hideDate = true;
  createDebug.log = (...args: unknown[]): void => {
    const line = (format as (...a: unknown[]) => string)(...args).replace(
      ANSI,
      "",
    );
    stream.write(`${new Date().toISOString()} ${line}\n`);
  };

  return {
    path,
    status: (line) => {
      stream.write(
        `${new Date(line.at).toISOString()} opentui:${line.level} ${line.text}\n`,
      );
    },
    close: () => {
      if (closed) return;
      closed = true;
      stream.end();
    },
  };
}
