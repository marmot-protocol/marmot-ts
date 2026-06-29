/** @module @category Audit */
import type { AuditSink, MarmotAuditEvent } from "./types.js";

export class NoopAuditSink implements AuditSink {
  record(_event: MarmotAuditEvent): void {}
}

export class MemoryAuditSink implements AuditSink {
  readonly events: MarmotAuditEvent[] = [];

  record(event: MarmotAuditEvent): void {
    this.events.push(event);
  }
}

export class SafeAuditSink implements AuditSink {
  constructor(readonly inner: AuditSink) {}

  record(event: MarmotAuditEvent): void {
    try {
      this.inner.record(event);
    } catch {
      // Audit must never affect protocol progress.
    }
  }
}

export const noopAuditSink = new NoopAuditSink();

export function safeAuditSink(sink: AuditSink | undefined): AuditSink {
  return sink ? new SafeAuditSink(sink) : noopAuditSink;
}
