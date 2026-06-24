/** @module @category Audit */
import { auditNowMs, createAuditEvent } from "./helpers.js";
import { safeAuditSink } from "./sink.js";
import type {
  AuditContextOptions,
  AuditEmitContext,
  AuditEventContext,
  AuditEventKind,
  AuditSink,
  MarmotAuditEvent,
} from "./types.js";

export class AuditEmitter implements AuditSink {
  readonly context: AuditEmitContext;
  readonly sink: AuditSink;
  #seq = 0;

  constructor(options: AuditContextOptions & { sink?: AuditSink }) {
    this.sink = safeAuditSink(options.sink);
    this.context = {
      engineId: options.engineId,
      accountRef: options.accountRef,
      recorderSessionId: options.recorderSessionId,
      dataMode: options.dataMode ?? "obfuscated_sensitive_data",
      source: options.source,
      now: options.now ?? auditNowMs,
    };
  }

  record(event: MarmotAuditEvent): void {
    this.sink.record(event);
  }

  emit(
    kind: AuditEventKind,
    options?: { groupRef?: string; context?: AuditEventContext },
  ): MarmotAuditEvent {
    const event = createAuditEvent(this.context, this.#seq++, kind, options);
    this.record(event);
    return event;
  }
}

export function createAuditEmitter(
  options: (AuditContextOptions & { sink?: AuditSink }) | undefined,
): AuditEmitter | undefined {
  return options ? new AuditEmitter(options) : undefined;
}
