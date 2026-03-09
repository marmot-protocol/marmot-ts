import { unixNow } from "applesauce-core/helpers";
import {
  CustomExtension,
  defaultCredentialTypes,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  makeCustomExtension,
} from "ts-mls";
import { Capabilities } from "ts-mls/capabilities.js";
import { ciphersuites } from "ts-mls/crypto/ciphersuite.js";
import { protocolVersions } from "ts-mls/protocolVersion.js";
import { describe, expect, it } from "vitest";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import {
  LAST_RESORT_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
} from "../protocol.js";

describe("generateKeyPackage", () => {
  const validPubkey =
    "884704bd421671e01c13f854d2ce23ce2a5bfe9562f4f297ad2bc921ba30c3a6";

  it("should generate a valid key package with default capabilities", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    expect(keyPackage).toBeDefined();
    expect(keyPackage.publicPackage).toBeDefined();
    expect(keyPackage.privatePackage).toBeDefined();
    expect(keyPackage.publicPackage.leafNode.credential).toEqual(credential);
    expect(keyPackage.publicPackage.extensions).toHaveLength(1);
    expect(keyPackage.publicPackage.leafNode.extensions).toHaveLength(0);
  });

  it("should include Marmot Group Data Extension in capabilities", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const capabilities =
      keyPackage.publicPackage.leafNode.capabilities?.extensions;
    expect(capabilities).toBeDefined();
    expect(capabilities).toContain(MARMOT_GROUP_DATA_EXTENSION_TYPE);
  });

  it("should include last_resort extension by default", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const hasLastResort = keyPackage.publicPackage.extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    );

    expect(hasLastResort).toBe(true);
  });

  it("should omit last_resort extension when isLastResort=false", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      isLastResort: false,
    });

    const hasLastResort = keyPackage.publicPackage.extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    );

    expect(hasLastResort).toBe(false);
  });

  it("should accept custom capabilities and still ensure Marmot capabilities", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const customCapabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [1, 2], // Without Marmot extension
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const keyPackage = await generateKeyPackage({
      credential,
      capabilities: customCapabilities,
      ciphersuiteImpl,
    });

    const capabilities =
      keyPackage.publicPackage.leafNode.capabilities?.extensions;
    expect(capabilities).toBeDefined();
    // Should include both custom extensions and Marmot extension
    expect(capabilities).toContain(1);
    expect(capabilities).toContain(2);
    expect(capabilities).toContain(MARMOT_GROUP_DATA_EXTENSION_TYPE);
  });

  it("should accept custom extensions and still ensure last_resort extension", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const customExtensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: 0x1234,
        extensionData: new Uint8Array([1, 2, 3]),
      }),
    ];

    const keyPackage = await generateKeyPackage({
      credential,
      extensions: customExtensions,
      ciphersuiteImpl,
    });

    const extensions = keyPackage.publicPackage.extensions;

    // Should have both custom extension and last_resort
    const hasCustom = extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" && ext.extensionType === 0x1234,
    );
    const hasLastResort = extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    );

    expect(hasCustom).toBe(true);
    expect(hasLastResort).toBe(true);
  });

  it("should accept custom extensions and omit last_resort when isLastResort=false", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const customExtensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: 0x1234,
        extensionData: new Uint8Array([1, 2, 3]),
      }),
    ];

    const keyPackage = await generateKeyPackage({
      credential,
      extensions: customExtensions,
      isLastResort: false,
      ciphersuiteImpl,
    });

    const extensions = keyPackage.publicPackage.extensions;

    const hasCustom = extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" && ext.extensionType === 0x1234,
    );
    const hasLastResort = extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    );

    expect(hasCustom).toBe(true);
    expect(hasLastResort).toBe(false);
  });

  it("should accept custom lifetime", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const customLifetime = {
      notBefore: BigInt(unixNow()),
      notAfter: BigInt(unixNow() + 3600), // 1 hour
    };

    const keyPackage = await generateKeyPackage({
      credential,
      lifetime: customLifetime,
      ciphersuiteImpl,
    });

    expect(keyPackage.publicPackage.leafNode.lifetime).toEqual(customLifetime);
  });

  it("should throw error for non-basic credential", async () => {
    const invalidCredential = {
      credentialType: "x509" as any,
      identity: new Uint8Array(32),
    };

    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    await expect(
      generateKeyPackage({
        credential: invalidCredential,
        ciphersuiteImpl,
      }),
    ).rejects.toThrow("Marmot key packages must use a basic credential");
  });
});
