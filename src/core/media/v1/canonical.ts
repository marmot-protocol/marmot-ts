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
