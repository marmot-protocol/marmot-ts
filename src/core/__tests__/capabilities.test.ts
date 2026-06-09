import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  Capabilities,
  ciphersuites,
  defaultCredentialTypes,
  protocolVersions,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  ensureMarmotCapabilities,
  LAST_RESORT_EXTENSION_TYPE,
} from "../index.js";

describe("ensureMarmotCapabilities", () => {
  it("should advertise the app_data_dictionary extension and last_resort", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [1, 2, 3],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(result.extensions).toContain(appDataDictionaryExtensionType);
    expect(result.extensions).toContain(LAST_RESORT_EXTENSION_TYPE);
    expect(result.extensions).toContain(1);
    expect(result.extensions).toContain(2);
    expect(result.extensions).toContain(3);
  });

  it("should advertise the app_data_update proposal type", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(result.proposals).toContain(appDataUpdateProposalType);
  });

  it("should not duplicate code points if already present", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [1, 2, appDataDictionaryExtensionType, 3],
      proposals: [appDataUpdateProposalType],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(
      result.extensions.filter((e) => e === appDataDictionaryExtensionType),
    ).toHaveLength(1);
    expect(
      result.proposals.filter((p) => p === appDataUpdateProposalType),
    ).toHaveLength(1);
  });

  it("should preserve all other capability fields", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [
        ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
        ciphersuites.MLS_128_DHKEMP256_AES128GCM_SHA256_P256,
        ciphersuites.MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519,
      ],
      extensions: [1, 2],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(result.versions).toEqual(capabilities.versions);
    expect(result.ciphersuites).toEqual(capabilities.ciphersuites);
    expect(result.credentials).toEqual(capabilities.credentials);
  });

  it("should work with empty extensions array", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(result.extensions).toEqual([
      appDataDictionaryExtensionType,
      LAST_RESORT_EXTENSION_TYPE,
      ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    ]);
    expect(result.proposals).toEqual([appDataUpdateProposalType]);
  });
});
