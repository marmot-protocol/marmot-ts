import { describe, it, expect } from "vitest";
import { createCredential, getCredentialPubkey } from "../core/credential.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { CredentialBasic, CredentialX509 } from "ts-mls/credential.js";
import { defaultCredentialTypes } from "ts-mls";
import { marmotAuthService } from "../core/auth-service.js";

const validPubkey =
  "1a9281606d737cf7b3c09ccdaefc47cb2af39c12d8528d54c747b8bd9e34a346";
const anotherValidPubkey =
  "26095f2b8dc8aa5c049848933af79155464921da76f4fdefc4a5a439a2ef6dce";

describe("createCredential", () => {
  it("should create a basic credential from a valid hex public key", () => {
    const credential = createCredential(validPubkey);

    expect(credential).toBeDefined();
    expect(credential.credentialType).toBe(defaultCredentialTypes.basic);
    expect(credential.identity).toBeInstanceOf(Uint8Array);
    expect(credential.identity).toEqual(hexToBytes(validPubkey));
  });

  it("should create credentials for different public keys", () => {
    const credential1 = createCredential(validPubkey);
    const credential2 = createCredential(anotherValidPubkey);

    expect(credential1.identity).not.toEqual(credential2.identity);
  });

  it("should reject invalid hex strings (wrong length)", () => {
    expect(() => createCredential("abc123")).toThrow(
      "Invalid nostr public key, must be 64 hex characters",
    );
    expect(() =>
      createCredential("1a9281606d737cf7b3c09ccdaefc47cb2af39c12"),
    ).toThrow("Invalid nostr public key, must be 64 hex characters");
  });

  it("should reject non-hex strings", () => {
    expect(() =>
      createCredential(
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ),
    ).toThrow("Invalid nostr public key, must be 64 hex characters");
    expect(() =>
      createCredential(
        "1a9281606d737cf7b3c09ccdaefc47cb2af39c12d8528d54c747b8bd9e34a34g",
      ),
    ).toThrow("Invalid nostr public key, must be 64 hex characters");
  });

  it("should reject empty strings", () => {
    expect(() => createCredential("")).toThrow(
      "Invalid nostr public key, must be 64 hex characters",
    );
  });

  it("should handle uppercase hex characters", () => {
    const uppercasePubkey =
      "1A9281606D737CF7B3C09CCDAEFC47CB2AF39C12D8528D54C747B8BD9E34A346";
    const credential = createCredential(uppercasePubkey);

    expect(credential.credentialType).toBe(defaultCredentialTypes.basic);
    expect(credential.identity).toEqual(hexToBytes(uppercasePubkey));
  });

  it("should handle mixed case hex characters", () => {
    const mixedCasePubkey =
      "1a9281606D737CF7b3c09CCDAEFC47cb2AF39c12D8528D54c747B8BD9e34A346";
    const credential = createCredential(mixedCasePubkey);

    expect(credential.credentialType).toBe(defaultCredentialTypes.basic);
    expect(credential.identity).toEqual(hexToBytes(mixedCasePubkey));
  });

  it("should reject strings with special characters", () => {
    expect(() =>
      createCredential(
        "1a9281606d737cf7b3c09ccdaefc47cb2af39c12d8528d54c747b8bd9e34a34!",
      ),
    ).toThrow("Invalid nostr public key, must be 64 hex characters");
  });

  it("should reject strings with spaces", () => {
    expect(() =>
      createCredential(
        "1a9281606d737cf7 b3c09ccdaefc47cb2af39c12d8528d54c747b8bd9e34a346",
      ),
    ).toThrow("Invalid nostr public key, must be 64 hex characters");
  });
});

describe("getCredentialPubkey", () => {
  it("should extract the public key from a valid credential", () => {
    const credential = createCredential(validPubkey);
    const extractedPubkey = getCredentialPubkey(credential);

    expect(extractedPubkey).toBe(validPubkey);
  });

  it("should extract the public key from different credentials", () => {
    const credential1 = createCredential(validPubkey);
    const credential2 = createCredential(anotherValidPubkey);

    expect(getCredentialPubkey(credential1)).toBe(validPubkey);
    expect(getCredentialPubkey(credential2)).toBe(anotherValidPubkey);
  });

  it("should handle uppercase hex in credentials", () => {
    const uppercasePubkey =
      "1A9281606D737CF7B3C09CCDAEFC47CB2AF39C12D8528D54C747B8BD9E34A346";
    const credential = createCredential(uppercasePubkey);
    const extractedPubkey = getCredentialPubkey(credential);

    // Note: bytesToHex returns lowercase, so we compare lowercase
    expect(extractedPubkey.toLowerCase()).toBe(uppercasePubkey.toLowerCase());
  });

  it("should reject non-basic credentials", () => {
    const nonBasicCredential: CredentialBasic = {
      credentialType: "x509" as any,
      identity: hexToBytes(validPubkey),
    };

    expect(() => getCredentialPubkey(nonBasicCredential)).toThrow(
      "Credential is not a basic credential, cannot get nostr public key",
    );
  });

  it("should reject invalid legacy credentials with non-hex UTF-8", () => {
    const textEncoder = new TextEncoder();
    const invalidLegacyCredential: CredentialBasic = {
      credentialType: defaultCredentialTypes.basic,
      identity: textEncoder.encode("not-a-valid-hex-string-at-all-really-not"),
    };

    expect(() => getCredentialPubkey(invalidLegacyCredential)).toThrow(
      "Invalid credential nostr public key",
    );
  });

  it("should reject credentials with invalid identity data", () => {
    const invalidCredential: CredentialBasic = {
      credentialType: defaultCredentialTypes.basic,
      identity: new Uint8Array([1, 2, 3]), // Too short and not valid hex
    };

    expect(() => getCredentialPubkey(invalidCredential)).toThrow(
      "Invalid credential nostr public key",
    );
  });

  it("should roundtrip: create credential and extract same pubkey", () => {
    const originalPubkey = validPubkey;
    const credential = createCredential(originalPubkey);
    const extractedPubkey = getCredentialPubkey(credential);

    expect(extractedPubkey).toBe(originalPubkey);
  });

  it("should roundtrip with multiple different pubkeys", () => {
    const pubkeys = [
      "1a9281606d737cf7b3c09ccdaefc47cb2af39c12d8528d54c747b8bd9e34a346",
      "26095f2b8dc8aa5c049848933af79155464921da76f4fdefc4a5a439a2ef6dce",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ];

    pubkeys.forEach((pubkey) => {
      const credential = createCredential(pubkey);
      const extracted = getCredentialPubkey(credential);
      expect(extracted).toBe(pubkey);
    });
  });
});

describe("credential integration", () => {
  it("should support create -> extract -> recreate cycle", () => {
    const credential1 = createCredential(validPubkey);
    const extractedPubkey = getCredentialPubkey(credential1);
    const credential2 = createCredential(extractedPubkey);

    expect(credential1.identity).toEqual(credential2.identity);
    expect(credential1.credentialType).toBe(credential2.credentialType);
  });

  it("should maintain credential equality for same pubkey", () => {
    const credential1 = createCredential(validPubkey);
    const credential2 = createCredential(validPubkey);

    expect(credential1.identity).toEqual(credential2.identity);
    expect(credential1.credentialType).toBe(credential2.credentialType);
  });

  it("marmotAuthService accepts valid MIP-00 basic credentials", async () => {
    const credential = createCredential(validPubkey);
    await expect(
      marmotAuthService.validateCredential(credential, new Uint8Array(32)),
    ).resolves.toBe(true);
  });

  it("marmotAuthService rejects non-basic credentials", async () => {
    const nonBasicCredential: CredentialX509 = {
      credentialType: defaultCredentialTypes.x509,
      certificates: [],
    };

    await expect(
      marmotAuthService.validateCredential(
        nonBasicCredential as any,
        new Uint8Array(32),
      ),
    ).resolves.toBe(false);
  });

  it("marmotAuthService rejects basic credentials with wrong identity length", async () => {
    const bad: CredentialBasic = {
      credentialType: defaultCredentialTypes.basic,
      identity: new Uint8Array(31),
    };

    await expect(
      marmotAuthService.validateCredential(bad, new Uint8Array(32)),
    ).resolves.toBe(false);
  });
});
