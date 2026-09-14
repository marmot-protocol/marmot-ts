import { describe, expect, it } from "vitest";

import { TEST_ACCOUNT_SECRET_KEYS, testAccount } from "./test-accounts.js";

describe("test-accounts", () => {
  it("has 16 secrets, each a 64-char lowercase hex string", () => {
    expect(TEST_ACCOUNT_SECRET_KEYS).toHaveLength(16);
    for (const secret of TEST_ACCOUNT_SECRET_KEYS)
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders testAccount(slot).pubkey in strictly ascending x-only pubkey order", () => {
    let previous: string | null = null;
    for (let i = 0; i < TEST_ACCOUNT_SECRET_KEYS.length; i++) {
      const pubkey = testAccount(i).pubkey;
      if (previous !== null) expect(pubkey > previous).toBe(true);
      previous = pubkey;
    }
  });

  it("pins slot 5 to the well-known secp256k1 generator-point pubkey", () => {
    expect(testAccount(5).pubkey).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
  });

  it("pins slot 14 to the spec vector secret key 3", () => {
    expect(testAccount(14).pubkey).toBe(
      "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
    );
  });

  it("throws RangeError for out-of-range or non-integer slots", () => {
    expect(() => testAccount(-1)).toThrow(RangeError);
    expect(() => testAccount(16)).toThrow(RangeError);
    expect(() => testAccount(1.5)).toThrow(RangeError);
  });
});
