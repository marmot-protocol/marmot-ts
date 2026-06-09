/** @module @category Core - App Components */

/** Lexicographic comparison over raw bytes (matches Rust `[u8]`/`&[u8]` Ord). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Ports the darkmatter `reject_non_routable_ipv4` classifier. Returns `true`
 * when the dotted-decimal IPv4 address is loopback, private, link-local,
 * broadcast, documentation, unspecified, or multicast.
 */
function isNonRoutableIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c, d] = octets;
  const loopback = a === 127;
  const priv =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const linkLocal = a === 169 && b === 254;
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
  const documentation =
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
  const multicast = a >= 224 && a <= 239;
  return (
    loopback ||
    priv ||
    linkLocal ||
    broadcast ||
    documentation ||
    unspecified ||
    multicast
  );
}

/** Parses a dotted-decimal IPv4 string into octets, or `null` if not IPv4. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/** Expands an IPv6 string (with optional `::`) into eight 16-bit segments. */
function parseIpv6(host: string): number[] | null {
  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) folds into two segments.
  let text = host;
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let tailSegments: number[] = [];
  if (tail) {
    const v4 = parseIpv4(tail[1]);
    if (!v4) return null;
    tailSegments = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, tail.index);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const back = parseGroups(halves[1]);
    if (head === null || back === null) return null;
    const filled = [...head, ...back, ...tailSegments];
    const missing = 8 - filled.length;
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill(0), ...back, ...tailSegments];
  }

  const groups = parseGroups(text);
  if (groups === null) return null;
  const segments = [...groups, ...tailSegments];
  return segments.length === 8 ? segments : null;
}

/** Ports the darkmatter `reject_non_routable_ipv6` classifier. */
function isNonRoutableIpv6(segments: number[]): boolean {
  // ::ffff:0:0/96 — IPv4-mapped — re-classify as IPv4.
  const mappedPrefix = segments.slice(0, 5).every((s) => s === 0);
  if (mappedPrefix && segments[5] === 0xffff) {
    const a = segments[6] >> 8;
    const b = segments[6] & 0xff;
    const c = segments[7] >> 8;
    const d = segments[7] & 0xff;
    return isNonRoutableIpv4([a, b, c, d]);
  }
  const loopback =
    segments.slice(0, 7).every((s) => s === 0) && segments[7] === 1;
  const unspecified = segments.every((s) => s === 0);
  const multicast = (segments[0] & 0xff00) === 0xff00;
  const uniqueLocal = (segments[0] & 0xfe00) === 0xfc00;
  const linkLocal = (segments[0] & 0xffc0) === 0xfe80;
  return loopback || unspecified || multicast || uniqueLocal || linkLocal;
}

function isLocalhostDomain(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return lowered === "localhost" || lowered.endsWith(".localhost");
}

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

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(host);
  if (v4) return v4[0] === 127;
  if (host.includes(":")) {
    const v6 = parseIpv6(host);
    if (v6) return v6.slice(0, 7).every((s) => s === 0) && v6[7] === 1;
    return false;
  }
  return isLocalhostDomain(host);
}

function rejectNonRoutableHost(hostname: string, label: string): void {
  const host = hostname.replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(host);
  if (v4) {
    if (isNonRoutableIpv4(v4))
      throw new Error(`${label} must not point at a non-routable address`);
    return;
  }
  if (host.includes(":")) {
    const v6 = parseIpv6(host);
    if (v6 && isNonRoutableIpv6(v6))
      throw new Error(`${label} must not point at a non-routable address`);
    return;
  }
  if (isLocalhostDomain(host))
    throw new Error(`${label} must not point at localhost`);
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}
