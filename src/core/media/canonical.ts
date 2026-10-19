/** @module @category Core - Encrypted Media */

/**
 * Canonicalizes a MIME type for use in `encrypted-media-v1` cryptographic
 * operations (key derivation and AEAD AAD).
 *
 * Sender and receiver MUST apply this identical algorithm
 * (`features/encrypted-media.md` — Media Type Canonicalization):
 *
 * 1. take the substring before the first `;`, dropping any parameters
 * 2. trim leading and trailing ASCII whitespace
 * 3. lowercase using ASCII case folding only
 * 4. reject if the result is empty or does not contain `/`
 * 5. apply the canonical alias `image/jpg` → `image/jpeg`
 *
 * Adding an alias or normalization step is a breaking media-version change.
 *
 * @param mimeType - The raw MIME type string
 * @returns The canonical MIME type
 * @throws If the canonical result is empty or has no `/`
 */
export function canonicalizeMimeType(mimeType: string): string {
  // Steps 1–3: strip parameters, trim, ASCII-lowercase.
  const base = mimeType
    .split(";")[0]
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

  // Step 4: reject empty or `/`-less results.
  const slash = base.indexOf("/");
  if (slash <= 0 || slash >= base.length - 1) {
    throw new Error(`invalid media type: ${JSON.stringify(mimeType)}`);
  }

  // Step 5: canonical alias.
  return base === "image/jpg" ? "image/jpeg" : base;
}

const MARMOT_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const HTTP_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * The shared Marmot media-type canonicalization used by `encrypted-media-v2`
 * (`foundation/canonical-encoding.md` "Media type canonicalization"; MDK
 * `canonical_media_type_v2`). Stricter than the frozen v1 algorithm
 * ({@link canonicalizeMimeType}):
 *
 * 1. take the substring before the first `;`
 * 2. trim only HTAB, LF, FF, CR and space (not VT, not Unicode whitespace)
 * 3. ASCII-lowercase
 * 4. require exactly one `/` with a non-empty type and subtype, each at most
 *    64 bytes and together at most 128 bytes
 * 5. require every type/subtype byte to be an HTTP token byte
 * 6. apply the alias `image/jpg` → `image/jpeg`
 *
 * A v2 receiver requires the stored `m` value to be byte-equal to this
 * function's output; it never repairs a non-canonical value.
 *
 * @throws If the value cannot be canonicalized
 */
export function canonicalizeMimeTypeV2(mimeType: string): string {
  let base = mimeType.split(";")[0];
  let start = 0;
  let end = base.length;
  while (start < end && MARMOT_WHITESPACE.has(base.charCodeAt(start))) start++;
  while (end > start && MARMOT_WHITESPACE.has(base.charCodeAt(end - 1))) end--;
  base = base.slice(start, end).replace(/[A-Z]/g, (c) => c.toLowerCase());

  const segments = base.split("/");
  const [type, subtype] = segments;
  if (
    segments.length !== 2 ||
    !type ||
    !subtype ||
    type.length > 64 ||
    subtype.length > 64 ||
    base.length > 128 ||
    !HTTP_TOKEN.test(type) ||
    !HTTP_TOKEN.test(subtype)
  ) {
    throw new Error(
      `media type is not a canonicalizable MIME type: ${JSON.stringify(mimeType)}`,
    );
  }
  return base === "image/jpg" ? "image/jpeg" : base;
}

/**
 * Returns `true` iff {@link canonicalizeMimeType} accepts `value` (it is a
 * non-empty `type/subtype` string).
 *
 * @internal
 */
export function isValidMimeType(value: string): boolean {
  try {
    canonicalizeMimeType(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true iff `value` is valid hex with the expected encoded byte length.
 *
 * @internal
 */
export function isValidHex(value: string, expectedBytes: number): boolean {
  return value.length === expectedBytes * 2 && /^[0-9a-f]+$/.test(value);
}

/**
 * Like {@link isValidHex} but case-insensitive, matching the Rust `hex` crate
 * MDK uses to validate v2 hashes and nonces.
 *
 * @internal
 */
export function isValidHexAnyCase(
  value: string,
  expectedBytes: number,
): boolean {
  return value.length === expectedBytes * 2 && /^[0-9a-fA-F]+$/.test(value);
}
