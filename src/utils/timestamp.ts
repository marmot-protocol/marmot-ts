import { defaultLifetime, Lifetime } from "ts-mls";

/**
 * Formats a bigint timestamp to a readable date string, handling special MLS timestamp values.
 *
 * @param timestamp - The timestamp as a bigint (typically from MLS lifetime fields)
 * @returns A formatted date string or descriptive text for special values
 *
 * @example
 * ```typescript
 * // For normal timestamps
 * formatMlsTimestamp(1700000000n); // Returns: "11/14/2023, 1:13:20 PM"
 *
 * // For "no expiration" value
 * formatMlsTimestamp(9223372036854775807n); // Returns: "No expiration"
 *
 * // For epoch value
 * formatMlsTimestamp(0n); // Returns: "Epoch (1970-01-01)"
 * ```
 */
export function formatMlsTimestamp(timestamp: bigint): string {
  const lifetime = defaultLifetime();

  if (timestamp === lifetime.notAfter) {
    return "No expiration";
  }
  if (timestamp === lifetime.notBefore) {
    return "Epoch (1970-01-01)";
  }

  // Convert to milliseconds and create Date object
  const date = new Date(Number(timestamp) * 1000);

  // Check if the date is valid (not NaN)
  if (isNaN(date.getTime())) {
    return "Invalid date";
  }

  return date.toLocaleString();
}

/**
 * Checks if a lifetime is currently valid, handling the "no expiration" case.
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if the lifetime is currently valid, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = isLifetimeValid(lifetime);
 * // Returns: true if current time is within the lifetime range
 * ```
 */
export function isLifetimeValid(lifetime: Lifetime): boolean {
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  const defaultLt = defaultLifetime();

  return (
    currentTime >= lifetime.notBefore &&
    (lifetime.notAfter === defaultLt.notAfter ||
      currentTime <= lifetime.notAfter)
  );
}

/**
 * Creates a lifetime with a 3-month expiration from the current time.
 *
 * @returns A lifetime object with notBefore set to current time and notAfter set to 3 months from now
 *
 * @example
 * ```typescript
 * const lifetime = createThreeMonthLifetime();
 * // Returns: { notBefore: currentTime, notAfter: currentTime + 3 months }
 * ```
 */
export function createThreeMonthLifetime(): Lifetime {
  const currentTime = BigInt(Math.floor(Date.now() / 1000));

  // Calculate 3 months in seconds (approximately 90 days)
  const threeMonthsInSeconds = 90n * 24n * 60n * 60n;
  const notAfter = currentTime + threeMonthsInSeconds;

  return {
    notBefore: currentTime,
    notAfter,
  };
}
