/** @module @category Core - Encrypted Media */

/**
 * Canonicalizes a MIME type for use in cryptographic operations (MIP-04).
 *
 * Rules (per MIP-04):
 * - Convert to lowercase
 * - Trim leading/trailing whitespace
 * - Strip parameters (everything after the first `;`)
 *
 * @param mimeType - The raw MIME type string
 * @returns The canonical MIME type
 */
export function canonicalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/**
 * Returns `true` iff `value` is a non-empty MIME type string of the form
 * `type/subtype` (parameters are allowed but the bare type/subtype part must
 * be present and non-empty on both sides of the `/`).
 *
 * @internal
 */
export function isValidMimeType(value: string): boolean {
  const bare = value.split(";")[0].trim();
  const slash = bare.indexOf("/");
  return slash > 0 && slash < bare.length - 1;
}

/**
 * Returns true iff `value` is valid hex with the expected encoded byte length.
 *
 * @internal
 */
export function isValidHex(value: string, expectedBytes: number): boolean {
  return value.length === expectedBytes * 2 && /^[0-9a-f]+$/i.test(value);
}
