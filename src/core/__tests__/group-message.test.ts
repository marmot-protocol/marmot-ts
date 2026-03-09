import { describe, expect, it, vi } from "vitest";
import {
  createApplicationMessage,
  defaultCryptoProvider,
  encode,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { mlsMessageEncoder } from "ts-mls/message.js";

import {
  createEncryptedGroupEventContent,
  decryptGroupMessageEvent,
} from "../group-message.js";
import { createLegacyEncryptedGroupEventContent } from "../group-message-legacy.js";
import { createCredential } from "../credential.js";
import { createSimpleGroup } from "../group.js";
import { generateKeyPackage } from "../key-package.js";

async function createTestState(pubkey: string) {
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );

  const credential = createCredential(pubkey);
  const keyPackage = await generateKeyPackage({
    credential,
    ciphersuiteImpl: ciphersuite,
  });

  const { clientState } = await createSimpleGroup(
    keyPackage,
    ciphersuite,
    "Test Group",
    { adminPubkeys: [pubkey], relays: [] },
  );

  return { clientState, ciphersuite };
}

describe("group message encryption (MIP-03)", () => {
  it("encrypts and decrypts with MIP-03 ChaCha20-Poly1305 envelope", async () => {
    const { clientState, ciphersuite } = await createTestState("a".repeat(64));

    const { message } = await createApplicationMessage({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: clientState,
      message: new TextEncoder().encode("hello"),
    });

    const content = await createEncryptedGroupEventContent({
      state: clientState,
      ciphersuite,
      message,
    });

    const payload = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
    expect(payload.length).toBeGreaterThan(12);

    const event = {
      id: "e".repeat(64),
      kind: 445,
      pubkey: "f".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "00".repeat(32)]],
      content,
      sig: "1".repeat(128),
    };

    const decoded = await decryptGroupMessageEvent(
      event,
      clientState,
      ciphersuite,
    );

    expect(encode(mlsMessageEncoder, decoded)).toEqual(
      encode(mlsMessageEncoder, message),
    );
  });

  it("decrypts legacy format via fallback and warns once", async () => {
    const { clientState, ciphersuite } = await createTestState("b".repeat(64));

    const { message } = await createApplicationMessage({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: clientState,
      message: new TextEncoder().encode("legacy"),
    });

    const serialized = encode(mlsMessageEncoder, message);
    const legacyContent = await createLegacyEncryptedGroupEventContent({
      state: clientState,
      ciphersuite,
      serializedMessage: serialized,
    });

    const event = {
      id: "d".repeat(64),
      kind: 445,
      pubkey: "c".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "11".repeat(32)]],
      content: legacyContent,
      sig: "2".repeat(128),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await decryptGroupMessageEvent(event, clientState, ciphersuite);
    await decryptGroupMessageEvent(event, clientState, ciphersuite);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("legacy MIP-03 group message");

    warnSpy.mockRestore();
  });

  it("rejects invalid base64 group-event content", async () => {
    const { clientState, ciphersuite } = await createTestState("c".repeat(64));

    const event = {
      id: "a".repeat(64),
      kind: 445,
      pubkey: "b".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "22".repeat(32)]],
      content: "###not-base64###",
      sig: "3".repeat(128),
    };

    await expect(
      decryptGroupMessageEvent(event, clientState, ciphersuite),
    ).rejects.toThrow("Failed to decrypt group message");
  });

  it("rejects payloads shorter than 12-byte nonce", async () => {
    const { clientState, ciphersuite } = await createTestState("d".repeat(64));

    const shortPayload = new Uint8Array(11);
    const content = btoa(String.fromCharCode(...shortPayload));

    const event = {
      id: "9".repeat(64),
      kind: 445,
      pubkey: "8".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "33".repeat(32)]],
      content,
      sig: "4".repeat(128),
    };

    await expect(
      decryptGroupMessageEvent(event, clientState, ciphersuite),
    ).rejects.toThrow("Failed to decrypt group message");
  });

  it("rejects tampered ciphertext/auth tag", async () => {
    const { clientState, ciphersuite } = await createTestState("e".repeat(64));

    const { message } = await createApplicationMessage({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: clientState,
      message: new TextEncoder().encode("tamper-check"),
    });

    const content = await createEncryptedGroupEventContent({
      state: clientState,
      ciphersuite,
      message,
    });

    const payload = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
    payload[payload.length - 1] ^= 0x01;
    const tamperedContent = btoa(String.fromCharCode(...payload));

    const event = {
      id: "7".repeat(64),
      kind: 445,
      pubkey: "6".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "44".repeat(32)]],
      content: tamperedContent,
      sig: "5".repeat(128),
    };

    await expect(
      decryptGroupMessageEvent(event, clientState, ciphersuite),
    ).rejects.toThrow("Failed to decrypt group message");
  });

  it("rejects payload with 12-byte nonce and empty ciphertext", async () => {
    const { clientState, ciphersuite } = await createTestState("f".repeat(64));

    const nonceOnly = new Uint8Array(12);
    const content = btoa(String.fromCharCode(...nonceOnly));

    const event = {
      id: "5".repeat(64),
      kind: 445,
      pubkey: "4".repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "55".repeat(32)]],
      content,
      sig: "6".repeat(128),
    };

    await expect(
      decryptGroupMessageEvent(event, clientState, ciphersuite),
    ).rejects.toThrow("Failed to decrypt group message");
  });
});
