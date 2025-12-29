import { describe, expect, it } from "vitest";
import {
  CiphersuiteName,
  ciphersuites,
  createGroup,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import {
  createMarmotGroupData,
  decodeMarmotGroupData,
  encodeMarmotGroupData,
  isAdmin,
  marmotGroupDataToExtension,
} from "../core/marmot-group-data.js";
import { MarmotGroupData } from "../core/protocol.js";
import { generateKeyPackage } from "../core/key-package.js";

describe("encodeMarmotGroupData and decodeMarmotGroupData", () => {
  it("should encode and decode group data correctly", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32).fill(1),
      name: "Test Group",
      description: "A test group for unit tests",
      adminPubkeys: ["a".repeat(64), "b".repeat(64)],
      relays: ["wss://relay1.example.com", "wss://relay2.example.com"],
      imageHash: new Uint8Array(32).fill(2),
      imageKey: new Uint8Array(32).fill(3),
      imageNonce: new Uint8Array(12).fill(4),
    };

    const encoded = encodeMarmotGroupData(groupData);
    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.version).toBe(groupData.version);
    expect(decoded.nostrGroupId).toEqual(groupData.nostrGroupId);
    expect(decoded.name).toBe(groupData.name);
    expect(decoded.description).toBe(groupData.description);
    expect(decoded.adminPubkeys).toEqual(groupData.adminPubkeys);
    expect(decoded.relays).toEqual(groupData.relays);
    expect(decoded.imageHash).toEqual(groupData.imageHash);
    expect(decoded.imageKey).toEqual(groupData.imageKey);
    expect(decoded.imageNonce).toEqual(groupData.imageNonce);
  });

  it("should handle empty arrays correctly", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: [],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    const encoded = encodeMarmotGroupData(groupData);
    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.adminPubkeys).toEqual([]);
    expect(decoded.relays).toEqual([]);
  });

  it("should handle UTF-8 strings correctly", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "Test 🚀 Group",
      description: "Description with émojis and spëcial çharacters",
      adminPubkeys: [],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    const encoded = encodeMarmotGroupData(groupData);
    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.name).toBe(groupData.name);
    expect(decoded.description).toBe(groupData.description);
  });

  it("should handle null image fields correctly", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32).fill(5),
      name: "Group with null images",
      description: "Testing null image fields",
      adminPubkeys: ["a".repeat(64)],
      relays: ["wss://relay.example.com"],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    const encoded = encodeMarmotGroupData(groupData);
    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.imageHash).toBeNull();
    expect(decoded.imageKey).toBeNull();
    expect(decoded.imageNonce).toBeNull();
  });

  it("should reject invalid image field lengths", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: [],
      relays: [],
      imageHash: new Uint8Array(16), // Wrong size!
      imageKey: null,
      imageNonce: null,
    };

    expect(() => encodeMarmotGroupData(groupData)).toThrow(
      /image_hash must be null or exactly 32 bytes/,
    );
  });
});

describe("createMarmotGroupData", () => {
  it("should create group data with default values", () => {
    const encoded = createMarmotGroupData();
    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.version).toBe(1);
    expect(decoded.nostrGroupId.length).toBe(32);
    expect(decoded.name).toBe("");
    expect(decoded.description).toBe("");
    expect(decoded.adminPubkeys).toEqual([]);
    expect(decoded.relays).toEqual([]);
  });

  it("should create group data with custom values", () => {
    const customGroupId = new Uint8Array(32).fill(5);
    const encoded = createMarmotGroupData({
      nostrGroupId: customGroupId,
      name: "My Group",
      description: "My Description",
      adminPubkeys: ["a".repeat(64)],
      relays: ["wss://relay.example.com"],
    });

    const decoded = decodeMarmotGroupData(encoded);

    expect(decoded.nostrGroupId).toEqual(customGroupId);
    expect(decoded.name).toBe("My Group");
    expect(decoded.description).toBe("My Description");
    expect(decoded.adminPubkeys).toEqual(["a".repeat(64)]);
    expect(decoded.relays).toEqual(["wss://relay.example.com/"]);
  });
});

describe("validation", () => {
  it("should reject invalid admin public keys", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: ["invalid"],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    expect(() => encodeMarmotGroupData(groupData)).toThrow(
      /Invalid admin public key format/,
    );
  });

  it("should reject invalid relay URLs", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: [],
      relays: ["http://not-a-websocket.com"],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    expect(() => encodeMarmotGroupData(groupData)).toThrow(/Invalid relay URL/);
  });

  it("should reject wrong-sized fields", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(16), // Wrong size!
      name: "",
      description: "",
      adminPubkeys: [],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    expect(() => encodeMarmotGroupData(groupData)).toThrow(
      /nostr_group_id must be exactly 32 bytes/,
    );
  });

  it("should reject truncated extension data", () => {
    const validData = createMarmotGroupData();
    const truncated = validData.slice(0, 40); // Less than minimum 48 bytes

    expect(() => decodeMarmotGroupData(truncated)).toThrow(
      /Extension data too short/,
    );
  });
});

describe("isAdmin", () => {
  it("should return true for authorized admin", () => {
    const adminKey = "a".repeat(64);
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: [adminKey],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    expect(isAdmin(groupData, adminKey)).toBe(true);
    expect(isAdmin(groupData, adminKey.toUpperCase())).toBe(true); // Case insensitive
  });

  it("should return false for unauthorized admin", () => {
    const groupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32),
      name: "",
      description: "",
      adminPubkeys: ["a".repeat(64)],
      relays: [],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    expect(isAdmin(groupData, "b".repeat(64))).toBe(false);
  });
});

describe("serialization with byteOffset handling", () => {
  it("should correctly decode extension data from a real MLS group", async () => {
    // Use the first available ciphersuite
    const cipherSuite = Object.keys(ciphersuites)[0] as CiphersuiteName;
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite));

    // Create a valid nostr credential (64 hex chars)
    const alicePubkey = "a".repeat(64);
    const aliceCredential = {
      credentialType: "basic" as const,
      identity: new TextEncoder().encode(alicePubkey),
    };

    // Use marmot-ts generateKeyPackage which ensures MIP-00 compliance
    const alice = await generateKeyPackage({
      credential: aliceCredential,
      ciphersuiteImpl: impl,
    });

    const groupId = new TextEncoder().encode("test-group-byteoffset");

    // Create Marmot group data
    const marmotGroupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32).fill(42),
      name: "Test Group with Real MLS",
      description: "Testing byteOffset handling with real ClientState",
      adminPubkeys: [alicePubkey],
      relays: ["wss://relay.example.com"],
      imageHash: null,
      imageKey: null,
      imageNonce: null,
    };

    // Create the Marmot extension
    const marmotExtension = marmotGroupDataToExtension(marmotGroupData);

    // Create group with Marmot extension
    const clientState = await createGroup(
      groupId,
      alice.publicPackage,
      alice.privatePackage,
      [marmotExtension],
      impl,
    );

    // Extract the Marmot extension from the created group
    const originalExtension = clientState.groupContext.extensions.find(
      (ext) =>
        typeof ext.extensionType === "number" && ext.extensionType === 0xf2ee,
    );

    if (!originalExtension) {
      throw new Error("Marmot extension not found in group");
    }

    // Decode the extension data - this should work regardless of byteOffset
    const decoded = decodeMarmotGroupData(originalExtension.extensionData);

    // Verify all fields match
    expect(decoded.version).toBe(marmotGroupData.version);
    expect(decoded.nostrGroupId).toEqual(marmotGroupData.nostrGroupId);
    expect(decoded.name).toBe(marmotGroupData.name);
    expect(decoded.description).toBe(marmotGroupData.description);
    expect(decoded.adminPubkeys).toEqual(marmotGroupData.adminPubkeys);
    expect(decoded.relays).toEqual(marmotGroupData.relays);
    expect(decoded.imageHash).toBeNull();
    expect(decoded.imageKey).toBeNull();
    expect(decoded.imageNonce).toBeNull();
  });

  it("should correctly decode extension data after encodeGroupState/decodeGroupState round-trip", async () => {
    // Import encodeGroupState and decodeGroupState
    const { encodeGroupState, decodeGroupState } =
      await import("ts-mls/clientState.js");

    // Use the first available ciphersuite
    const cipherSuite = Object.keys(ciphersuites)[0] as CiphersuiteName;
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite));

    // Create a valid nostr credential (64 hex chars)
    const alicePubkey = "b".repeat(64);
    const aliceCredential = {
      credentialType: "basic" as const,
      identity: new TextEncoder().encode(alicePubkey),
    };

    // Use marmot-ts generateKeyPackage which ensures MIP-00 compliance
    const alice = await generateKeyPackage({
      credential: aliceCredential,
      ciphersuiteImpl: impl,
    });

    const groupId = new TextEncoder().encode("test-group-serialization");

    // Create Marmot group data with long strings to test variable-length fields
    const marmotGroupData: MarmotGroupData = {
      version: 1,
      nostrGroupId: new Uint8Array(32).fill(1),
      name: "Very Long Group Name That Tests Variable Length Field Encoding with Serialization",
      description:
        "A very long description that ensures we properly handle variable-length fields when they span multiple bytes after binary serialization round-trip",
      adminPubkeys: [alicePubkey, "c".repeat(64), "d".repeat(64)],
      relays: [
        "wss://relay1.example.com",
        "wss://relay2.example.com",
        "wss://relay3.example.com",
      ],
      imageHash: new Uint8Array(32).fill(2),
      imageKey: new Uint8Array(32).fill(3),
      imageNonce: new Uint8Array(12).fill(4),
    };

    // Create the Marmot extension
    const marmotExtension = marmotGroupDataToExtension(marmotGroupData);

    // Create group with Marmot extension
    const originalState = await createGroup(
      groupId,
      alice.publicPackage,
      alice.privatePackage,
      [marmotExtension],
      impl,
    );

    // Serialize the entire ClientState using ts-mls binary serialization
    const serialized = encodeGroupState(originalState);

    // Deserialize the ClientState
    const deserializedResult = decodeGroupState(serialized, 0);
    if (!deserializedResult) {
      throw new Error("Failed to deserialize ClientState");
    }
    const [deserializedState, _bytesRead] = deserializedResult;

    // Extract the Marmot extension from the deserialized group
    const deserializedExtension =
      deserializedState.groupContext.extensions.find(
        (ext) =>
          typeof ext.extensionType === "number" && ext.extensionType === 0xf2ee,
      );

    if (!deserializedExtension) {
      throw new Error("Marmot extension not found in deserialized group");
    }

    // The extension data should have a non-zero byteOffset after deserialization
    expect(deserializedExtension.extensionData.byteOffset).toBeGreaterThan(0);

    // Decode the extension data - this is the critical test for byteOffset handling
    const decoded = decodeMarmotGroupData(deserializedExtension.extensionData);

    // Verify all fields match
    expect(decoded.version).toBe(marmotGroupData.version);
    expect(decoded.nostrGroupId).toEqual(marmotGroupData.nostrGroupId);
    expect(decoded.name).toBe(marmotGroupData.name);
    expect(decoded.description).toBe(marmotGroupData.description);
    expect(decoded.adminPubkeys).toEqual(marmotGroupData.adminPubkeys);
    expect(decoded.relays).toEqual(marmotGroupData.relays);
    expect(decoded.imageHash).toEqual(marmotGroupData.imageHash);
    expect(decoded.imageKey).toEqual(marmotGroupData.imageKey);
    expect(decoded.imageNonce).toEqual(marmotGroupData.imageNonce);
  });
});
