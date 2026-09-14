import { unixNow } from "applesauce-core/helpers";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import {
  Capabilities,
  ciphersuites,
  CustomExtension,
  defaultCredentialTypes,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  makeKeyPackageRef,
  makeCustomExtension,
  protocolVersions,
} from "ts-mls";
import { afterEach, describe, expect, it, vi } from "vitest";

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import { createCredential } from "../credential.js";
import { calculateKeyPackageRef, generateKeyPackage } from "../key-package.js";
import { appDataDictionaryExtensionType } from "ts-mls";
import {
  decodeAuthorizationProof,
  AuthorizationProofError,
} from "../authorization-proof.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "../components/ids.js";
import {
  getAppComponents,
  getComponentData,
} from "../components/dictionary.js";
import { validateKeyPackageAccountIdentityProof } from "../components/account-identity-proof.js";
import { LAST_RESORT_EXTENSION_TYPE } from "../protocol.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";

// The legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`, `../account-identity-proof.js`). Referenced here only as a
// literal to assert its absence (CUT-01) -- this test file imports nothing
// from the legacy module.
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

const ZERO_AUX = new Uint8Array(32);

/** Signs `draft` with `secretKey`, mirroring a real external Nostr signer. */
function signWith(secretKey: Uint8Array, draft: UnsignedEvent) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const unsigned: UnsignedEvent = { ...draft, pubkey };
  const id = getEventHash(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, ZERO_AUX));
  return { ...unsigned, id, sig };
}

describe("generateKeyPackage", () => {
  const VALID_ACCOUNT = testAccount(5);
  const validPubkey = VALID_ACCOUNT.pubkey;
  const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("0x8009 leaf proof (PROOF-03, D-15)", () => {
    it("carries exactly one app_data_dictionary extension with a verifiable 0x8009 proof and no legacy extension", async () => {
      const account = testAccount(6);
      const credential = createCredential(account.pubkey);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        SUITE,
        defaultCryptoProvider,
      );

      const keyPackage = await generateKeyPackage({
        credential,
        ciphersuiteImpl,
        signer: account.signer,
      });

      const leaf = keyPackage.publicPackage.leafNode;
      expect(leaf.extensions).toHaveLength(1);
      expect(leaf.extensions[0]!.extensionType).toBe(
        appDataDictionaryExtensionType,
      );
      expect(
        leaf.extensions.some(
          (e) =>
            e.extensionType === LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
        ),
      ).toBe(false);

      const advertised = getAppComponents(
        leaf.extensions as Parameters<typeof getAppComponents>[0],
      );
      expect(advertised).toBeDefined();
      expect(advertised).toContain(APP_COMPONENTS_COMPONENT_ID);
      expect(advertised).toContain(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID);
      expect(
        advertised!.filter((id) => id === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID),
      ).toHaveLength(1);

      const proofBytes = getComponentData(
        leaf.extensions as Parameters<typeof getComponentData>[0],
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      );
      expect(proofBytes).toBeDefined();
      expect(proofBytes).toHaveLength(104);
      expect(
        bytesToHex(decodeAuthorizationProof(proofBytes!).signerPubkey),
      ).toBe(account.pubkey);

      expect(
        getComponentData(
          leaf.extensions as Parameters<typeof getComponentData>[0],
          SAFE_AAD_COMPONENT_ID,
        ),
      ).toEqual(new Uint8Array([0]));

      expect(leaf.capabilities?.extensions).not.toContain(
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      );

      expect(() =>
        validateKeyPackageAccountIdentityProof(keyPackage.publicPackage),
      ).not.toThrow();
      expect(() =>
        validateKeyPackageAccountIdentityProof(
          keyPackage.publicPackage,
          ciphersuiteImpl.id,
        ),
      ).not.toThrow();
    });

    it("validates a KeyPackage generated with an external-style signer (PROOF-03)", async () => {
      const secretKey = new Uint8Array(32);
      secretKey[31] = 21;
      const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
      const credential = createCredential(pubkey);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        SUITE,
        defaultCryptoProvider,
      );
      const externalSigner = {
        signEvent: async (draft: UnsignedEvent) => signWith(secretKey, draft),
      };

      const keyPackage = await generateKeyPackage({
        credential,
        ciphersuiteImpl,
        signer: externalSigner,
      });

      expect(() =>
        validateKeyPackageAccountIdentityProof(
          keyPackage.publicPackage,
          ciphersuiteImpl.id,
        ),
      ).not.toThrow();
    });

    it("uses an explicit createdAt for the proof (core-only, D-03)", async () => {
      const ciphersuiteImpl = await getCiphersuiteImpl(
        SUITE,
        defaultCryptoProvider,
      );
      const keyPackage = await generateKeyPackage({
        credential: createCredential(validPubkey),
        ciphersuiteImpl,
        signer: VALID_ACCOUNT.signer,
        createdAt: 1700000000,
      });
      const proofBytes = getComponentData(
        keyPackage.publicPackage.leafNode.extensions as Parameters<
          typeof getComponentData
        >[0],
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      )!;
      expect(decodeAuthorizationProof(proofBytes).createdAt).toBe(1700000000);
    });

    it("defaults createdAt to the current wall-clock time when omitted (D-03)", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1700000123456);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        SUITE,
        defaultCryptoProvider,
      );
      const keyPackage = await generateKeyPackage({
        credential: createCredential(validPubkey),
        ciphersuiteImpl,
        signer: VALID_ACCOUNT.signer,
      });
      const proofBytes = getComponentData(
        keyPackage.publicPackage.leafNode.extensions as Parameters<
          typeof getComponentData
        >[0],
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      )!;
      expect(decodeAuthorizationProof(proofBytes).createdAt).toBe(1700000123);
    });

    it("rejects a signer whose returned pubkey differs from the credential (returned-pubkey-mismatch)", async () => {
      const otherSecretKey = new Uint8Array(32);
      otherSecretKey[31] = 99;
      const wrongKeySigner = {
        signEvent: async (draft: UnsignedEvent) =>
          signWith(otherSecretKey, draft),
      };
      const ciphersuiteImpl = await getCiphersuiteImpl(
        SUITE,
        defaultCryptoProvider,
      );

      let reason: unknown;
      try {
        await generateKeyPackage({
          credential: createCredential(validPubkey),
          ciphersuiteImpl,
          signer: wrongKeySigner,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AuthorizationProofError);
        reason = (err as AuthorizationProofError).reason;
      }
      expect(reason).toBe("returned-pubkey-mismatch");
    });
  });

  it("should generate a valid key package with default capabilities", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signer: VALID_ACCOUNT.signer,
    });

    expect(keyPackage).toBeDefined();
    expect(keyPackage.publicPackage).toBeDefined();
    expect(keyPackage.privatePackage).toBeDefined();
    expect(keyPackage.publicPackage.leafNode.credential).toEqual(credential);
    expect(keyPackage.publicPackage.extensions).toHaveLength(1);
    // The LeafNode carries a single app_data_dictionary extension holding
    // both the app_components advertisement and the 0x8009 proof (D-15).
    expect(keyPackage.publicPackage.leafNode.extensions).toHaveLength(1);
    expect(keyPackage.publicPackage.leafNode.extensions[0].extensionType).toBe(
      appDataDictionaryExtensionType,
    );
  });

  it("should include Marmot Group Data Extension in capabilities", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signer: VALID_ACCOUNT.signer,
    });

    const capabilities =
      keyPackage.publicPackage.leafNode.capabilities?.extensions;
    expect(capabilities).toBeDefined();
    expect(capabilities).toContain(appDataDictionaryExtensionType);
  });

  it("should include last_resort extension by default", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signer: VALID_ACCOUNT.signer,
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
      SUITE,
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      isLastResort: false,
      signer: VALID_ACCOUNT.signer,
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
      SUITE,
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
      signer: VALID_ACCOUNT.signer,
    });

    const capabilities =
      keyPackage.publicPackage.leafNode.capabilities?.extensions;
    expect(capabilities).toBeDefined();
    // Should include both custom extensions and Marmot extension
    expect(capabilities).toContain(1);
    expect(capabilities).toContain(2);
    expect(capabilities).toContain(appDataDictionaryExtensionType);
  });

  it("should accept custom extensions and still ensure last_resort extension", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
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
      signer: VALID_ACCOUNT.signer,
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
      SUITE,
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
      signer: VALID_ACCOUNT.signer,
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
      SUITE,
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
      signer: VALID_ACCOUNT.signer,
    });

    expect(keyPackage.publicPackage.leafNode.lifetime).toEqual(customLifetime);
  });

  it("should reject an explicit lifetime override that exceeds the 84-day cap (D-08/D-09)", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );
    const now = BigInt(unixNow());

    await expect(
      generateKeyPackage({
        credential,
        ciphersuiteImpl,
        lifetime: { notBefore: now, notAfter: now + 7261201n },
        signer: VALID_ACCOUNT.signer,
      }),
    ).rejects.toThrow();
  });

  it("should accept an explicit at-cap lifetime override (7261200n)", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );
    const now = BigInt(unixNow());
    const lifetime = { notBefore: now, notAfter: now + 7261200n };

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      lifetime,
      signer: VALID_ACCOUNT.signer,
    });

    expect(keyPackage.publicPackage.leafNode.lifetime).toEqual(lifetime);
  });

  it("should throw error for non-basic credential", async () => {
    const invalidCredential = {
      credentialType: "x509" as any,
      identity: new Uint8Array(32),
    };

    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );

    await expect(
      generateKeyPackage({
        credential: invalidCredential,
        ciphersuiteImpl,
        signer: VALID_ACCOUNT.signer,
      }),
    ).rejects.toThrow("Marmot key packages must use a basic credential");
  });

  it("should calculate key package refs with the upstream helper", async () => {
    const credential = createCredential(validPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signer: VALID_ACCOUNT.signer,
    });

    await expect(
      calculateKeyPackageRef(keyPackage.publicPackage, defaultCryptoProvider),
    ).resolves.toEqual(
      await makeKeyPackageRef(keyPackage.publicPackage, ciphersuiteImpl.hash),
    );
  });
});
