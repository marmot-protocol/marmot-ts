/** @module @category Extra - Audit */
/// <reference types="node" />
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuditLogWriter } from "../../audit/index.js";

export class NodeJsonlAuditWriter implements AuditLogWriter {
  readonly path: string;
  #handle: Promise<FileHandle>;

  constructor(path: string) {
    this.path = path;
    this.#handle = this.#open();
  }

  async #open(): Promise<FileHandle> {
    await mkdir(dirname(this.path), { recursive: true });
    return open(this.path, "a");
  }

  async appendLine(line: string): Promise<void> {
    const handle = await this.#handle;
    await handle.appendFile(line, "utf8");
  }

  async flush(): Promise<void> {
    const handle = await this.#handle;
    await handle.sync();
  }

  async close(): Promise<void> {
    const handle = await this.#handle;
    await handle.close();
  }
}
