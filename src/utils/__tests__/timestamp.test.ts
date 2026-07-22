import { describe, expect, it } from "vitest";

import {
  createDefaultKeyPackageLifetime,
  createThreeMonthLifetime,
  isLifetimeCurrentWithGrace,
  isLifetimeWithinCap,
} from "../timestamp.js";

describe("createDefaultKeyPackageLifetime", () => {
  it("yields an 84-day range with a ~1h backdated notBefore (D-07)", () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const lifetime = createDefaultKeyPackageLifetime();
    const after = BigInt(Math.floor(Date.now() / 1000));

    expect(lifetime.notAfter - lifetime.notBefore).toBe(7257600n);
    // notBefore === now - 3600, within a ±2s tolerance on the now-read.
    expect(lifetime.notBefore).toBeGreaterThanOrEqual(before - 3600n - 2n);
    expect(lifetime.notBefore).toBeLessThanOrEqual(after - 3600n + 2n);
  });
});

describe("createThreeMonthLifetime (deprecated alias)", () => {
  it("still resolves and produces the identical capped lifetime (D-07/D-09)", () => {
    const lifetime = createThreeMonthLifetime();
    expect(lifetime.notAfter - lifetime.notBefore).toBe(7257600n);
  });
});

describe("isLifetimeWithinCap", () => {
  it("returns true at the cap boundary (7261200n)", () => {
    expect(isLifetimeWithinCap({ notBefore: 0n, notAfter: 7261200n })).toBe(
      true,
    );
  });

  it("returns true under the cap (7257600n)", () => {
    expect(isLifetimeWithinCap({ notBefore: 0n, notAfter: 7257600n })).toBe(
      true,
    );
  });

  it("returns false over the cap (7261201n)", () => {
    expect(isLifetimeWithinCap({ notBefore: 0n, notAfter: 7261201n })).toBe(
      false,
    );
  });
});

describe("isLifetimeCurrentWithGrace", () => {
  it("returns false when notAfter is expired beyond the ~1h grace", () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(
      isLifetimeCurrentWithGrace({
        notBefore: now - 10_000n,
        notAfter: now - 7200n,
      }),
    ).toBe(false);
  });

  it("returns true when notBefore is inside the ~1h grace", () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(
      isLifetimeCurrentWithGrace({
        notBefore: now - 1800n,
        notAfter: now + 10_000n,
      }),
    ).toBe(true);
  });
});
