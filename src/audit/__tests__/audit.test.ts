import { describe, expect, it } from "vitest";

import {
  AuditEmitter,
  JsonlAuditRecorder,
  MemoryAuditSink,
  auditEpochStateName,
  deriveAccountRef,
  deriveEngineId,
  deriveMemberRef,
} from "../index.js";

describe("audit helpers", () => {
  it("derives stable refs", () => {
    expect(deriveAccountRef("alice")).toBe(deriveAccountRef("alice"));
    expect(deriveMemberRef("alice")).toBe(deriveMemberRef("alice"));
    expect(deriveEngineId("alice", "device-1")).toBe(
      deriveEngineId("alice", "device-1"),
    );
    expect(deriveEngineId("alice", "device-1")).not.toBe(
      deriveEngineId("alice", "device-2"),
    );
  });

  it("includes the merging epoch state", () => {
    expect(auditEpochStateName("Merging")).toBe("merging");
  });
});

describe("JsonlAuditRecorder", () => {
  it("writes one JSON object per line", async () => {
    const lines: string[] = [];
    const recorder = new JsonlAuditRecorder({
      writer: { appendLine: (line) => lines.push(line) },
    });
    const sink = new MemoryAuditSink();
    const emitter = new AuditEmitter({
      sink,
      engineId: "e".repeat(32),
      dataMode: "obfuscated_sensitive_data",
      now: () => 42,
    });

    const event = emitter.emit({ type: "recorder_started", recorder: "test" });
    recorder.record(event);
    await recorder.flush();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema_version: "marmot-forensics-audit/v2",
      seq: 0,
      wall_time_ms: 42,
      audit_data_mode: "obfuscated_sensitive_data",
      engine_id: "e".repeat(32),
      kind: { type: "recorder_started", recorder: "test" },
    });
  });
});
