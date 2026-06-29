/** @module @category Extra - Audit */
/// <reference types="node" />
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";

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

/**
 * The Goggles tracker accepts a single audit file up to 64 MiB, matching the
 * reference app's `post_audit_log_file` validation.
 */
const MAX_AUDIT_UPLOAD_BYTES = 64 * 1024 * 1024;

/** An audit log basename must be `audit-*.jsonl`. */
const AUDIT_FILE_NAME = /^audit-.*\.jsonl$/;

/**
 * Non-identifying client labels sent as `X-Goggles-*` headers alongside an
 * upload. Account identity is NOT a header — it lives in the JSONL rows
 * (`account_ref` on every row + a `source_context` row at recorder open).
 */
export interface AuditLogUploadSource {
  deviceLabel?: string;
  platform?: string;
  appVersion?: string;
}

export interface AuditLogUploadOptions {
  /** Bearer token. Required for any non-loopback endpoint. */
  bearerToken?: string;
  /** Optional client labels, sent as `X-Goggles-*` headers. */
  source?: AuditLogUploadSource;
  /** Total request timeout in milliseconds (default 60_000). */
  timeoutMs?: number;
  /** Injectable `fetch`, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface AuditLogUploadResult {
  /** Local path that was uploaded. */
  path: string;
  /** HTTP status code returned by the tracker. */
  status: number;
  /** Number of bytes sent (the file size). */
  bytesSent: number;
}

/** True for an `http:` endpoint whose host is a loopback address. */
function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/**
 * Upload one audit JSONL file to a Goggles tracker endpoint, mirroring the
 * reference app's `post_audit_log_file` contract: a `POST` of the raw NDJSON
 * body with `Content-Type: application/x-ndjson`, an optional bearer token, and
 * non-identifying `X-Goggles-*` source headers.
 *
 * Validation matches the reference: the basename must be `audit-*.jsonl`, the
 * file must be at most 64 MiB, the endpoint must be `https` (or loopback `http`
 * for local testing), and a non-loopback endpoint requires a bearer token.
 * Throws a normalized error (`HTTP <status>`, `request timed out`, or
 * `connection failed`) on failure.
 */
export async function uploadAuditLogFile(
  path: string,
  endpoint: string,
  options: AuditLogUploadOptions = {},
): Promise<AuditLogUploadResult> {
  if (!path) throw new Error("audit log path is empty");
  if (!AUDIT_FILE_NAME.test(basename(path)))
    throw new Error("audit log file name must match audit-*.jsonl");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("audit log tracker endpoint is not a valid URL");
  }
  const loopback = isLoopbackHttp(url);
  if (url.protocol !== "https:" && !loopback)
    throw new Error(
      "audit log tracker endpoint must be https (or loopback http for local testing)",
    );
  if (!loopback && !options.bearerToken)
    throw new Error("audit log tracker endpoint requires a bearer token");

  const info = await stat(path);
  if (info.size > MAX_AUDIT_UPLOAD_BYTES)
    throw new Error(
      `audit log file is too large (${info.size} bytes, max ${MAX_AUDIT_UPLOAD_BYTES})`,
    );

  const body = await readFile(path);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson",
    "Content-Length": String(body.byteLength),
  };
  if (options.bearerToken)
    headers["Authorization"] = `Bearer ${options.bearerToken}`;
  if (options.source?.deviceLabel)
    headers["X-Goggles-Device-Label"] = options.source.deviceLabel;
  if (options.source?.platform)
    headers["X-Goggles-Platform"] = options.source.platform;
  if (options.source?.appVersion)
    headers["X-Goggles-App-Version"] = options.source.appVersion;

  const doFetch = options.fetch ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) throw new Error("request timed out");
    throw new Error("connection failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { path, status: response.status, bytesSent: body.byteLength };
}
