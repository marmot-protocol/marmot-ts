/** @module @category Core - Encrypted Media */

/**
 * Canonicalizes a MIME type for use in `encrypted-media-v2` cryptographic
 * operations (key derivation and AEAD AAD).
 *
 * Sender and receiver MUST apply this identical algorithm
 * (`features/encrypted-media.md` — Media Type Canonicalization):
 *
 * 1. take the substring before the first `;`, dropping any parameters
 * 2. trim leading/trailing HTAB, LF, FF, CR and space (not vertical tab)
 * 3. lowercase using ASCII case folding only
 * 4. require exactly two HTTP-token segments of 1..64 bytes, total ≤128 bytes
 * 5. apply the canonical alias `image/jpg` → `image/jpeg`
 *
 * Adding an alias or normalization step is a breaking media-version change.
 *
 * @param mimeType - The raw MIME type string
 * @returns The canonical MIME type
 * @throws If the canonical result violates the v2 MIME profile
 */
export function canonicalizeMimeType(mimeType: string): string {
  const base = mimeType
    .split(";")[0]
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
  const token = "[a-z0-9!#$%&'*+.^_`|~-]{1,64}";
  if (base.length > 128 || !new RegExp(`^${token}/${token}$`).test(base)) {
    throw new Error("invalid media type");
  }

  // Step 5: canonical alias.
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
  return value.length === expectedBytes * 2 && /^[0-9a-fA-F]+$/.test(value);
}

/** Validate exact filename bytes without Unicode repair or normalization. */
export function validateMediaFilename(value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.length < 1 ||
    bytes.length > 255 ||
    value.includes("\0") ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
      value
  ) {
    throw new Error("filename must be valid UTF-8, 1..255 bytes, without NUL");
  }
}
