/** @module @category Utilities */
import { defaultLifetime, Lifetime } from "ts-mls";

/**
 * The maximum allowed KeyPackage `Lifetime` range (84 days + 1h headroom,
 * 7,261,200 s), per the post-#236 wire-boundary cap (D-08).
 */
const MAX_KEY_PACKAGE_LIFETIME_SECONDS = 7_261_200n;

/**
 * The symmetric clock-skew grace window (~1h, 3600 s) applied both to the
 * produce-side backdate and the inbound current-check (D-07/D-08).
 */
const LIFETIME_GRACE_SECONDS = 3600n;

/**
 * Formats a bigint timestamp to a readable date string, handling special MLS timestamp values.
 *
 * @param timestamp - The timestamp as a bigint (typically from MLS lifetime fields)
 * @returns A formatted date string or descriptive text for special values
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
 * Creates the default produced KeyPackage lifetime: an 84-day range
 * (7,257,600 s — deliberately ~1h under the 7,261,200 s cap for headroom),
 * with `notBefore` backdated ~1h so a peer's minor clock skew does not
 * reject a just-published KeyPackage as not-yet-valid (D-07).
 *
 * @returns A lifetime object with notBefore backdated ~1h and notAfter 84 days after notBefore
 */
export function createDefaultKeyPackageLifetime(): Lifetime {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const notBefore = now - LIFETIME_GRACE_SECONDS;
  const eightyFourDaysInSeconds = 84n * 24n * 60n * 60n;
  const notAfter = notBefore + eightyFourDaysInSeconds;

  return { notBefore, notAfter };
}

/**
 * Creates a lifetime with a 3-month expiration from the current time.
 *
 * @deprecated Use {@link createDefaultKeyPackageLifetime} instead.
 * @returns A lifetime object with notBefore set to current time and notAfter set to 3 months from now
 */
export function createThreeMonthLifetime(): Lifetime {
  return createDefaultKeyPackageLifetime();
}

/**
 * Checks whether a lifetime's range is within the ≤7,261,200 s (84 days + 1h)
 * cap (D-08). This is a strict check — no grace is applied to the range
 * itself (only to the current-check, see {@link isLifetimeCurrentWithGrace}).
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if `notAfter - notBefore` is within the cap, false otherwise
 */
export function isLifetimeWithinCap(lifetime: Lifetime): boolean {
  return (
    lifetime.notAfter - lifetime.notBefore <= MAX_KEY_PACKAGE_LIFETIME_SECONDS
  );
}

/**
 * Checks whether a lifetime is current, applying a symmetric ~1h grace
 * window to tolerate minor clock skew (D-08): rejects only if `now` is
 * before `notBefore - 3600` or after `notAfter + 3600`.
 *
 * @param lifetime - The lifetime object with notBefore and notAfter fields
 * @returns True if `now` is within the lifetime's range plus grace, false otherwise
 */
export function isLifetimeCurrentWithGrace(lifetime: Lifetime): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (
    now >= lifetime.notBefore - LIFETIME_GRACE_SECONDS &&
    now <= lifetime.notAfter + LIFETIME_GRACE_SECONDS
  );
}
