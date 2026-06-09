/** @module @category Core - Account Identity Proof */
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type CustomExtension,
  makeCustomExtension,
  type LeafNode,
} from "ts-mls";

import { BinaryReader, BinaryWriter, encodeUtf8 } from "./binary.js";
import { getCredentialPubkey } from "./credential.js";

/**
 * The Marmot account identity proof, carried as a custom MLS LeafNode extension
 * (`marmot.account-identity-proof.v1`).
 *
 * An MLS BasicCredential names a Marmot (Nostr) account, but the MLS signature
 * key is a separate per-leaf key. This extension binds the two by having the
 * Nostr account key sign — with BIP-340 Schnorr — a digest over the account
 * pubkey and the leaf signature key, so account-scoped policy (e.g. admin
 * authorization) can trust the credential identity.
 *
 * Wire (`encode_proof`, fixed-width, big-endian):
 *   uint8  version;                       // 1
 *   uint16 ciphersuite;
 *   uint16 signature_scheme;
 *   opaque account_identity[32];          // x-only Nostr pubkey, no length prefix
 *   uint16 mls_signature_public_key_len;
 *   opaque mls_signature_public_key[len];
 *   opaque signature[64];                 // BIP-340 Schnorr
 *
 * @see darkmatter `crates/cgka-engine/src/account_identity_proof.rs`
 */
export const ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;
const ACCOUNT_IDENTITY_PROOF_VERSION = 1;
const ACCOUNT_IDENTITY_PROOF_DOMAIN = "marmot.account-identity-proof.v1";
const ACCOUNT_IDENTITY_LEN = 32;
const SCHNORR_SIGNATURE_LEN = 64;

/**
 * MLS signature scheme code points (RFC 9420 / IANA TLS SignatureScheme),
 * keyed by MLS ciphersuite id. Used to record which scheme the leaf signature
 * key uses, matching OpenMLS `ciphersuite.signature_algorithm()`.
 */
const MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE: Record<number, number> = {
  1: 0x0807, // Ed25519
  2: 0x0403, // ecdsa_secp256r1_sha256
  3: 0x0807, // Ed25519
  4: 0x0808, // Ed448
  5: 0x0603, // ecdsa_secp521r1_sha512
  6: 0x0808, // Ed448
  7: 0x0503, // ecdsa_secp384r1_sha384
};

/** Returns the MLS signature scheme code point for a ciphersuite id. */
export function mlsSignatureScheme(ciphersuite: number): number {
  const scheme = MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE[ciphersuite];
  if (scheme === undefined)
    throw new Error(
      `Unknown MLS signature scheme for ciphersuite ${ciphersuite}`,
    );
  return scheme;
}

/** The values a Marmot account key signs to bind an MLS leaf to that account. */
export interface AccountIdentityProofRequest {
  /** The 32-byte x-only Nostr account pubkey (the credential identity). */
  accountIdentity: Uint8Array;
  /** The MLS leaf signature public key. */
  mlsSignaturePublicKey: Uint8Array;
  /** The MLS ciphersuite id. */
  ciphersuite: number;
  /** The MLS signature scheme code point (see {@link mlsSignatureScheme}). */
  signatureScheme: number;
}

/** A decoded account identity proof: the signed request plus its signature. */
export interface AccountIdentityProof {
  request: AccountIdentityProofRequest;
  /** 64-byte BIP-340 Schnorr signature by the account key. */
  signature: Uint8Array;
}

/** A hook that signs the proof digest with the Nostr account key (BIP-340). */
export type AccountIdentityProofSigner = (
  request: AccountIdentityProofRequest,
) => Uint8Array | Promise<Uint8Array>;

function canonicalMessage(request: AccountIdentityProofRequest): Uint8Array {
  return new BinaryWriter()
    .bytes(encodeUtf8(ACCOUNT_IDENTITY_PROOF_DOMAIN))
    .uint8(0)
    .uint16(ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE)
    .uint8(ACCOUNT_IDENTITY_PROOF_VERSION)
    .uint16(request.ciphersuite)
    .uint16(request.signatureScheme)
    .uint16(request.accountIdentity.length)
    .bytes(request.accountIdentity)
    .uint16(request.mlsSignaturePublicKey.length)
    .bytes(request.mlsSignaturePublicKey)
    .build();
}

/** The 32-byte BIP-340 message digest the account key signs. */
export function accountIdentityProofSigningDigest(
  request: AccountIdentityProofRequest,
): Uint8Array {
  return sha256(canonicalMessage(request));
}

/** Signs a proof request with a raw 32-byte Nostr secret key (BIP-340 Schnorr). */
export function signAccountIdentityProof(
  request: AccountIdentityProofRequest,
  secretKey: Uint8Array,
): Uint8Array {
  return schnorr.sign(accountIdentityProofSigningDigest(request), secretKey);
}

/** Encodes an {@link AccountIdentityProof} to its LeafNode extension bytes. */
export function encodeAccountIdentityProof(
  proof: AccountIdentityProof,
): Uint8Array {
  if (proof.request.accountIdentity.length !== ACCOUNT_IDENTITY_LEN)
    throw new Error("account identity must be exactly 32 bytes");
  if (proof.signature.length !== SCHNORR_SIGNATURE_LEN)
    throw new Error("proof signature must be exactly 64 bytes");

  return new BinaryWriter()
    .uint8(ACCOUNT_IDENTITY_PROOF_VERSION)
    .uint16(proof.request.ciphersuite)
    .uint16(proof.request.signatureScheme)
    .bytes(proof.request.accountIdentity)
    .uint16(proof.request.mlsSignaturePublicKey.length)
    .bytes(proof.request.mlsSignaturePublicKey)
    .bytes(proof.signature)
    .build();
}

/** Decodes account identity proof LeafNode extension bytes. */
export function decodeAccountIdentityProof(
  data: Uint8Array,
): AccountIdentityProof {
  const reader = new BinaryReader(data);
  const version = reader.uint8();
  if (version !== ACCOUNT_IDENTITY_PROOF_VERSION)
    throw new Error(`unsupported proof version ${version}`);
  const ciphersuite = reader.uint16();
  const signatureScheme = reader.uint16();
  const accountIdentity = reader.bytes(ACCOUNT_IDENTITY_LEN);
  const keyLen = reader.uint16();
  const mlsSignaturePublicKey = reader.bytes(keyLen);
  const signature = reader.bytes(SCHNORR_SIGNATURE_LEN);
  reader.end();

  return {
    request: {
      accountIdentity,
      mlsSignaturePublicKey,
      ciphersuite,
      signatureScheme,
    },
    signature,
  };
}

/** Builds the `marmot.account-identity-proof.v1` LeafNode extension. */
export function makeAccountIdentityProofExtension(
  proof: AccountIdentityProof,
): CustomExtension {
  return makeCustomExtension({
    extensionType: ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    extensionData: encodeAccountIdentityProof(proof),
  });
}

/**
 * Builds the account identity proof request for a leaf, signs it with the given
 * account signer, and returns the LeafNode extension. The MLS ciphersuite id and
 * leaf signature key are bound into the proof.
 */
export async function buildAccountIdentityProofExtension(params: {
  accountIdentity: Uint8Array;
  mlsSignaturePublicKey: Uint8Array;
  ciphersuite: number;
  signer: AccountIdentityProofSigner;
}): Promise<CustomExtension> {
  const request: AccountIdentityProofRequest = {
    accountIdentity: params.accountIdentity,
    mlsSignaturePublicKey: params.mlsSignaturePublicKey,
    ciphersuite: params.ciphersuite,
    signatureScheme: mlsSignatureScheme(params.ciphersuite),
  };
  const signature = await params.signer(request);
  return makeAccountIdentityProofExtension({ request, signature });
}

/**
 * Verifies a leaf's account identity proof: the embedded account identity and
 * MLS signature key match the leaf, the ciphersuite/scheme match, and the
 * BIP-340 signature verifies under the credential's x-only Nostr pubkey.
 *
 * Throws on any mismatch. Mirrors darkmatter
 * `validate_leaf_account_identity_proof`.
 */
export function verifyLeafAccountIdentityProof(
  leaf: LeafNode,
  ciphersuite: number,
): void {
  const accountIdentity = getCredentialPubkey(leaf.credential); // hex, validated 32-byte
  const accountIdentityBytes = hexToBytes32(accountIdentity);

  const extension = leaf.extensions.find(
    (e): e is CustomExtension =>
      e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  );
  if (!extension)
    throw new Error(
      "missing marmot.account-identity-proof.v1 LeafNode extension",
    );

  const proof = decodeAccountIdentityProof(extension.extensionData);

  if (!bytesEqual(proof.request.accountIdentity, accountIdentityBytes))
    throw new Error(
      "proof account identity does not match credential identity",
    );
  if (!bytesEqual(proof.request.mlsSignaturePublicKey, leaf.signaturePublicKey))
    throw new Error(
      "proof MLS signature key does not match leaf signature key",
    );
  if (proof.request.ciphersuite !== ciphersuite)
    throw new Error("proof ciphersuite does not match expected ciphersuite");
  if (proof.request.signatureScheme !== mlsSignatureScheme(ciphersuite))
    throw new Error("proof signature scheme does not match ciphersuite");

  const digest = accountIdentityProofSigningDigest(proof.request);
  if (!schnorr.verify(proof.signature, digest, accountIdentityBytes))
    throw new Error("proof signature does not verify for credential identity");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
