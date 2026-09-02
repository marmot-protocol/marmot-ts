/** @module @category Core - App Components */

/** Lexicographic comparison over raw bytes (matches Rust `[u8]`/`&[u8]` Ord). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Equality for optional byte arrays; two absent values are equal. */
export function bytesEqual(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return compareBytes(a, b) === 0;
}
