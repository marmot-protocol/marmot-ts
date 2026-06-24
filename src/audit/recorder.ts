/** @module @category Audit */
import type {
  AuditContextOptions,
  AuditLogWriter,
  AuditRecorder,
  MarmotAuditEvent,
} from "./types-internal.js";

export type { AuditLogWriter } from "./types-internal.js";

export class JsonlAuditRecorder implements AuditRecorder {
  readonly writer: AuditLogWriter;
  #writeChain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    options: Partial<AuditContextOptions> & { writer: AuditLogWriter },
  ) {
    this.writer = options.writer;
  }

  record(event: MarmotAuditEvent): void {
    if (this.#closed) return;
    this.#writeChain = this.#writeChain.then(() =>
      Promise.resolve(this.writer.appendLine(`${JSON.stringify(event)}\n`)),
    );
  }

  async flush(): Promise<void> {
    await this.#writeChain;
    await this.writer.flush?.();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.flush();
    await this.writer.close?.();
  }
}
