/** @module @category Audit */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type {
  AuditEmitContext,
  AuditEpochState,
  AuditEventContext,
  AuditMessageArtifactKind,
  MarmotAuditEvent,
} from "./types.js";
import { MARMOT_AUDIT_SCHEMA_VERSION } from "./types.js";

export function auditNowMs(): number {
  return Date.now();
}

export function digestBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function digestString(value: string): string {
  return digestBytes(utf8ToBytes(value));
}

export function toAuditBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? utf8ToBytes(value) : value;
}

function taggedRef(tag: string, value: Uint8Array | string): string {
  const bytes = toAuditBytes(value);
  const input = new Uint8Array(tag.length + bytes.length);
  input.set(utf8ToBytes(tag));
  input.set(bytes, tag.length);
  return bytesToHex(sha256(input).slice(0, 16));
}

export function deriveAccountRef(accountId: Uint8Array | string): string {
  return taggedRef("marmot-audit-account-ref/v1", accountId);
}

export function deriveMemberRef(memberIdentity: Uint8Array | string): string {
  return taggedRef("marmot-audit-member-ref/v1", memberIdentity);
}

export function deriveEngineId(
  accountId: Uint8Array | string,
  deviceId: Uint8Array | string,
): string {
  const account = toAuditBytes(accountId);
  const device = toAuditBytes(deviceId);
  const tag = utf8ToBytes("marmot-audit-engine-id/v2");
  const input = new Uint8Array(tag.length + account.length + device.length);
  input.set(tag);
  input.set(account, tag.length);
  input.set(device, tag.length + account.length);
  return bytesToHex(sha256(input).slice(0, 16));
}

export function auditEpochStateName(value: string): AuditEpochState {
  switch (value) {
    case "Stable":
      return "stable";
    case "PendingPublish":
      return "pending_publish";
    case "Merging":
      return "merging";
    case "Recovering":
      return "recovering";
    case "Unrecoverable":
      return "unrecoverable";
    default:
      throw new Error(`Unknown Marmot group lifecycle state: ${value}`);
  }
}

export function messageArtifactKindFromNostrKind(
  kind: number | undefined,
): AuditMessageArtifactKind {
  switch (kind) {
    case 444:
      return "welcome";
    case 445:
      return "unknown";
    default:
      return "unknown";
  }
}

export function createAuditEvent(
  context: AuditEmitContext,
  seq: number,
  kind: MarmotAuditEvent["kind"],
  options?: { groupRef?: string; context?: AuditEventContext },
): MarmotAuditEvent {
  const eventContext = mergeAuditContexts(
    context.source ? { source: context.source } : undefined,
    options?.context,
  );
  return {
    schema_version: MARMOT_AUDIT_SCHEMA_VERSION,
    seq,
    wall_time_ms: context.now(),
    recorder_session_id: context.recorderSessionId,
    audit_data_mode: context.dataMode,
    account_ref: context.accountRef,
    engine_id: context.engineId,
    group_ref: options?.groupRef,
    context: eventContext,
    kind,
  };
}

export function mergeAuditContexts(
  a: AuditEventContext | undefined,
  b: AuditEventContext | undefined,
): AuditEventContext | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    ...a,
    ...b,
    human_action: b.human_action ?? a.human_action,
    transport: b.transport ?? a.transport,
    engine: b.engine ?? a.engine,
    group: b.group ?? a.group,
    convergence: b.convergence ?? a.convergence,
    source: b.source ?? a.source,
  };
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
