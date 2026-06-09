/**
 * Tests for the Marmot account identity proof LeafNode extension
 * (`marmot.account-identity-proof.v1`, 0xF2F1), byte-matched to the darkmatter
 * `account_identity_proof.rs` canonical message + wire layout.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type { LeafNode } from "ts-mls";
import { createCredential } from "../credential.js";
import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  type AccountIdentityProofRequest,
  accountIdentityProofSigningDigest,
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

describe("account identity proof — signing digest", () => {
  it("uses Ed25519 (0x0807) for ciphersuite 1", () => {
    expect(mlsSignatureScheme(1)).toBe(0x0807);
  });

  it("matches the canonical message layout from the Rust reference", () => {
    const req = request();
    const domain = new TextEncoder().encode("marmot.account-identity-proof.v1");
    // Reconstruct canonical_message() independently.
    const parts: number[] = [];
    parts.push(...domain, 0x00);
    parts.push(0xf2, 0xf1); // ext type 0xF2F1 BE
    parts.push(0x01); // version
    parts.push(0x00, 0x01); // ciphersuite 1 BE
    parts.push(0x08, 0x07); // signature scheme Ed25519 BE
    parts.push(0x00, 0x20, ...accountIdentity); // u16 len + identity
    parts.push(0x00, 0x20, ...mlsSignaturePublicKey); // u16 len + mls key
    const expected = sha256(new Uint8Array(parts));
    expect(bytesToHex(accountIdentityProofSigningDigest(req))).toBe(
      bytesToHex(expected),
    );
  });
});

describe("account identity proof — sign / verify", () => {
  it("produces a BIP-340 signature that verifies over the digest", () => {
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

  it("encodes to the fixed wire length (1+2+2+32+2+32+64)", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    expect(
      encodeAccountIdentityProof({ request: req, signature }),
    ).toHaveLength(135);
  });

  it("rejects trailing bytes on decode", () => {
    const req = request();
    const signature = signAccountIdentityProof(req, secretKey);
    const encoded = encodeAccountIdentityProof({ request: req, signature });
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expect(() => decodeAccountIdentityProof(padded)).toThrow();
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
