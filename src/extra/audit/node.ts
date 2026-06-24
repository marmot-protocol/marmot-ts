/** @module @category Extra - Audit */
/// <reference types="node" />
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AuditLogWriter,
  AuditRecorder,
  MarmotAuditEvent,
} from "../../audit/index.js";

export class NodeJsonlAuditRecorder implements AuditRecorder {
  readonly path: string;
  readonly #fd: number;
  #seq = 0;
  #closed = false;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#fd = openSync(path, "a");
  }

  record(event: MarmotAuditEvent): void {
    if (this.#closed) return;
    appendFileSync(
      this.#fd,
      `${JSON.stringify({ ...event, seq: this.#seq++ })}\n`,
      "utf8",
    );
  }

  async flush(): Promise<void> {
    if (!this.#closed) fsyncSync(this.#fd);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    fsyncSync(this.#fd);
    closeSync(this.#fd);
    this.#closed = true;
  }
}

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
