/** @module @category Client - Group Media */
import { base64 } from "@scure/base";
import type { EventSigner } from "applesauce-core";
import { rejectNonRoutableHost } from "../../core/components/host-safety.js";
import type { MediaBlobTransport } from "./media-transfer.js";

export interface BlossomMediaTransportOptions {
  signer: EventSigner;
  /** Contact-time permission. Defaults to HTTPS with a non-private literal host. */
  allowDestination?: (url: URL) => boolean;
  fetch?: typeof globalThis.fetch;
}
function defaultDestination(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  try {
    rejectNonRoutableHost(url.hostname, "Media destination");
    return true;
  } catch {
    return false;
  }
}

/** Bounded BUD-01/02 adapter. Redirects, browser credentials and caching are disabled. */
export function createBlossomMediaTransport(
  options: BlossomMediaTransportOptions,
): MediaBlobTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const allow = options.allowDestination ?? defaultDestination;
  async function request(
    url: string,
    signal: AbortSignal,
    maxBytes: number,
    init: RequestInit = {},
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid media byte limit");
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      !allow(parsed)
    )
      throw new Error("Media destination contact denied");
    signal.throwIfAborted();
    const response = await fetcher(url, {
      ...init,
      signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Media HTTP request failed");
    }
    const reader = response.body.getReader();
    try {
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > maxBytes)
      )
        throw new Error("Media response exceeds byte limit");
      let size = 0;
      let bytes = new Uint8Array(Math.min(maxBytes, 65536));
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (value.length > maxBytes - size)
          throw new Error("Media response exceeds byte limit");
        if (size + value.length > bytes.length) {
          const grown = new Uint8Array(
            Math.min(maxBytes, Math.max(size + value.length, bytes.length * 2)),
          );
          grown.set(bytes.subarray(0, size));
          bytes = grown;
        }
        bytes.set(value, size);
        size += value.length;
      }
      return bytes.slice(0, size);
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return {
    async fetch({ url, signal, maxBytes }) {
      return request(url, signal, maxBytes);
    },
    async upload({ baseUrl, data, ciphertextSha256, signal, maxBytes }) {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        data.byteLength > maxBytes
      )
        throw new Error("Media upload exceeds byte limit");
      const url = baseUrl.replace(/\/+$/, "") + "/upload";
      // Check contact permission before asking an external signer.
      const destination = new URL(url);
      if (!allow(destination))
        throw new Error("Media destination contact denied");
      const now = Math.floor(Date.now() / 1000);
      const event = await options.signer.signEvent({
        kind: 24242,
        content: "Upload encrypted media",
        created_at: now,
        tags: [
          ["t", "upload"],
          ["x", ciphertextSha256],
          ["expiration", String(now + 600)],
          ["server", destination.hostname],
        ],
      });
      const result = await request(url, signal, 16 * 1024, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          authorization:
            "Nostr " +
            base64.encode(new TextEncoder().encode(JSON.stringify(event))),
        },
        body: data.slice() as Uint8Array<ArrayBuffer>,
      });
      const descriptor: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result),
      );
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        !("url" in descriptor) ||
        typeof descriptor.url !== "string"
      )
        throw new Error("Invalid Blossom upload descriptor");
      return descriptor.url;
    },
  };
}
