import { describe, expect, it, vi } from "vitest";
import { sessionDatabase } from "./session-database.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("session key-package storage", () => {
  it("restores private bytes and the slot without sharing local/live or account state", async () => {
    const saved = storage();
    const first = await sessionDatabase("a".repeat(64), "local", saved);
    await first.database.account.transaction(async (tx) => {
      await tx.keyPackages.put({
        ref: "ref",
        identifier: first.clientId,
        publicPackage: new Uint8Array([1, 2, 3]),
        privatePackage: new Uint8Array([4, 5, 6]),
        used: false,
        notBefore: 1,
        published: [],
        consumptionReceipts: [],
      });
    });
    const restored = await sessionDatabase("a".repeat(64), "local", saved);
    expect(restored.clientId).toBe(first.clientId);
    expect(
      (await restored.database.account.keyPackages.get("ref"))?.privatePackage,
    ).toEqual(new Uint8Array([4, 5, 6]));
    const live = await sessionDatabase("a".repeat(64), "live", saved);
    expect(live.clientId).not.toBe(first.clientId);
    expect(await live.database.account.keyPackages.all()).toEqual([]);
    const other = await sessionDatabase("b".repeat(64), "local", saved);
    expect(await other.database.account.keyPackages.all()).toEqual([]);
  });

  it("rolls back a transaction if session storage cannot retain the keys", async () => {
    const saved = storage();
    const { database } = await sessionDatabase("a".repeat(64), "local", saved);
    saved.setItem.mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    await expect(
      database.account.transaction(async (tx) => {
        await tx.keyPackages.put({
          ref: "ref",
          publicPackage: new Uint8Array([1]),
          privatePackage: new Uint8Array([2]),
          used: false,
          notBefore: 1,
          published: [],
          consumptionReceipts: [],
        });
      }),
    ).rejects.toThrow("Quota exceeded");
    expect(await database.account.keyPackages.all()).toEqual([]);
  });
});
