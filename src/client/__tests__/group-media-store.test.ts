import { describe, expect, it, vi } from "vitest";
import { GroupMediaStore } from "../group/group-media-store.js";
import type { StoredMedia } from "../group/marmot-group.js";

function entry(id: string): StoredMedia {
  return {
    data: new Uint8Array([1]),
    attachment: {
      version: "encrypted-media-v2",
      locators: [],
      ciphertextSha256: id.repeat(64),
      plaintextSha256: "a".repeat(64),
      nonce: "b".repeat(24),
      mediaType: "image/png",
      filename: `${id}.png`,
    },
  };
}

describe("media-store snapshots", () => {
  it("reflects additions, removals, and clearing between pulls", async () => {
    const store = new GroupMediaStore();
    const watcher = store.subscribe();
    const first = entry("1");
    const second = entry("2");
    try {
      expect((await watcher.next()).value).toEqual([]);
      await store.addMedia(first.attachment.ciphertextSha256, first);
      await store.addMedia(second.attachment.ciphertextSha256, second);
      expect((await watcher.next()).value).toEqual([
        first.attachment,
        second.attachment,
      ]);
      await store.removeMedia(first.attachment.ciphertextSha256);
      expect((await watcher.next()).value).toEqual([second.attachment]);
      await store.clearMedia();
      expect((await watcher.next()).value).toEqual([]);
    } finally {
      await watcher.return(undefined);
    }
    expect(store.eventNames()).toEqual([]);
  });

  it("rereads a snapshot overtaken by a cache change", async () => {
    const store = new GroupMediaStore();
    let resolve!: (value: []) => void;
    vi.spyOn(store, "listMedia").mockImplementationOnce(
      () =>
        new Promise<[]>((yes) => {
          resolve = yes;
        }),
    );
    const watcher = store.subscribe();
    const pending = watcher.next();
    try {
      const item = entry("1");
      await store.addMedia(item.attachment.ciphertextSha256, item);
      resolve([]);
      expect((await pending).value).toEqual([item.attachment]);
    } finally {
      await watcher.return(undefined);
    }
  });
});
