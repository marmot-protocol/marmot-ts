/**
 * Tests for the Marmot account identity proof LeafNode extension
 * (`marmot.account-identity-proof.v2`, 0xF2F1), byte-matched to the darkmatter
 * `account_identity_proof.rs` kind-450 event construction + wire layout.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getEventHash } from "applesauce-core/helpers/event";
import { describe, expect, it } from "vitest";

import type { LeafNode } from "ts-mls";
import { createCredential } from "../credential.js";
import {
  ACCOUNT_IDENTITY_PROOF_EVENT_KIND,
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  type AccountIdentityProofRequest,
  accountIdentityProofEventId,
  accountIdentityProofSignatureFromSignedEvent,
  accountIdentityProofSigningDigest,
  buildAccountIdentityProofEvent,
  decodeAccountIdentityProof,
  encodeAccountIdentityProof,
  makeAccountIdentityProofExtension,
  mlsSignatureScheme,
  signAccountIdentityProof,
  verifyLeafAccountIdentityProof,
} from "../account-identity-proof.js";

const secretKey = new Uint8Array(32).fill(1);
secretKey[31] = 7; // a valid, deterministic secp256k1 scalar
const accountIdentity = schnorr.getPublicKey(secretKey); // 32-byte x-only
const mlsSignaturePublicKey = new Uint8Array(32).fill(0xab);

function request(): AccountIdentityProofRequest {
  return {
    accountIdentity,
    mlsSignaturePublicKey,
    ciphersuite: 1,
    signatureScheme: mlsSignatureScheme(1),
  };
}

describe("account identity proof — v2 signing digest (kind-450 event id)", () => {
  it("uses Ed25519 (0x0807 = 2055) for ciphersuite 1", () => {
    expect(mlsSignatureScheme(1)).toBe(0x0807);
    expect(String(mlsSignatureScheme(1))).toBe("2055");
  });

  it("independently rebuilds the canonical kind-450 event id (six tags, exact order) and matches accountIdentityProofSigningDigest", () => {
    const req = request();
    // Reconstruct the canonical unsigned kind-450 event independently of
    // buildAccountIdentityProofEvent, mirroring Rust proof_event()'s tag order.
    const expectedEvent = {
      pubkey: bytesToHex(accountIdentity),
      created_at: 0,
      kind: ACCOUNT_IDENTITY_PROOF_EVENT_KIND,
      content: "",
      tags: [
        ["d", "marmot.account-identity-proof.v2"],
        ["extension", "0xf2f1"],
        ["version", "2"],
        ["ciphersuite", "1"],
        ["signature_scheme", "2055"],
        ["mls_signature_key", bytesToHex(mlsSignaturePublicKey)],
      ],
    };
    const expectedId = getEventHash(expectedEvent);
    expect(accountIdentityProofEventId(req)).toBe(expectedId);
    expect(bytesToHex(accountIdentityProofSigningDigest(req))).toBe(expectedId);
  });

  it("buildAccountIdentityProofEvent produces the same canonical event used by the digest", () => {
    const req = request();
    const event = buildAccountIdentityProofEvent(req);
    expect(event.kind).toBe(450);
    expect(event.created_at).toBe(0);
    expect(event.content).toBe("");
    expect(event.pubkey).toBe(bytesToHex(accountIdentity));
    expect(event.tags).toEqual([
      ["d", "marmot.account-identity-proof.v2"],
      ["extension", "0xf2f1"],
      ["version", "2"],
      ["ciphersuite", "1"],
      ["signature_scheme", "2055"],
      ["mls_signature_key", bytesToHex(mlsSignaturePublicKey)],
    ]);
    expect(getEventHash(event)).toBe(accountIdentityProofEventId(req));
  });
});

describe("account identity proof — sign / verify", () => {
  it("produces a BIP-340 signature that verifies over the kind-450 event id digest", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    expect(signature).toHaveLength(64);
    expect(
      schnorr.verify(
        signature,
        accountIdentityProofSigningDigest(req),
        accountIdentity,
      ),
    ).toBe(true);
  });
});

describe("account identity proof — codec", () => {
  it("round-trips through encode/decode", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    const decoded = decodeAccountIdentityProof(
      encodeAccountIdentityProof({ request: req, signature }),
    );
    expect(decoded.request).toEqual(req);
    expect(bytesToHex(decoded.signature)).toBe(bytesToHex(signature));
  });

  it("encodes to the fixed wire length (1+2+2+32+2+32+64) with version byte 2", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    const encoded = encodeAccountIdentityProof({ request: req, signature });
    expect(encoded).toHaveLength(135);
    expect(encoded[0]).toBe(2);
  });

  it("rejects trailing bytes on decode", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    const encoded = encodeAccountIdentityProof({ request: req, signature });
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expect(() => decodeAccountIdentityProof(padded)).toThrow();
  });

  it("rejects a version-byte-1 (v1) proof", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    const encoded = encodeAccountIdentityProof({ request: req, signature });
    const v1Encoded = new Uint8Array(encoded);
    v1Encoded[0] = 1; // the old v1 version byte
    expect(() => decodeAccountIdentityProof(v1Encoded)).toThrow(
      /unsupported proof version/,
    );
  });
});

describe("account identity proof — leaf verification", () => {
  function leafWithProof(): LeafNode {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    return {
      credential: createCredential(bytesToHex(accountIdentity)),
      signaturePublicKey: mlsSignaturePublicKey,
      extensions: [
        makeAccountIdentityProofExtension({ request: req, signature }),
      ],
    } as unknown as LeafNode;
  }

  it("verifies a well-formed leaf proof", () => {
    expect(() =>
      verifyLeafAccountIdentityProof(leafWithProof(), 1),
    ).not.toThrow();
  });

  it("rejects a leaf missing the proof extension", () => {
    const leaf = {
      credential: createCredential(bytesToHex(accountIdentity)),
      signaturePublicKey: mlsSignaturePublicKey,
      extensions: [],
    } as unknown as LeafNode;
    expect(() => verifyLeafAccountIdentityProof(leaf, 1)).toThrow(/missing/);
  });

  it("rejects when the leaf signature key does not match the proof", () => {
    const leaf = leafWithProof();
    (leaf as { signaturePublicKey: Uint8Array }).signaturePublicKey =
      new Uint8Array(32).fill(0xcd);
    expect(() => verifyLeafAccountIdentityProof(leaf, 1)).toThrow(
      /signature key/,
    );
  });

  it("rejects a tampered signature", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    signature[0] ^= 0xff;
    const leaf = {
      credential: createCredential(bytesToHex(accountIdentity)),
      signaturePublicKey: mlsSignaturePublicKey,
      extensions: [
        makeAccountIdentityProofExtension({ request: req, signature }),
      ],
    } as unknown as LeafNode;
    expect(() => verifyLeafAccountIdentityProof(leaf, 1)).toThrow(/verify/);
  });

  it("exposes the spec extension type", () => {
    expect(ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE).toBe(0xf2f1);
  });
});

describe("account identity proof — external-signer path (proof_event)", () => {
  it("signs the canonical unsigned kind-450 event via a raw schnorr signer and extracts a verifying 64-byte signature", () => {
    const req = request();
    const unsignedEvent = buildAccountIdentityProofEvent(req);
    const id = getEventHash(unsignedEvent);

    // Simulate an external Nostr signer (NIP-07/NIP-46/hardware): it signs
    // the event id with the account's key and returns the signed event.
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
    const signedEvent = {
      ...unsignedEvent,
      id,
      sig,
    };

    const signature = accountIdentityProofSignatureFromSignedEvent(
      req,
      signedEvent,
    );
    expect(signature).toHaveLength(64);

    const leaf = {
      credential: createCredential(bytesToHex(accountIdentity)),
      signaturePublicKey: mlsSignaturePublicKey,
      extensions: [
        makeAccountIdentityProofExtension({ request: req, signature }),
      ],
    } as unknown as LeafNode;
    expect(() => verifyLeafAccountIdentityProof(leaf, 1)).not.toThrow();
  });

  it("throws when the signed event pubkey does not match the request account identity", () => {
    const req = request();
    const unsignedEvent = buildAccountIdentityProofEvent(req);
    const id = getEventHash(unsignedEvent);
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
    const otherAccountIdentity = new Uint8Array(32).fill(0x11);
    expect(() =>
      accountIdentityProofSignatureFromSignedEvent(req, {
        ...unsignedEvent,
        pubkey: bytesToHex(otherAccountIdentity),
        id,
        sig,
      }),
    ).toThrow(/account identity/);
  });

  it("throws when the signed event id does not match the rebuilt proof-event id", () => {
    const req = request();
    const unsignedEvent = buildAccountIdentityProofEvent(req);
    const otherRequest = {
      ...req,
      mlsSignaturePublicKey: new Uint8Array(32).fill(0xcd),
    };
    const otherId = getEventHash(buildAccountIdentityProofEvent(otherRequest));
    const sig = bytesToHex(schnorr.sign(hexToBytes(otherId), secretKey));
    expect(() =>
      accountIdentityProofSignatureFromSignedEvent(req, {
        ...unsignedEvent,
        id: otherId,
        sig,
      }),
    ).toThrow(/does not match proof request/);
  });
});
