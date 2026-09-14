import { PrivateKeyAccount } from "applesauce-accounts/accounts";

/**
 * Deterministic test-only identities for KeyPackages whose credential must
 * match a real signer (D-02). Each secret is 64 hex chars: 62 zeros followed
 * by a two-digit suffix, listed here in ascending x-only pubkey order so a
 * test migrating from literal pubkeys keeps their relative order by assigning
 * slots in the same order. Slot 14 is the spec vector secret key 3.
 *
 * Never exported from the package — tests are excluded from
 * `tsconfig.build.json` and from `package.json` `exports`.
 */
export const TEST_ACCOUNT_SECRET_KEYS: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000008",
  "0000000000000000000000000000000000000000000000000000000000000005",
  "000000000000000000000000000000000000000000000000000000000000000e",
  "0000000000000000000000000000000000000000000000000000000000000007",
  "000000000000000000000000000000000000000000000000000000000000000b",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "000000000000000000000000000000000000000000000000000000000000000a",
  "0000000000000000000000000000000000000000000000000000000000000009",
  "0000000000000000000000000000000000000000000000000000000000000002",
  "000000000000000000000000000000000000000000000000000000000000000c",
  "000000000000000000000000000000000000000000000000000000000000000f",
  "0000000000000000000000000000000000000000000000000000000000000004",
  "0000000000000000000000000000000000000000000000000000000000000010",
  "000000000000000000000000000000000000000000000000000000000000000d",
  "0000000000000000000000000000000000000000000000000000000000000003",
  "0000000000000000000000000000000000000000000000000000000000000006",
];

/**
 * Returns a deterministic test `PrivateKeyAccount` for `slot`. Slot order
 * equals ascending x-only pubkey order (see {@link TEST_ACCOUNT_SECRET_KEYS}).
 * Callers pass `account.signer` directly — no proof-signer adapter exists
 * (D-04).
 *
 * @throws {RangeError} if `slot` is not an integer in
 *   `[0, TEST_ACCOUNT_SECRET_KEYS.length - 1]`
 */
export function testAccount(slot: number): PrivateKeyAccount<any> {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= TEST_ACCOUNT_SECRET_KEYS.length
  ) {
    throw new RangeError(
      `testAccount: slot must be an integer in [0, ${TEST_ACCOUNT_SECRET_KEYS.length - 1}], got ${slot}`,
    );
  }
  return PrivateKeyAccount.fromKey(TEST_ACCOUNT_SECRET_KEYS[slot]!);
}
