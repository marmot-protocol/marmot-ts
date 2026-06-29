/** @module @category Audit */
export type {
  AuditContextOptions,
  AuditEmitContext,
  AuditEventKind,
  AuditRecorder,
  MarmotAuditEvent,
} from "./types.js";

export interface AuditLogWriter {
  appendLine(line: string): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
