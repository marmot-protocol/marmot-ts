/**
 * @module @category Core - Authorization Proof
 *
 * The shared, proof-class-agnostic `MarmotAuthorizationProof` envelope: a 104-byte
 * `signer_pubkey[32] | created_at uint64 BE | signature[64]` structure that lets a Nostr
 * account key authorize protocol-specific bytes through a normal signed (but unpublished)
 * Nostr event. This accommodates external signers (NIP-07/NIP-46, hardware signers) that
 * sign Nostr events but do not expose arbitrary BIP-340 signing.
 *
 * A proof class (e.g. the account identity proof, `0x8009`) supplies only a plain data
 * template — `{ kind, tags, content }` — describing its own event; this primitive owns the
 * envelope bytes, the `created_at` range rule, NIP-01 event-id reconstruction, BIP-340
 * verification, and strict external-signer return validation. It has no knowledge of any
 * particular proof class, no kind registry, and no MLS coupling.
 *
 * @see refs/marmot/foundation/authorization-proofs.md
 * @see refs/marmot/foundation/canonical-encoding.md
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";

import { BinaryReader, BinaryWriter } from "./binary.js";

/** Encoded byte length of a {@link AuthorizationProof} envelope. */
export const AUTHORIZATION_PROOF_LENGTH = 104;

/**
 * Largest `created_at` the envelope accepts (`2^53 - 1`), per the spec's requirement that
 * the value be represented exactly by interoperable JSON implementations.
 */
export const AUTHORIZATION_PROOF_MAX_CREATED_AT = 9007199254740991;

const MAX_CREATED_AT_BIGINT = (1n << 53n) - 1n;
const SIGNER_PUBKEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

/**
 * The reason a `MarmotAuthorizationProof` (or its produce/verify path) was rejected. One
 * literal per spec validation step — never a coarse bucket. The `returned-*` reasons cover
 * `produceAuthorizationProof`'s per-field external-signer substitution checks (Task 2).
 */
export type AuthorizationProofRejectReason =
  | "invalid-length"
  | "invalid-signer-pubkey"
  | "created-at-out-of-range"
  | "created-at-non-integer"
  | "malformed-template"
  | "invalid-signature"
  | "returned-event-malformed"
  | "returned-pubkey-mismatch"
  | "returned-created-at-mismatch"
  | "returned-kind-mismatch"
  | "returned-tags-mismatch"
  | "returned-content-mismatch"
  | "returned-id-mismatch"
  | "returned-signature-invalid";

/** Thrown for every rejection in this module. */
export class AuthorizationProofError extends Error {
  constructor(
    message: string,
    readonly reason: AuthorizationProofRejectReason,
  ) {
    super(message);
    this.name = "AuthorizationProofError";
  }
}

/** A decoded or produced `MarmotAuthorizationProof` envelope. */
export interface AuthorizationProof {
  /** 32-byte x-only secp256k1 signer public key. */
  signerPubkey: Uint8Array;
  /** Unix timestamp in seconds; range `[1, 2^53 - 1]`. */
  createdAt: number;
  /** 64-byte BIP-340 Schnorr signature. */
  signature: Uint8Array;
}

/**
 * Rejects a `signer_pubkey` that is not exactly 32 bytes or not a valid x-only secp256k1
 * curve point (independent of any signature check — spec verifier step 2).
 */
function assertSignerPubkey(bytes: Uint8Array): void {
  if (bytes.length !== SIGNER_PUBKEY_LENGTH)
    throw new AuthorizationProofError(
      `signer_pubkey must be exactly ${SIGNER_PUBKEY_LENGTH} bytes, got ${bytes.length}`,
      "invalid-signer-pubkey",
    );
  try {
    schnorr.utils.lift_x(bytesToNumberBE(bytes));
  } catch {
    throw new AuthorizationProofError(
      "signer_pubkey is not a valid x-only secp256k1 point",
      "invalid-signer-pubkey",
    );
  }
}

/**
 * Rejects a `created_at` that is not a safe integer in `[1, 2^53 - 1]` (spec verifier
 * step 3). Never floors a non-integer input.
 */
function assertCreatedAt(value: number): void {
  if (!Number.isInteger(value))
    throw new AuthorizationProofError(
      `created_at must be an integer, got ${value}`,
      "created-at-non-integer",
    );
  if (value < 1 || value > AUTHORIZATION_PROOF_MAX_CREATED_AT)
    throw new AuthorizationProofError(
      `created_at out of range [1, ${AUTHORIZATION_PROOF_MAX_CREATED_AT}], got ${value}`,
      "created-at-out-of-range",
    );
}

/**
 * Encodes a {@link AuthorizationProof} to its exact 104-byte wire form
 * (`signer_pubkey[32] | created_at uint64 BE | signature[64]`). Validates every field
 * before writing.
 */
export function encodeAuthorizationProof(
  proof: AuthorizationProof,
): Uint8Array {
  assertSignerPubkey(proof.signerPubkey);
  assertCreatedAt(proof.createdAt);
  if (proof.signature.length !== SIGNATURE_LENGTH)
    throw new AuthorizationProofError(
      `signature must be exactly ${SIGNATURE_LENGTH} bytes, got ${proof.signature.length}`,
      "invalid-length",
    );

  return new BinaryWriter()
    .bytes(proof.signerPubkey)
    .uint64(BigInt(proof.createdAt))
    .bytes(proof.signature)
    .build();
}

/**
 * Decodes exactly one 104-byte `MarmotAuthorizationProof`, rejecting truncation or
 * trailing bytes. Follows the spec verifier's step order: length, then signer_pubkey
 * validity, then the `created_at` range (checked as a `bigint` before converting to
 * `Number`, so an out-of-range wire value can never silently become a smaller in-range
 * number). Never checks the signature — that is `verifyAuthorizationProof`'s job (Task 2).
 */
export function decodeAuthorizationProof(data: Uint8Array): AuthorizationProof {
  if (data.length !== AUTHORIZATION_PROOF_LENGTH)
    throw new AuthorizationProofError(
      `authorization proof must be exactly ${AUTHORIZATION_PROOF_LENGTH} bytes, got ${data.length}`,
      "invalid-length",
    );

  const reader = new BinaryReader(data);
  const signerPubkey = reader.bytes(SIGNER_PUBKEY_LENGTH);
  const createdAtBig = reader.uint64();
  const signature = reader.bytes(SIGNATURE_LENGTH);
  reader.end();

  assertSignerPubkey(signerPubkey);

  if (createdAtBig < 1n || createdAtBig > MAX_CREATED_AT_BIGINT)
    throw new AuthorizationProofError(
      `created_at out of range [1, ${AUTHORIZATION_PROOF_MAX_CREATED_AT}]`,
      "created-at-out-of-range",
    );

  return { signerPubkey, createdAt: Number(createdAtBig), signature };
}
