import { NostrEvent, unixNow } from "applesauce-core/helpers";
import { bytesToHex } from "@noble/ciphers/utils.js";
import {
  base64ToBytes,
  bytesToBase64,
  decode,
  defaultCryptoProvider,
  encode,
  getCiphersuiteImpl,
  greaseValues,
  keyPackageDecoder,
  keyPackageEncoder,
  makeCustomExtension,
  mlsMessageEncoder,
  wireformats,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import {
  createDeleteKeyPackageEvent,
  createKeyPackageEvent,
  getKeyPackage,
  getKeyPackageIdentifier,
  getKeyPackageNostrPubkey,
} from "../key-package-event.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../protocol.js";

const mockPubkey =
  "02a1633cafe37eeebe2b39b4ec5f3d74c35e61fa7e7e6b7b8c5f7c4f3b2a1b2c3d";
const mockSig = "304502210...";
const mockD =
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

describe("createDeleteKeyPackageEvent", () => {
  it("should create a valid kind 5 delete event with string event IDs", () => {
    const eventIds = ["abc123def456", "789ghi012jkl", "345mno678pqr"];

    const deleteEvent = createDeleteKeyPackageEvent({
      events: eventIds,
    });

    expect(deleteEvent.kind).toBe(5);
    expect(deleteEvent.content).toBe("");
    expect(deleteEvent.created_at).toBeGreaterThan(0);

    // Only the kind 30443 k tag is included.
    const kTags = deleteEvent.tags.filter((t) => t[0] === "k");
    expect(kTags).toEqual([["k", "30443"]]);

    // Check for e tags
    const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
    expect(eTags).toHaveLength(3);
    expect(eTags).toEqual([
      ["e", "abc123def456"],
      ["e", "789ghi012jkl"],
      ["e", "345mno678pqr"],
    ]);
  });

  it("should create a valid kind 5 delete event with kind 30443 events, including a tags", () => {
    const addressableEvent: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      id: "addrEvent1",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [["d", mockD]],
      content: "aabbccdd",
      sig: mockSig,
    };

    const deleteEvent = createDeleteKeyPackageEvent({
      events: [addressableEvent],
    });

    expect(deleteEvent.kind).toBe(5);

    // Only kind 30443 k tag
    const kTags = deleteEvent.tags.filter((t) => t[0] === "k");
    expect(kTags).toEqual([["k", "30443"]]);

    // e tag present
    const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
    expect(eTags).toEqual([["e", "addrEvent1"]]);

    // a tag present with correct coordinate
    const aTags = deleteEvent.tags.filter((t) => t[0] === "a");
    expect(aTags).toHaveLength(1);
    expect(aTags[0]).toEqual([
      "a",
      `${ADDRESSABLE_KEY_PACKAGE_KIND}:${mockPubkey}:${mockD}`,
    ]);
  });

  it("should throw an error when no events are provided", () => {
    expect(() => {
      createDeleteKeyPackageEvent({
        events: [],
      });
    }).toThrow("At least one event must be provided for deletion");
  });

  it("should throw an error when a full event is not kind 30443", () => {
    const wrongKindEvent: NostrEvent = {
      kind: 1,
      id: "wrongeventid",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [],
      content: "Hello world",
      sig: mockSig,
    };

    expect(() => {
      createDeleteKeyPackageEvent({
        events: [wrongKindEvent],
      });
    }).toThrow(
      `Event wrongeventid is not a key package event (kind 1 instead of ${ADDRESSABLE_KEY_PACKAGE_KIND})`,
    );
  });

  it("should handle mixed event IDs and full events", () => {
    const keyPackageEvent: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      id: "fulleventid",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [],
      content: "aabbccdd",
      sig: mockSig,
    };

    const deleteEvent = createDeleteKeyPackageEvent({
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

  it("should omit a tag for kind 30443 event with no d tag", () => {
    const addrEventNoD: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      id: "noDEvent",
      pubkey: mockPubkey,
      created_at: 1693876543,
      tags: [], // no d tag
      content: "aabbccdd",
      sig: mockSig,
    };

    const deleteEvent = createDeleteKeyPackageEvent({
      events: [addrEventNoD],
    });

    // e tag present
    expect(deleteEvent.tags.filter((t) => t[0] === "e")).toHaveLength(1);
    // No a tag since d is missing
    expect(deleteEvent.tags.filter((t) => t[0] === "a")).toHaveLength(0);
  });
});

describe("createKeyPackageEvent", () => {
  const validPubkey =
    "884704bd421671e01c13f854d2ce23ce2a5bfe9562f4f297ad2bc921ba30c3a6";
  const testD =
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  it("should create a kind 30443 event (addressable)", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
      relays: ["wss://relay.example.com"],
    });

    expect(event.kind).toBe(ADDRESSABLE_KEY_PACKAGE_KIND);
  });

  it("should include d tag with the provided slot identifier", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    const dTag = event.tags.find((t) => t[0] === "d");
    expect(dTag).toEqual(["d", testD]);
  });

  it("encodes base64 content with no encoding tag and the required tags", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
      relays: ["wss://relay.example.com"],
    });

    // NIP-70 protected tag should be opt-in
    expect(event.tags.some((t) => t[0] === "-")).toBe(false);

    // The spec forbids an `encoding` tag (transports/nostr.md).
    expect(event.tags.some((t) => t[0] === "encoding")).toBe(false);

    // Required tag set MUST include mls_proposals and app_components, non-empty.
    const proposals = event.tags.find((t) => t[0] === "mls_proposals");
    expect(proposals).toBeDefined();
    expect(proposals!.length).toBeGreaterThan(1);
    expect(proposals!.slice(1)).toContain("0x0008"); // app_data_update

    const appComponents = event.tags.find((t) => t[0] === "app_components");
    expect(appComponents).toBeDefined();
    expect(appComponents!.length).toBeGreaterThan(1);
    expect(appComponents!.slice(1)).toContain("0x8001"); // group.profile
    expect(
      appComponents!.every((v, i) => i === 0 || /^0x[0-9a-f]{4}$/.test(v)),
    );

    // Content should be base64
    const hasBase64Chars =
      /[+/=]/.test(event.content) ||
      event.content.length % 2 !== 0 ||
      /[g-zG-Z]/.test(event.content);
    expect(hasBase64Chars).toBe(true);
  });

  it("should include NIP-70 protected tag when enabled", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
      protected: true,
    });

    expect(event.tags.some((t) => t[0] === "-")).toBe(true);
  });

  it("should filter GREASE extensions from advertised extension tags", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      extensions: [
        makeCustomExtension({
          extensionType: greaseValues[0],
          extensionData: new Uint8Array([1]),
        }),
      ],
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    const extensionsTag = event.tags.find((tag) => tag[0] === "mls_extensions");
    expect(extensionsTag).toBeDefined();
    expect(extensionsTag).not.toContain(
      `0x${greaseValues[0].toString(16).padStart(4, "0")}`,
    );
  });

  it("should be able to decode base64-encoded key package event", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const originalKeyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: originalKeyPackage.publicPackage,
      identifier: testD,
      relays: ["wss://relay.example.com"],
    });

    // Mock the event as if it came from a relay
    const mockEvent: NostrEvent = {
      ...event,
      pubkey: "test-pubkey",
      id: "test-event-id",
      sig: "test-signature",
    };

    // Should be able to decode it
    const decodedKeyPackage = getKeyPackage(mockEvent);
    expect(decodedKeyPackage).toBeDefined();
    expect(decodedKeyPackage.leafNode.credential).toEqual(credential);
  });

  it("decodes a base64 KeyPackage event that carries no encoding tag", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    // Build a kind 30443 event from the canonical (base64) content with no
    // encoding tag — exactly what a spec-conformant peer publishes.
    const template = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });
    const event: NostrEvent = {
      ...template,
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      pubkey: validPubkey,
      id: "decode-id",
      sig: "decode-sig",
    };
    expect(event.tags.some((t) => t[0] === "encoding")).toBe(false);

    const decoded = getKeyPackage(event);
    expect(decoded.leafNode.credential).toEqual(credential);
  });

  it("publishes a bare KeyPackage (no MLSMessage frame)", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    // Spec-correct content is a bare RFC 9420 KeyPackage: ProtocolVersion mls10
    // (00 01) followed directly by CipherSuite 0x0001 — NOT an MLSMessage frame,
    // whose byte 2-3 would be WireFormat mls_key_package (00 05).
    const bytes = base64ToBytes(event.content);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x01, 0x00, 0x01]);
  });

  it("decodes MLSMessage-framed content (White Noise / darkmatter compat)", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    // Simulate a peer (White Noise / darkmatter reference engine) that wraps the
    // KeyPackage in an MLSMessage with wire_format mls_key_package. getKeyPackage
    // must transparently unwrap it. See docs/upstream-issues/keypackage-mlsmessage-framing.md.
    const framedBytes = encode(mlsMessageEncoder, {
      version: keyPackage.publicPackage.version,
      wireformat: wireformats.mls_key_package,
      keyPackage: keyPackage.publicPackage,
    });
    expect(Array.from(framedBytes.subarray(0, 4))).toEqual([
      0x00, 0x01, 0x00, 0x05,
    ]);

    const event: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      pubkey: validPubkey,
      created_at: unixNow(),
      content: bytesToBase64(framedBytes),
      tags: [["d", testD]],
      id: "framed-id",
      sig: "framed-sig",
    };

    const decoded = getKeyPackage(event);
    expect(decoded.leafNode.credential).toEqual(credential);
  });

  it("rejects a KeyPackage event whose content is not valid base64", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    // Legacy hex body is no longer interpreted as hex; it is decoded as base64
    // and rejected. (hex alphabet has odd byte boundaries → base64 error)
    const encodedBytes = encode(keyPackageEncoder, keyPackage.publicPackage);
    const hexEvent: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      pubkey: validPubkey,
      created_at: unixNow(),
      content: bytesToHex(encodedBytes),
      tags: [
        ["mls_protocol_version", "1.0"],
        ["mls_ciphersuite", "0x0001"],
        ["mls_extensions", "0x000a"],
        ["relays", "wss://relay.example.com"],
      ],
      id: "hex-event-id",
      sig: "hex-signature",
    };

    expect(() => getKeyPackage(hexEvent)).toThrow();
  });
});

describe("MLSMessage-framing compat (temporary upstream hack)", () => {
  // A real kind-30443 KeyPackage event captured from White Noise on
  // wss://relay.us.whitenoise.chat/. Author pubkey
  // 3cee7c372372c11f9c62d7e839da08969b9f5178ae5b6acc715bc12c066c37e6
  // (npub18nh8cderwtq3l8rz6l5rnksgj6de75tc4edk4nr3t0qjcpnvxlnqwmu2sv).
  // Its content is an MLSMessage(wire_format = mls_key_package), not a bare
  // KeyPackage. See docs/upstream-issues/keypackage-mlsmessage-framing.md.
  const whiteNoiseEvent: NostrEvent = {
    kind: ADDRESSABLE_KEY_PACKAGE_KIND,
    pubkey: "3cee7c372372c11f9c62d7e839da08969b9f5178ae5b6acc715bc12c066c37e6",
    id: "7cbc3bd30b97931d2d2f3986bec9d2de0a80cacfde664a26fdd81e5dcf17f27d",
    sig: "real-sig",
    created_at: 1_700_000_000,
    content:
      "AAEABQABAAEgTHnrxFCrCgLhhnlrD65dq44jCBpkm4eiJ278n1bs0w0gt+ugqj8/dRo4iv5pmOvtZ/PwI7/F+8Gjyf63EQeBOXsgcakmWm315Txj2Fk8bHjWV+ctYt9qTjNh2pqCq5YEIjQAASA87nw3I3LBH5xi1+g52giWm59ReK5basxxW8EsBmw35gIAAQIAAQ4AAwAKAAby0fLS8tTy8QQACgAIAgABAQAAAABqMVG+AAAAAGqgHc5AnQAGDw4AAQsKgAGAA4AEgAaACPLxQIcBAAEIBzzufDcjcsEfnGLX6DnaCJabn1F4rltqzHFbwSwGbDfmACBxqSZabfXlPGPYWTxseNZX5y1i32pOM2HamoKrlgQiNGhsDn/w891Gb+KLEdMcujd3LDGW3N3na/Png77u2pqFVDOPpWqm9PL1Fkram8jeaurMfJz/Dx+kqqVOMckSRBFAQFNfm0uWq1/QfLSTQpeeLGU51lutQYR8BftgWAP6F1IFaK18us9T3nJF0P0v+JMy/oDOV2PcxnlktdnWX+kGvAEDAAoAQEDYt2I7buPfWVDJRBlRx8aWBSOuEOeyHmziM6nxj91xESWhEuYR89JzbB8bufXjcArSJKRdxxY/G/yhFn4gHqUM",
    tags: [["mls_ciphersuite", "0x0001"]],
  };

  it("the content is MLSMessage-framed, not a bare KeyPackage", () => {
    const bytes = base64ToBytes(whiteNoiseEvent.content);
    // 00 01 (ProtocolVersion mls10) 00 05 (WireFormat mls_key_package)
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x01, 0x00, 0x05]);
  });

  it("a bare KeyPackage decode of the same bytes fails (the original bug)", () => {
    const bytes = base64ToBytes(whiteNoiseEvent.content);
    // This is exactly what getKeyPackage used to do — it desyncs on the 4-byte
    // MLSMessage header and throws "8-byte length not supported".
    expect(() => decode(keyPackageDecoder, bytes)).toThrow();
  });

  it("getKeyPackage unwraps the MLSMessage frame and decodes it", () => {
    const keyPackage = getKeyPackage(whiteNoiseEvent);
    expect(keyPackage).toBeDefined();
    expect(keyPackage.cipherSuite).toBe(0x0001);
  });

  it("the unwrapped credential carries the event author's nostr pubkey", () => {
    expect(getKeyPackageNostrPubkey(whiteNoiseEvent)).toBe(
      whiteNoiseEvent.pubkey,
    );
  });
});

describe("getKeyPackageIdentifier", () => {
  it("should return the d tag value for a kind 30443 event", () => {
    const event: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      id: "testid",
      pubkey: mockPubkey,
      created_at: 0,
      content: "",
      tags: [["d", mockD]],
      sig: mockSig,
    };
    expect(getKeyPackageIdentifier(event)).toBe(mockD);
  });

  it("should return undefined for a non-30443 event", () => {
    const event: NostrEvent = {
      kind: 1,
      id: "testid",
      pubkey: mockPubkey,
      created_at: 0,
      content: "",
      tags: [["d", mockD]],
      sig: mockSig,
    };
    expect(getKeyPackageIdentifier(event)).toBeUndefined();
  });

  it("should return undefined when event has no d tag at all", () => {
    const event: NostrEvent = {
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      id: "testid",
      pubkey: mockPubkey,
      created_at: 0,
      content: "",
      tags: [["i", "somehex"]],
      sig: mockSig,
    };
    expect(getKeyPackageIdentifier(event)).toBeUndefined();
  });
});

describe("spec compliance (MIP-00)", () => {
  const validPubkey =
    "884704bd421671e01c13f854d2ce23ce2a5bfe9562f4f297ad2bc921ba30c3a6";
  const testD =
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  it("should include an `i` tag with hex KeyPackageRef when publishing kind 30443", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    const iTag = event.tags.find((t) => t[0] === "i");
    expect(iTag).toBeDefined();
    expect(iTag?.[1]).toMatch(/^[0-9a-f]+$/);
  });

  it("emits the spec-required mls_proposals and app_components tags", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    // transports/nostr.md "KeyPackage publication": MUST carry mls_extensions,
    // mls_proposals, and app_components. Rust rejects empty proposals/components.
    for (const tag of ["mls_extensions", "mls_proposals", "app_components"]) {
      const found = event.tags.find((t) => t[0] === tag);
      expect(found, `${tag} tag must be present`).toBeDefined();
      expect(found!.length, `${tag} tag must be non-empty`).toBeGreaterThan(1);
    }
  });

  it("does not emit a (spec-forbidden) encoding tag", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: testD,
    });

    expect(event.tags.some((t) => t[0] === "encoding")).toBe(false);
  });
});
