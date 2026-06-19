import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  defaultCredentialTypes,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  signAccountIdentityProof,
  verifyLeafAccountIdentityProof,
} from "../account-identity-proof.js";
import { AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE } from "../components/agent-text-stream.js";
import { getAppComponents } from "../components/dictionary.js";
import {
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../components/ids.js";

/**
 * Interop contract: a KeyPackage marmot-ts publishes (as the examples/opentui
 * app does — with an account proof signer) MUST satisfy every capability the
 * darkmatter Rust engine requires of an invitee when adding it to a default
 * marmot-app group, or `do_send_invite` rejects it with
 * `MissingRequiredCapabilities` / `InvalidAccountIdentityProof`.
 *
 * The required set below mirrors the Rust side:
 * - baseline ext/prop: crates/cgka-engine/src/capabilities.rs
 *   (`required_capabilities_extension`): app_data_dictionary (0x0006) +
 *   account-identity-proof (0xf2f1); app_data_update (0x0008) + self_remove
 *   (0x000a, the Required `self-remove` feature).
 * - required app components: crates/marmot-app/src/client/mod.rs:167-176 plus
 *   `default_group_components()` → {0x8001, 0x8003, 0x8004, 0x8006, 0x8008}.
 * - required role capability: crates/traits/src/agent_text_stream.rs
 *   `user_to_agent_default()` sets `required_member_roles = receive`, folded in
 *   at crates/cgka-engine/src/message_processor/send.rs:89-107 → ext 0xf2d1.
 *
 * If darkmatter fixes the over-requiring tracked in
 * marmot-protocol/darkmatter#481 (it forces 0x8006 onto every group), the
 * 0xf2d1 row here becomes optional for plain chat groups — but advertising it
 * stays harmless and keeps compatibility with current releases.
 */
const DARKMATTER_REQUIRED_LEAF_EXTENSIONS = [
  appDataDictionaryExtensionType, // 0x0006
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE, // 0xf2f1
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE, // 0xf2d1 (required_member_roles = receive)
];

const DARKMATTER_REQUIRED_PROPOSALS = [
  appDataUpdateProposalType, // 0x0008
  selfRemoveProposalType, // 0x000a
];

const DARKMATTER_REQUIRED_APP_COMPONENTS = [
  GROUP_PROFILE_COMPONENT_ID, // 0x8001
  GROUP_ADMIN_POLICY_COMPONENT_ID, // 0x8003
  NOSTR_ROUTING_COMPONENT_ID, // 0x8004
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, // 0x8006
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, // 0x8008
];

describe("darkmatter invite compatibility", () => {
  async function generateOpenTuiStyleKeyPackage() {
    // Mirror the examples/opentui flow: default ciphersuite/capabilities plus an
    // account proof signer so the leaf carries the 0xf2f1 proof.
    const secretKey = new Uint8Array(32).fill(3);
    secretKey[31] = 9;
    const accountPubkey = bytesToHex(schnorr.getPublicKey(secretKey));
    const credential = createCredential(accountPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      accountProofSigner: (request) =>
        signAccountIdentityProof(request, secretKey),
    });
    return { keyPackage, ciphersuiteImpl };
  }

  it("advertises every leaf capability darkmatter requires of an invitee", async () => {
    const { keyPackage } = await generateOpenTuiStyleKeyPackage();
    const capabilities = keyPackage.publicPackage.leafNode.capabilities;

    for (const ext of DARKMATTER_REQUIRED_LEAF_EXTENSIONS)
      expect(capabilities?.extensions).toContain(ext);
    for (const prop of DARKMATTER_REQUIRED_PROPOSALS)
      expect(capabilities?.proposals).toContain(prop);
  });

  it("advertises every app component darkmatter's default group requires", async () => {
    const { keyPackage } = await generateOpenTuiStyleKeyPackage();
    // The leaf carries the app_components advertisement inside its
    // app_data_dictionary extension; darkmatter reads it the same way.
    const advertised = getAppComponents(
      keyPackage.publicPackage.leafNode.extensions as Parameters<
        typeof getAppComponents
      >[0],
    );
    expect(advertised).toBeDefined();
    for (const component of DARKMATTER_REQUIRED_APP_COMPONENTS)
      expect(advertised).toContain(component);
  });

  it("carries a verifiable account identity proof bound to the leaf", async () => {
    const { keyPackage, ciphersuiteImpl } =
      await generateOpenTuiStyleKeyPackage();
    const leaf = keyPackage.publicPackage.leafNode;

    // Proof extension present on the leaf (darkmatter rejects its absence).
    expect(
      leaf.extensions.some(
        (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ),
    ).toBe(true);
    // And it verifies against the leaf signature key (BIP-340 over the same
    // digest the Rust verifier reconstructs).
    expect(() =>
      verifyLeafAccountIdentityProof(leaf, ciphersuiteImpl.id),
    ).not.toThrow();

    // Basic credential with a 32-byte x-only identity, as darkmatter requires.
    // The leaf stores the numeric MLS credential-type code (basic = 1).
    expect(leaf.credential.credentialType).toBe(defaultCredentialTypes.basic);
    expect(leaf.credential.identity).toHaveLength(32);
  });
});
