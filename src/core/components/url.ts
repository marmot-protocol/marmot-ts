/** @module @category Core - App Components */
import { isLoopbackHost, rejectNonRoutableHost } from "./host-safety.js";

export interface HttpsUrlOptions {
  /** Maximum byte length of both the input and normalized URL. */
  maxLen: number;
  /** Allow `http` URLs that point at a loopback host (encrypted-media only). */
  allowLoopbackHttp?: boolean;
  /** Reject URLs carrying a query string (encrypted-media endpoints). */
  rejectQuery?: boolean;
  /** Strip a single trailing `/` from the normalized URL (endpoints). */
  trimTrailingSlash?: boolean;
  /** Prefix used in thrown error messages. */
  label: string;
}

/**
 * Validates and normalizes an `https` (optionally loopback-`http`) URL the way
 * the darkmatter `validate_and_normalize_*` helpers do: no credentials, no
 * fragment, a routable host, and length bounds. Returns the WHATWG-normalized
 * URL. Both this and the Rust `url` crate implement the WHATWG URL Standard, so
 * normalized output matches across implementations for ordinary URLs.
 */
export function validateAndNormalizeHttpsUrl(
  raw: string,
  opts: HttpsUrlOptions,
): string {
  const { label, maxLen } = opts;
  const trimmed = opts.trimTrailingSlash ? raw.trim() : raw;
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (utf8Len(trimmed) > maxLen)
    throw new Error(`${label} exceeds ${maxLen} bytes`);
  if (!URL.canParse(trimmed)) throw new Error(`${label} is invalid`);
  const url = new URL(trimmed);

  if (url.username !== "" || url.password !== "")
    throw new Error(`${label} must not include credentials`);
  if (url.hash !== "") throw new Error(`${label} must not include a fragment`);
  if (opts.rejectQuery && url.search !== "")
    throw new Error(`${label} must not include a query`);

  const scheme = url.protocol.replace(/:$/, "");
  const isLoopbackHttp =
    scheme === "http" && opts.allowLoopbackHttp && isLoopbackHost(url.hostname);
  if (scheme === "https") {
    rejectNonRoutableHost(url.hostname, label);
  } else if (!isLoopbackHttp) {
    throw new Error(`${label} scheme must be https`);
  }

  let normalized = url.toString();
  if (opts.trimTrailingSlash) {
    const stripped = normalized.replace(/\/+$/, "");
    if (stripped.length > 0) normalized = stripped;
  }
  if (utf8Len(normalized) > maxLen)
    throw new Error(`${label} exceeds ${maxLen} bytes`);
  return normalized;
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}
