import { describe, expect, it } from "vitest";
import { memoryStorage } from "../../utils/storage.js";
import { EncryptedStorage } from "../encrypted-storage.js";

const text = (value: string) => new TextEncoder().encode(value);
const read = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

describe("EncryptedStorage", () => {
  it("encrypts values at rest and decrypts on read", async () => {
    const inner = memoryStorage();
    const storage = new EncryptedStorage(inner, new Uint8Array(32).fill(7));
    await storage.set("secret", text("hello"));
    expect(read(await inner.get("secret"))).not.toContain("hello");
    expect(read(await storage.get("secret"))).toBe("hello");
  });

  it("binds values to their key", async () => {
    const inner = memoryStorage();
    const storage = new EncryptedStorage(inner, new Uint8Array(32).fill(7));
    await storage.set("a", text("value"));
    await inner.set("b", (await inner.get("a"))!);
    await expect(storage.get("b")).rejects.toThrow();
  });

  it("encrypts batch writes", async () => {
    const inner = memoryStorage();
    const storage = new EncryptedStorage(inner, new Uint8Array(32).fill(1));
    await storage.batch([
      { type: "set", key: "x", value: text("one") },
      { type: "delete", key: "missing" },
    ]);
    expect(read(await storage.get("x"))).toBe("one");
  });

  it("reopens with the right password and rejects a wrong one", async () => {
    const inner = memoryStorage();
    const options = { iterations: 1000 };
    const first = await EncryptedStorage.fromPassword(inner, "pw", options);
    await first.set("k", text("v"));
    expect(await first.list("")).toEqual(["k"]);

    const again = await EncryptedStorage.fromPassword(inner, "pw", options);
    expect(read(await again.get("k"))).toBe("v");

    await expect(
      EncryptedStorage.fromPassword(inner, "wrong", options),
    ).rejects.toThrow("Wrong password");
  });
});
