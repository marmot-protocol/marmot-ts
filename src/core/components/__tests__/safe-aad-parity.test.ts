import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  appDataDictionaryExtensionType,
  defaultCryptoProvider,
  getAppDataDictionary,
  getCiphersuiteImpl,
  makeAppDataDictionaryExtension,
  type GroupContextExtension,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import fixtureJson from "../../../__tests__/fixtures/safe-aad-rust.json";
import { createCredential } from "../../credential.js";
import { defaultCapabilities } from "../../default-capabilities.js";
import { generateKeyPackage } from "../../key-package.js";
import { isGreaseValue } from "../../grease.js";
import {
  componentEntry,
  getAppComponents,
  getComponentData,
  makeAppComponentsExtension,
} from "../dictionary.js";
import { SAFE_AAD_COMPONENT_ID } from "../ids.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

type SafeAadFixture = {
  mdk_sha: string;
  source: string;
  extraction: "Engine::fresh_key_package -> KeyPackage::bytes -> MlsMessageIn -> LeafNode";
  dictionary_hex: string;
  dictionary_sha256: string;
  dictionary_projection: string;
  safe_aad_hex: string;
  advertised_app_components: number[];
  capabilities: {
    advertised_extensions: number[];
    effective_extensions: number[];
    advertised_proposals: number[];
    effective_proposals: number[];
  };
};

const fixture = fixtureJson as SafeAadFixture;

describe("MDK SafeAAD parity", () => {
  it("matches the dictionary extracted from a genuine MDK KeyPackage", async () => {
    expect(fixture.mdk_sha).toBe("dbf45c83a8e157302edd13010944ad2c6a9cf9a5");
    expect(fixture.source).toContain("CgkaEngine::fresh_key_package");
    expect(fixture.extraction).toContain("KeyPackage::bytes");

    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(5);
    const keyPackage = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      ciphersuiteImpl,
      signer: account.signer,
    });
    const extension = keyPackage.publicPackage.leafNode.extensions.find(
      (candidate) => candidate.extensionType === appDataDictionaryExtensionType,
    );
    expect(extension).toBeDefined();
    const safeAad = getComponentData(
      keyPackage.publicPackage.leafNode.extensions as GroupContextExtension[],
      SAFE_AAD_COMPONENT_ID,
    )!;
    const stableProjection = makeAppDataDictionaryExtension([
      componentEntry(SAFE_AAD_COMPONENT_ID, safeAad),
    ]);
    expect(fixture.dictionary_projection).toContain("SafeAAD entry only");
    expect(bytesToHex(stableProjection.extensionData)).toBe(
      fixture.dictionary_hex,
    );
    const typescriptComponents = getAppComponents(
      keyPackage.publicPackage.leafNode.extensions as GroupContextExtension[],
    )!;
    for (const commonComponent of [0x0001, 0x8001, 0x8003, 0x800c]) {
      expect(fixture.advertised_app_components).toContain(commonComponent);
      expect(typescriptComponents).toContain(commonComponent);
    }
    expect(bytesToHex(safeAad)).toBe(fixture.safe_aad_hex);
  });

  it("keeps RFC defaults implicit in signed advertisements", () => {
    const capabilities = defaultCapabilities();
    const advertisedExtensions = capabilities.extensions.filter(
      (value) => !isGreaseValue(value),
    );
    const advertisedProposals = capabilities.proposals.filter(
      (value) => !isGreaseValue(value),
    );
    expect(advertisedExtensions).toContain(6);
    for (const implicit of [1, 2, 3, 4, 5])
      expect(advertisedExtensions).not.toContain(implicit);
    expect(advertisedProposals).toContain(8);
    for (const implicit of [1, 2, 3, 4, 5, 6, 7])
      expect(advertisedProposals).not.toContain(implicit);
    expect(fixture.capabilities.advertised_extensions).toEqual([6]);
    expect(fixture.capabilities.advertised_proposals).toEqual([8]);
    expect(fixture.capabilities.effective_extensions).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(fixture.capabilities.effective_proposals).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("rejects SafeAAD as GroupContext state", () => {
    expect(() =>
      makeAppComponentsExtension([
        componentEntry(SAFE_AAD_COMPONENT_ID, hexToBytes(fixture.safe_aad_hex)),
      ]),
    ).toThrow(/SafeAAD.*LeafNode/i);
  });

  it("detects a one-byte dictionary mutation", () => {
    const encoded = hexToBytes(fixture.dictionary_hex);
    encoded[0] += 1;
    const mutated = {
      extensionType: appDataDictionaryExtensionType,
      extensionData: encoded,
    } as GroupContextExtension;
    expect(() => getAppDataDictionary([mutated])).toThrow();
    expect(bytesToHex(encoded)).not.toBe(fixture.dictionary_hex);
  });
});
