import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  Capabilities,
  ciphersuites,
  defaultCredentialTypes,
  defaultExtensionTypes,
  protocolVersions,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import {
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  ensureMarmotCapabilities,
  LAST_RESORT_EXTENSION_TYPE,
  marmotRequiredCapabilitiesExtension,
} from "../index.js";

// The legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`, `../account-identity-proof.js`). Referenced here only as a
// literal to assert its absence (CUT-01) -- this test file imports nothing
// from the legacy module.
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

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

  it("should advertise only the agent-text-stream-QUIC receive role (0xf2d1)", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    // `receive` is honest for a non-QUIC client (it reads the final MLS message)
    // and is what darkmatter's default group requires. `send`/`fanout` would
    // claim a QUIC data plane marmot-ts does not have, so they are NOT advertised.
    expect(result.extensions).toContain(
      AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
    );
    expect(result.extensions).not.toContain(
      AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
    );
    expect(result.extensions).not.toContain(
      AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
    );
  });

  it("should advertise the app_data_update and self_remove proposal types", () => {
    const capabilities: Capabilities = {
      versions: [protocolVersions.mls10],
      ciphersuites: [ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519],
      extensions: [],
      proposals: [],
      credentials: [defaultCredentialTypes.basic],
    };

    const result = ensureMarmotCapabilities(capabilities);

    expect(result.proposals).toContain(appDataUpdateProposalType);
    expect(result.proposals).toContain(selfRemoveProposalType);
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

  it("should work with empty extensions array and never advertise the legacy 0xf2f1 extension", () => {
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
      AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
    ]);
    expect(result.extensions).not.toContain(
      LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    );
    expect(result.proposals).toEqual([
      appDataUpdateProposalType,
      selfRemoveProposalType,
    ]);
  });
});

describe("marmotRequiredCapabilitiesExtension", () => {
  it("declares the fixed Marmot baseline (0x0006 only), sorted ascending to match the Rust BTreeSet, and never requires the legacy 0xf2f1 extension", () => {
    const ext = marmotRequiredCapabilitiesExtension();

    expect(ext.extensionType).toBe(defaultExtensionTypes.required_capabilities);
    expect(ext.extensionData.extensionTypes).toEqual([
      appDataDictionaryExtensionType,
    ]);
    expect(ext.extensionData.extensionTypes).not.toContain(
      LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    );
    // app_data_update (0x0008) before self_remove (0x000a).
    expect(ext.extensionData.proposalTypes).toEqual([
      appDataUpdateProposalType,
      selfRemoveProposalType,
    ]);
    expect(ext.extensionData.credentialTypes).toEqual([]);
  });
});
