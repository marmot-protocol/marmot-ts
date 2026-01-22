import { NostrEvent, unixNow } from "applesauce-core/helpers";
import {
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { createCredential } from "../core/credential.js";
import { generateKeyPackage } from "../core/key-package";
import {
  createDeleteKeyPackageEvent,
  createKeyPackageEvent,
  getKeyPackage,
} from "../core/key-package-event.js";
import { KEY_PACKAGE_KIND } from "../core/protocol.js";

const mockPubkey =
  "02a1633cafe37eeebe2b39b4ec5f3d74c35e61fa7e7e6b7b8c5f7c4f3b2a1b2c3d";
const mockSig = "304502210...";

describe("createDeleteKeyPackageEvent", () => {
  it("should create a valid kind 5 delete event with event IDs", () => {
    const eventIds = ["abc123def456", "789ghi012jkl", "345mno678pqr"];

    const deleteEvent = createDeleteKeyPackageEvent({
      pubkey: mockPubkey,
      events: eventIds,
    });

    expect(deleteEvent.kind).toBe(5);
    expect(deleteEvent.pubkey).toBe(mockPubkey);
    expect(deleteEvent.content).toBe("");
    expect(deleteEvent.created_at).toBeGreaterThan(0);

    // Check for k tag
    const kTag = deleteEvent.tags.find((t) => t[0] === "k");
    expect(kTag).toEqual(["k", "443"]);

    // Check for e tags
    const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
    expect(eTags).toHaveLength(3);
    expect(eTags).toEqual([
      ["e", "abc123def456"],
      ["e", "789ghi012jkl"],
      ["e", "345mno678pqr"],
    ]);
  });

  it("should create a valid kind 5 delete event with full NostrEvent objects", () => {
    const keyPackageEvents: NostrEvent[] = [
      {
        kind: KEY_PACKAGE_KIND,
        id: "event1id",
        pubkey: mockPubkey,
        created_at: 1693876543,
        tags: [],
        content: "aabbccdd",
        sig: mockSig,
      },
      {
        kind: KEY_PACKAGE_KIND,
        id: "event2id",
        pubkey: mockPubkey,
        created_at: 1693876544,
        tags: [],
        content: "eeffgghh",
        sig: mockSig,
      },
    ];

    const deleteEvent = createDeleteKeyPackageEvent({
      pubkey: mockPubkey,
      events: keyPackageEvents,
    });

    expect(deleteEvent.kind).toBe(5);
    expect(deleteEvent.pubkey).toBe(mockPubkey);

    // Check for k tag
    const kTag = deleteEvent.tags.find((t) => t[0] === "k");
    expect(kTag).toEqual(["k", "443"]);

    // Check for e tags
    const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
    expect(eTags).toHaveLength(2);
    expect(eTags).toEqual([
      ["e", "event1id"],
      ["e", "event2id"],
    ]);
  });

  it("should throw an error when no events are provided", () => {
    expect(() => {
      createDeleteKeyPackageEvent({
        pubkey: mockPubkey,
        events: [],
      });
    }).toThrow("At least one event must be provided for deletion");
  });

  it("should throw an error when a full event is not kind 443", () => {
    const wrongKindEvent: NostrEvent = {
      kind: 1, // Wrong kind (text note instead of key package)
      id: "wrongeventid",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [],
      content: "Hello world",
      sig: mockSig,
    };

    expect(() => {
      createDeleteKeyPackageEvent({
        pubkey: mockPubkey,
        events: [wrongKindEvent],
      });
    }).toThrow(
      `Event wrongeventid is not a key package event (kind 1 instead of ${KEY_PACKAGE_KIND})`,
    );
  });

  it("should handle mixed event IDs and full events", () => {
    const keyPackageEvent: NostrEvent = {
      kind: KEY_PACKAGE_KIND,
      id: "fulleventid",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [],
      content: "aabbccdd",
      sig: mockSig,
    };

    const deleteEvent = createDeleteKeyPackageEvent({
      pubkey: mockPubkey,
      events: ["stringeventid1", keyPackageEvent, "stringeventid2"],
    });

    expect(deleteEvent.kind).toBe(5);

    const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
    expect(eTags).toHaveLength(3);
    expect(eTags).toEqual([
      ["e", "stringeventid1"],
      ["e", "fulleventid"],
      ["e", "stringeventid2"],
    ]);
  });
});

describe("createKeyPackageEvent encoding", () => {
  const validPubkey =
    "884704bd421671e01c13f854d2ce23ce2a5bfe9562f4f297ad2bc921ba30c3a6";

  it("should create event with base64 encoding and encoding tag", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      pubkey: validPubkey,
      relays: ["wss://relay.example.com"],
    });

    // Should have encoding tag
    const encodingTag = event.tags.find((t) => t[0] === "encoding");
    expect(encodingTag).toEqual(["encoding", "base64"]);

    // Content should be base64 (contains characters like +, /, =)
    // or at least not be pure hex (which would only have 0-9a-f)
    const hasBase64Chars =
      /[+/=]/.test(event.content) ||
      event.content.length % 2 !== 0 ||
      /[g-zG-Z]/.test(event.content);
    expect(hasBase64Chars).toBe(true);
  });

  it("should be able to decode base64-encoded key package event", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const originalKeyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = createKeyPackageEvent({
      keyPackage: originalKeyPackage.publicPackage,
      pubkey: validPubkey,
      relays: ["wss://relay.example.com"],
    });

    // Mock the event as if it came from a relay
    const mockEvent: NostrEvent = {
      ...event,
      id: "test-event-id",
      sig: "test-signature",
    };

    // Should be able to decode it
    const decodedKeyPackage = getKeyPackage(mockEvent);
    expect(decodedKeyPackage).toBeDefined();
    expect(decodedKeyPackage.leafNode.credential).toEqual(credential);
  });

  it("should still decode legacy hex-encoded events without encoding tag", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    // Create a legacy event (hex-encoded, no encoding tag)
    const { encodeKeyPackage } = await import("ts-mls/keyPackage.js");
    const { bytesToHex } = await import("@noble/ciphers/utils.js");

    const encodedBytes = encodeKeyPackage(keyPackage.publicPackage);
    const legacyEvent: NostrEvent = {
      kind: KEY_PACKAGE_KIND,
      pubkey: validPubkey,
      created_at: unixNow(),
      content: bytesToHex(encodedBytes), // Hex encoding
      tags: [
        ["mls_version", "1.0"],
        ["cipher_suite", "0x0001"],
        ["extensions", "0x000a"],
        ["relays", "wss://relay.example.com"],
        // No encoding tag
      ],
      id: "legacy-event-id",
      sig: "legacy-signature",
    };

    // Should be able to decode legacy hex format
    const decodedKeyPackage = getKeyPackage(legacyEvent);
    expect(decodedKeyPackage).toBeDefined();
    expect(decodedKeyPackage.leafNode.credential).toEqual(credential);
  });

  it("should decode hex-encoded events with explicit hex encoding tag", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const { encodeKeyPackage } = await import("ts-mls/keyPackage.js");
    const { bytesToHex } = await import("@noble/ciphers/utils.js");

    const encodedBytes = encodeKeyPackage(keyPackage.publicPackage);
    const hexEvent: NostrEvent = {
      kind: KEY_PACKAGE_KIND,
      pubkey: validPubkey,
      created_at: unixNow(),
      content: bytesToHex(encodedBytes),
      tags: [
        ["mls_version", "1.0"],
        ["cipher_suite", "0x0001"],
        ["extensions", "0x000a"],
        ["relays", "wss://relay.example.com"],
        ["encoding", "hex"], // Explicit hex tag
      ],
      id: "hex-event-id",
      sig: "hex-signature",
    };

    // Should be able to decode with explicit hex tag
    const decodedKeyPackage = getKeyPackage(hexEvent);
    expect(decodedKeyPackage).toBeDefined();
    expect(decodedKeyPackage.leafNode.credential).toEqual(credential);
  });
});
