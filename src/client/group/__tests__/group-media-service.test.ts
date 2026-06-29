import { randomBytes } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  ClientState,
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

/**
 * Simulates the canonical tip advancing one epoch: a fresh exporter secret (so
 * the source-epoch media key no longer derives from it) and a bumped epoch.
 */
function advanceEpoch(state: ClientState): ClientState {
  return {
    ...state,
    groupContext: {
      ...state.groupContext,
      epoch: state.groupContext.epoch + 1n,
    },
    keySchedule: {
      ...state.keySchedule,
      exporterSecret: randomBytes(32),
    },
  };
}

/** Minimal in-memory media cache (keyed by ciphertextSha256) that records calls. */
function makeMediaCache(): BaseGroupMedia {
  const entries = new Map<string, StoredMedia>();
  return {
    addMedia: vi.fn(async (key: string, entry: StoredMedia) => {
      entries.set(key, entry);
    }),
    getMedia: vi.fn(async (key: string) => entries.get(key) ?? null),
    removeMedia: vi.fn(async (key: string) => {
      entries.delete(key);
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

  it("decrypts media from an older epoch after the local tip advances", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const sourceState = await createState(impl);
    const sender = new GroupMediaService({
      media: undefined as unknown as BaseGroupMedia,
      getState: () => sourceState,
      getCiphersuite: () => impl,
    });
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const { encrypted, attachment } = await sender.encryptMedia(
      new Blob([plaintext], { type: "application/octet-stream" }),
      { filename: "old.bin" },
    );

    // The tip advanced to a new epoch with a fresh exporter secret; the source
    // epoch's state is still within the retained window.
    const tip = advanceEpoch(sourceState);
    const receiver = new GroupMediaService({
      media: undefined as unknown as BaseGroupMedia,
      getState: () => tip,
      getCiphersuite: () => impl,
      getRetainedStates: () => [tip, sourceState],
    });

    const { data } = await receiver.decryptMedia(encrypted, attachment);
    expect(data).toEqual(plaintext);
  });

  it("fails to decrypt older-epoch media once the source epoch is pruned", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const sourceState = await createState(impl);
    const sender = new GroupMediaService({
      media: undefined as unknown as BaseGroupMedia,
      getState: () => sourceState,
      getCiphersuite: () => impl,
    });
    const { encrypted, attachment } = await sender.encryptMedia(
      new Blob([new Uint8Array([6, 7, 8])], {
        type: "application/octet-stream",
      }),
      { filename: "gone.bin" },
    );

    // Only the advanced tip remains retained — the source epoch was pruned.
    const tip = advanceEpoch(sourceState);
    const receiver = new GroupMediaService({
      media: undefined as unknown as BaseGroupMedia,
      getState: () => tip,
      getCiphersuite: () => impl,
      getRetainedStates: () => [tip],
    });

    await expect(receiver.decryptMedia(encrypted, attachment)).rejects.toThrow(
      /did not authenticate/,
    );
  });

  it("throws when decrypting an attachment without a ciphertextSha256", async () => {
    const service = await makeService();
    await expect(
      service.decryptMedia(new Uint8Array(), {
        ciphertextSha256: "",
      } as MediaAttachment),
    ).rejects.toThrow(/ciphertextSha256 is required/);
  });
});
