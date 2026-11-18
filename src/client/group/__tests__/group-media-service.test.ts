import { randomBytes } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  ClientState,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import {
  mediaSourceStateToken,
  type MediaAttachment,
} from "../../../core/media.js";
import { GroupMediaService } from "../group-media-service.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

const ADMIN_ACCOUNT = testAccount(6);
const ADMIN = ADMIN_ACCOUNT.pubkey;

async function createState(impl: CiphersuiteImpl) {
  const credential = createCredential(ADMIN);
  const kp = await generateKeyPackage({
    credential,
    ciphersuiteImpl: impl,
    signer: ADMIN_ACCOUNT.signer,
  });
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

async function makeService() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const state = await createState(impl);
  const service = new GroupMediaService({
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

  it("re-derives and re-verifies every sequential decrypt", async () => {
    const service = await makeService();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "application/octet-stream",
    });
    const { encrypted, attachment } = await service.encryptMedia(blob, {
      filename: "blob.bin",
    });

    const first = await service.decryptMedia(encrypted, attachment);
    const second = await service.decryptMedia(encrypted, attachment);

    // Nothing is cached: each read decrypts (and verifies) independently.
    expect(second).not.toBe(first);
    expect(second.data).toEqual(first.data);
  });

  it("deduplicates concurrent decrypts of the same file", async () => {
    const service = await makeService();
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

    // Both callers share the one in-flight decryption.
    expect(a).toBe(b);
    expect(a.data).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("decrypts media from an older epoch after the local tip advances", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const sourceState = await createState(impl);
    const sender = new GroupMediaService({
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
      getState: () => tip,
      getCiphersuite: () => impl,
      getRetainedStates: () => [tip, sourceState],
    });

    const { data } = await receiver.decryptMedia(
      encrypted,
      attachment,
      mediaSourceStateToken(sourceState),
    );
    expect(data).toEqual(plaintext);
  });

  it("fails to decrypt older-epoch media once the source epoch is pruned", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const sourceState = await createState(impl);
    const sender = new GroupMediaService({
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
      getState: () => tip,
      getCiphersuite: () => impl,
      getRetainedStates: () => [tip],
    });

    await expect(
      receiver.decryptMedia(
        encrypted,
        attachment,
        mediaSourceStateToken(sourceState),
      ),
    ).rejects.toThrow(/no longer retained/);
  });

  it("throws when decrypting an attachment without a ciphertextSha256", async () => {
    const service = await makeService();
    await expect(
      service.decryptMedia(new Uint8Array(), {
        ciphertextSha256: "",
      } as MediaAttachment),
    ).rejects.toThrow(/required/);
  });
});

describe("v2 receive validation", () => {
  it("does not let a previously decrypted ciphertext hash authenticate changed metadata", async () => {
    const service = await makeService();
    const { encrypted, attachment } = await service.encryptMedia(
      new Blob(["secret"], { type: "text/plain" }),
      { filename: "a.txt" },
    );
    await service.decryptMedia(encrypted, attachment);
    await expect(
      service.decryptMedia(encrypted, {
        ...attachment,
        filename: "forged.txt",
      }),
    ).rejects.toThrow();
    await expect(
      service.decryptMedia(encrypted, {
        ...attachment,
        mediaType: "TEXT/PLAIN",
      }),
    ).rejects.toThrow(/canonical/);
    await expect(
      service.decryptMedia(new Uint8Array(encrypted.length), attachment),
    ).rejects.toThrow();
  });

  it("does not guess another retained source when the requested branch is absent", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const source = await createState(impl);
    let current = source;
    const service = new GroupMediaService({
      getState: () => current,
      getCiphersuite: () => impl,
      getRetainedStates: () => [source],
    });
    const { encrypted, attachment, expectedParent } =
      await service.encryptMedia(new Blob(["secret"], { type: "text/plain" }), {
        filename: "a.txt",
      });
    current = {
      ...source,
      confirmationTag: new Uint8Array(32).fill(71),
      keySchedule: { ...source.keySchedule, exporterSecret: randomBytes(32) },
    };
    await expect(service.decryptMedia(encrypted, attachment)).rejects.toThrow();
    await expect(
      service.decryptMedia(encrypted, attachment, expectedParent),
    ).resolves.toMatchObject({
      data: new TextEncoder().encode("secret"),
    });
    await expect(
      service.decryptMedia(encrypted, attachment, "missing-branch"),
    ).rejects.toThrow(/no longer retained/);
  });
});
