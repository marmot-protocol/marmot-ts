import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import type { MediaAttachment } from "../../../core/media.js";
import { GroupMediaService } from "../group-media-service.js";
import type { BaseGroupMedia, StoredMedia } from "../marmot-group.js";

const ADMIN = "a".repeat(64);

async function createState(impl: CiphersuiteImpl) {
  const credential = createCredential(ADMIN);
  const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
  const { clientState } = await createSimpleGroup(kp, impl, "Media Group", {
    adminPubkeys: [ADMIN],
    relays: [],
  });
  return clientState;
}

/** Minimal in-memory media cache that records call counts. */
function makeMediaCache(): BaseGroupMedia {
  const entries = new Map<string, StoredMedia>();
  return {
    addMedia: vi.fn(async (sha256: string, entry: StoredMedia) => {
      entries.set(sha256, entry);
    }),
    getMedia: vi.fn(async (sha256: string) => entries.get(sha256) ?? null),
    removeMedia: vi.fn(async (sha256: string) => {
      entries.delete(sha256);
    }),
    listMedia: vi.fn(async () =>
      [...entries.values()].map((e) => e.attachment),
    ),
    clearMedia: vi.fn(async () => entries.clear()),
  };
}

async function makeService(media?: BaseGroupMedia) {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const state = await createState(impl);
  const service = new GroupMediaService({
    media: media as BaseGroupMedia,
    getState: () => state,
    getCiphersuite: () => impl,
  });
  return service;
}

describe("GroupMediaService", () => {
  it("round-trips an encrypted media file back to its plaintext", async () => {
    const service = await makeService();
    const plaintext = new TextEncoder().encode("the original bytes");
    const blob = new Blob([plaintext], { type: "text/plain" });

    const { encrypted, attachment } = await service.encryptMedia(blob, {
      filename: "note.txt",
    });

    const { data } = await service.decryptMedia(encrypted, attachment);
    expect(data).toEqual(plaintext);
  });

  it("serves a second decrypt from the cache without re-deriving", async () => {
    const cache = makeMediaCache();
    const service = await makeService(cache);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "application/octet-stream",
    });
    const { encrypted, attachment } = await service.encryptMedia(blob, {
      filename: "blob.bin",
    });

    await service.decryptMedia(encrypted, attachment);
    await service.decryptMedia(encrypted, attachment);

    // Stored once on first decrypt; second call hits the cache.
    expect(cache.addMedia).toHaveBeenCalledOnce();
    expect(cache.getMedia).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent decrypts of the same file", async () => {
    const cache = makeMediaCache();
    const service = await makeService(cache);
    const blob = new Blob([new Uint8Array([9, 8, 7])], {
      type: "application/octet-stream",
    });
    const { encrypted, attachment } = await service.encryptMedia(blob, {
      filename: "race.bin",
    });

    const [a, b] = await Promise.all([
      service.decryptMedia(encrypted, attachment),
      service.decryptMedia(encrypted, attachment),
    ]);

    expect(a.data).toEqual(b.data);
    // Only one in-flight decryption should reach the cache write.
    expect(cache.addMedia).toHaveBeenCalledOnce();
  });

  it("throws when decrypting an attachment without a sha256", async () => {
    const service = await makeService();
    await expect(
      service.decryptMedia(new Uint8Array(), {
        sha256: "",
      } as MediaAttachment),
    ).rejects.toThrow(/sha256 is required/);
  });
});
