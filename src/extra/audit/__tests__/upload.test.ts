import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadAuditLogFile } from "../node.js";

describe("uploadAuditLogFile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marmot-audit-"));
    path = join(dir, "audit-deadbeef.jsonl");
    writeFileSync(path, '{"seq":0}\n{"seq":1}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a file whose name is not audit-*.jsonl", async () => {
    const other = join(dir, "notes.jsonl");
    writeFileSync(other, "{}\n");
    await expect(
      uploadAuditLogFile(other, "https://goggles.example/upload", {
        bearerToken: "t",
      }),
    ).rejects.toThrow(/audit-\*\.jsonl/);
  });

  it("rejects a non-loopback http endpoint", async () => {
    await expect(
      uploadAuditLogFile(path, "http://goggles.example/upload"),
    ).rejects.toThrow(/must be https/);
  });

  it("rejects an https endpoint without a bearer token", async () => {
    await expect(
      uploadAuditLogFile(path, "https://goggles.example/upload"),
    ).rejects.toThrow(/requires a bearer token/);
  });

  it("posts NDJSON to a loopback endpoint without a token", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await uploadAuditLogFile(
      path,
      "http://127.0.0.1:4000/upload",
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );

    expect(result).toEqual({ path, status: 200, bytesSent: 20 });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-ndjson");
    expect(headers["Content-Length"]).toBe("20");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends bearer + source headers for an https endpoint", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await uploadAuditLogFile(path, "https://goggles.example/upload", {
      bearerToken: "secret",
      source: { deviceLabel: "alice", platform: "linux", appVersion: "x/1" },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const headers = fetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret");
    expect(headers["X-Goggles-Device-Label"]).toBe("alice");
    expect(headers["X-Goggles-Platform"]).toBe("linux");
    expect(headers["X-Goggles-App-Version"]).toBe("x/1");
  });

  it("normalizes a non-2xx response to HTTP <status>", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      uploadAuditLogFile(path, "http://localhost:4000/upload", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
