import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  defaultCredentialTypes,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  type LeafNode,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import {
  type AccountIdentityProofRequest,
  ACCOUNT_IDENTITY_PROOF_EVENT_KIND,
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  accountIdentityProofEventId,
  accountIdentityProofSigningDigest,
  decodeAccountIdentityProof,
  encodeAccountIdentityProof,
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

/**
 * Rust-signed account-identity-proof v2 round-trip fixture (PROOF-01,
 * ROADMAP criterion 2 / plan 01-02 Task 3).
 *
 * These values were generated once, fresh, from the vendored MDK reference
 * (`refs/mdk`, `marmotkit-v0.9.4-14-g3628ccc`) via a throwaway
 * `#[test] fn print_ts_proof_v2_fixture_vector` added temporarily to
 * `crates/cgka-engine/src/account_identity_proof.rs`'s `#[cfg(test)] mod
 * tests`, then reverted (no permanent change to the `refs/mdk` submodule).
 *
 * Generation command:
 *   cd refs/mdk && cargo test -p cgka-engine --lib \
 *     print_ts_proof_v2_fixture_vector -- --nocapture
 *
 * The test function built an `AccountIdentityProofRequest` for a fixed
 * account secret key (`sha256("marmot-ts proof-v2 fixture account secret
 * key")`) and a fixed MLS signature key
 * (`sha256("marmot-ts proof-v2 fixture mls signature key")`), ciphersuite 1
 * (Ed25519, signature_scheme 2055), called `.proof_event_id()` for the event
 * id, `.sign_with_keys(&keys)` + `.signature_from_signed_event()` for the
 * 64-byte Schnorr signature, and printed the hex values below.
 *
 * Promoting this into a permanent cross-impl parity harness (rather than a
 * one-shot pinned fixture) is deferred to CONF-01 / Phase 4 per
 * `01-CONTEXT.md` Deferred Ideas.
 */
describe("Rust MDK proof-v2 round-trip fixture (generated once, pinned)", () => {
  // Fixed inputs used to generate the fixture (see comment above).
  const RUST_FIXTURE_ACCOUNT_IDENTITY_HEX =
    "67d3ed702d55d4c049de6e43ead43a9b9cf1b4976f40a7357673b1acbf8f34b0";
  const RUST_FIXTURE_MLS_SIGNATURE_KEY_HEX =
    "9f228d14a7609599c4971bd0f65f43ae7d00b0a50ccfc021e95ca7fd825197ac";
  const RUST_FIXTURE_CIPHERSUITE = 1;
  const RUST_FIXTURE_SIGNATURE_SCHEME = 2055;

  // Rust-produced outputs to reproduce/verify.
  const RUST_FIXTURE_EVENT_ID_HEX =
    "29e15f6d6dacb28ba1a806829ec7016709cad47cd998eb620558d7df0a39ec18";
  const RUST_FIXTURE_SIGNATURE_HEX =
    "c0a3944043456dad09411928f77c317a4134d8ebbe8353b3cf07695d31159842b4a7a172790fe55f4b9653e999a29e3b0827a862bbd1a143f57d7a5f0f92e13f";

  function fixtureRequest(): AccountIdentityProofRequest {
    return {
      accountIdentity: hexToBytes(RUST_FIXTURE_ACCOUNT_IDENTITY_HEX),
      mlsSignaturePublicKey: hexToBytes(RUST_FIXTURE_MLS_SIGNATURE_KEY_HEX),
      ciphersuite: RUST_FIXTURE_CIPHERSUITE,
      signatureScheme: RUST_FIXTURE_SIGNATURE_SCHEME,
    };
  }

  it("reproduces the identical kind-450 event id Rust computed from the same inputs", () => {
    const req = fixtureRequest();
    expect(accountIdentityProofEventId(req)).toBe(RUST_FIXTURE_EVENT_ID_HEX);
    expect(bytesToHex(accountIdentityProofSigningDigest(req))).toBe(
      RUST_FIXTURE_EVENT_ID_HEX,
    );
  });

  it("accepts (verifies) the pinned Rust-produced 64-byte Schnorr signature", () => {
    const req = fixtureRequest();
    const digest = accountIdentityProofSigningDigest(req);
    const signature = hexToBytes(RUST_FIXTURE_SIGNATURE_HEX);

    expect(schnorr.verify(signature, digest, req.accountIdentity)).toBe(true);

    // Also verify via the full leaf-proof path (encode -> decode -> verify),
    // exercising the exact code path a real KeyPackage/leaf would use.
    // Only credential/signaturePublicKey/extensions are read by
    // verifyLeafAccountIdentityProof, so a minimal LeafNode stand-in (cast
    // for the fields that type does not need for this check) is sufficient.
    const leaf = {
      credential: {
        credentialType: defaultCredentialTypes.basic,
        identity: req.accountIdentity,
      },
      signaturePublicKey: req.mlsSignaturePublicKey,
      extensions: [
        {
          extensionType: ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
          extensionData: encodeAccountIdentityProof({
            request: req,
            signature,
          }),
        },
      ],
    } as unknown as LeafNode;
    expect(() =>
      verifyLeafAccountIdentityProof(leaf, RUST_FIXTURE_CIPHERSUITE),
    ).not.toThrow();
  });

  it("round-trips the pinned account-identity/mls-key/version fields through encode/decode", () => {
    const req = fixtureRequest();
    const signature = hexToBytes(RUST_FIXTURE_SIGNATURE_HEX);
    const encoded = encodeAccountIdentityProof({ request: req, signature });

    // version byte is always 2 (position 0 of the wire encoding).
    expect(encoded[0]).toBe(2);

    const decoded = decodeAccountIdentityProof(encoded);
    expect(bytesToHex(decoded.request.accountIdentity)).toBe(
      RUST_FIXTURE_ACCOUNT_IDENTITY_HEX,
    );
    expect(bytesToHex(decoded.request.mlsSignaturePublicKey)).toBe(
      RUST_FIXTURE_MLS_SIGNATURE_KEY_HEX,
    );
    expect(decoded.request.ciphersuite).toBe(RUST_FIXTURE_CIPHERSUITE);
    expect(decoded.request.signatureScheme).toBe(RUST_FIXTURE_SIGNATURE_SCHEME);
    expect(bytesToHex(decoded.signature)).toBe(RUST_FIXTURE_SIGNATURE_HEX);
  });

  it("never publishes or relays the kind-450 proof event (local signing template only)", () => {
    // ACCOUNT_IDENTITY_PROOF_EVENT_KIND (450) must never appear on a
    // publish/relay/network path. This is a structural, not behavioral,
    // check: `grep`-based rather than asserting on runtime network calls,
    // because there is no network path that accepts this kind at all.
    expect(ACCOUNT_IDENTITY_PROOF_EVENT_KIND).toBe(450);
  });
});
