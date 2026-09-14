import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  defaultCredentialTypes,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { validateKeyPackageAccountIdentityProof } from "../components/account-identity-proof.js";
import { AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE } from "../components/agent-text-stream.js";
import { getAppComponents } from "../components/dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../components/ids.js";

/**
 * Interop contract: a KeyPackage marmot-ts publishes (as the examples/opentui
 * app does) MUST satisfy every capability the darkmatter Rust engine requires
 * of an invitee when adding it to a default marmot-app (current-profile)
 * group, or `do_send_invite` rejects it with `MissingRequiredCapabilities` /
 * `InvalidAccountIdentityProof`.
 *
 * The required set below mirrors the Rust side (current profile,
 * `refs/mdk/crates/cgka-engine/src/app_components.rs`):
 * - `CURRENT_PROFILE_REQUIRED_GROUP_CONTEXT_EXTENSIONS` = `[0x0006]` (no
 *   `0xf2f1` requirement) plus the agent-text-stream-QUIC `receive` role
 *   capability (`0xf2d1`, `crates/traits/src/agent_text_stream.rs`
 *   `user_to_agent_default()`, folded in at
 *   `crates/cgka-engine/src/message_processor/send.rs:89-107`).
 * - `CURRENT_PROFILE_REQUIRED_PROPOSALS` = `[0x0008]` plus `self_remove`
 *   (`0x000a`, the Required `self-remove` feature,
 *   `crates/cgka-engine/src/capabilities.rs`).
 * - `CURRENT_PROFILE_REQUIRED_APP_COMPONENTS` = `{0x8003, 0x8009}`, folded
 *   into `default_group_components()` → `{0x8001, 0x8003, 0x8004, 0x8006,
 *   0x8008, 0x8009}` (`crates/marmot-app/src/client/mod.rs:167-176`).
 *
 * If darkmatter fixes the over-requiring tracked in
 * marmot-protocol/darkmatter#481 (it forces 0x8006 onto every group), the
 * 0xf2d1 row here becomes optional for plain chat groups — but advertising it
 * stays harmless and keeps compatibility with current releases.
 */
const DARKMATTER_REQUIRED_LEAF_EXTENSIONS = [
  appDataDictionaryExtensionType, // 0x0006
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
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, // 0x8009
];

// The legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`, `../account-identity-proof.js`). Referenced here only as a
// literal to assert its absence (CUT-01) -- this test file imports nothing
// from the legacy module.
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

describe("darkmatter invite compatibility", () => {
  async function generateOpenTuiStyleKeyPackage() {
    // Mirror the examples/opentui flow: default ciphersuite/capabilities and a
    // real Nostr account signer, so the leaf carries the 0x8009 proof.
    const secretKey = new Uint8Array(32).fill(3);
    secretKey[31] = 9;
    const account = PrivateKeyAccount.fromKey(secretKey);
    const accountPubkey = account.pubkey;
    const credential = createCredential(accountPubkey);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signer: account.signer,
    });
    return { keyPackage, ciphersuiteImpl };
  }

  it("advertises every leaf capability darkmatter requires of an invitee, and never the legacy 0xf2f1 extension", async () => {
    const { keyPackage } = await generateOpenTuiStyleKeyPackage();
    const capabilities = keyPackage.publicPackage.leafNode.capabilities;

    for (const ext of DARKMATTER_REQUIRED_LEAF_EXTENSIONS)
      expect(capabilities?.extensions).toContain(ext);
    for (const prop of DARKMATTER_REQUIRED_PROPOSALS)
      expect(capabilities?.proposals).toContain(prop);
    expect(capabilities?.extensions).not.toContain(
      LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    );
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

  it("carries a verifiable 0x8009 account identity proof bound to the leaf", async () => {
    const { keyPackage, ciphersuiteImpl } =
      await generateOpenTuiStyleKeyPackage();
    const leaf = keyPackage.publicPackage.leafNode;

    // No legacy 0xf2f1 extension present on the leaf (darkmatter's current
    // profile does not require it, and CUT-01 forbids emitting it).
    expect(
      leaf.extensions.some(
        (e) => e.extensionType === LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ),
    ).toBe(false);
    // And the KeyPackage's 0x8009 proof validates end to end (structure,
    // support-list membership, SafeAAD placement, and BIP-340 signature).
    expect(() =>
      validateKeyPackageAccountIdentityProof(
        keyPackage.publicPackage,
        ciphersuiteImpl.id,
      ),
    ).not.toThrow();

    // Basic credential with a 32-byte x-only identity, as darkmatter requires.
    // The leaf stores the numeric MLS credential-type code (basic = 1).
    expect(leaf.credential.credentialType).toBe(defaultCredentialTypes.basic);
    expect(leaf.credential.identity).toHaveLength(32);
  });
});
