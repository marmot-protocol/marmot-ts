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
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core/factories";

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

/**
 * The plain data template a proof class supplies for its own event: the exact `kind`,
 * ordered `tags`, and `content` the owning proof-class document defines. There is no
 * `ProofClass` descriptor interface and no kind registry — exact tag order/values are the
 * proof class's responsibility, covered by the event-id recompute in
 * {@link verifyAuthorizationProof} and {@link produceAuthorizationProof}.
 */
export interface AuthorizationProofTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * The minimal signer contract `produceAuthorizationProof` needs: a subset of
 * applesauce-core's `EventSigner`. A hand-rolled `{ signEvent }` object and a full
 * `EventSigner` both satisfy this type; the signer's public-key accessor is never
 * pre-flighted (the caller supplies the expected signer pubkey explicitly).
 */
export type AuthorizationProofSigner = Pick<EventSigner, "signEvent">;

/** Parameters for {@link produceAuthorizationProof}. */
export interface ProduceAuthorizationProofParams {
  template: AuthorizationProofTemplate;
  /** The signer's expected 32-byte x-only Nostr pubkey. */
  signerPubkey: Uint8Array;
  signer: AuthorizationProofSigner;
  /** Injected Unix timestamp in seconds; defaults to the current time. */
  createdAt?: number;
}

/**
 * The D-02 minimal structural sanity check on a template: `kind` is an integer, `tags` is
 * `string[][]`, `content` is a string. Must run before any hashing, because
 * `getEventHash` silently accepts a non-integer `kind` or `created_at`.
 */
function assertTemplate(template: AuthorizationProofTemplate): void {
  if (typeof template !== "object" || template === null)
    throw new AuthorizationProofError(
      "template must be an object",
      "malformed-template",
    );
  if (!Number.isInteger(template.kind))
    throw new AuthorizationProofError(
      "template kind must be an integer",
      "malformed-template",
    );
  if (
    !Array.isArray(template.tags) ||
    !template.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    )
  )
    throw new AuthorizationProofError(
      "template tags must be string[][]",
      "malformed-template",
    );
  if (typeof template.content !== "string")
    throw new AuthorizationProofError(
      "template content must be a string",
      "malformed-template",
    );
}

/** Returns a fresh copy of `tags` (outer and inner arrays copied). */
function cloneTags(tags: string[][]): string[][] {
  return tags.map((tag) => [...tag]);
}

/** Structural `string[][]` equality (not a JSON-string comparison, to avoid encoding artifacts). */
function tagsEqual(actual: unknown, expected: string[][]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const actualTag: unknown = actual[i];
    const expectedTag = expected[i];
    if (!Array.isArray(actualTag) || actualTag.length !== expectedTag.length)
      return false;
    for (let j = 0; j < expectedTag.length; j++) {
      if (actualTag[j] !== expectedTag[j]) return false;
    }
  }
  return true;
}

/**
 * Builds the exact unsigned proof event for a template, signer pubkey, and `created_at`:
 * validates the signer pubkey, `created_at`, and template (in that order, so the reason is
 * deterministic when several inputs are bad) and returns a fresh event with cloned tags.
 */
export function buildAuthorizationProofEvent(
  template: AuthorizationProofTemplate,
  signerPubkey: Uint8Array,
  createdAt: number,
): UnsignedEvent {
  assertSignerPubkey(signerPubkey);
  assertCreatedAt(createdAt);
  assertTemplate(template);
  return {
    pubkey: bytesToHex(signerPubkey),
    created_at: createdAt,
    kind: template.kind,
    tags: cloneTags(template.tags),
    content: template.content,
  };
}

/** Returns the lowercase-hex NIP-01 event id of the reconstructed proof event. */
export function authorizationProofEventId(
  template: AuthorizationProofTemplate,
  signerPubkey: Uint8Array,
  createdAt: number,
): string {
  return getEventHash(
    buildAuthorizationProofEvent(template, signerPubkey, createdAt),
  );
}

/**
 * Validates a `MarmotAuthorizationProof` against a proof-class template — spec verifier
 * steps 1-6: decode/structural checks (1-3), NIP-01 event reconstruction (4), event-id
 * computation (5), and BIP-340 verification (6). Accepts either raw 104-byte envelope
 * bytes or an already-decoded proof object (a hand-built object still runs steps 2-3).
 *
 * Class-specific signer-authorization, binding, carrier, and freshness rules belong to the
 * owning proof class, not this primitive. There is deliberately no wall-clock comparison —
 * the spec forbids receiver-side `created_at` expiry.
 */
export function verifyAuthorizationProof(
  template: AuthorizationProofTemplate,
  proof: AuthorizationProof | Uint8Array,
): AuthorizationProof {
  let decoded: AuthorizationProof;
  if (proof instanceof Uint8Array) {
    decoded = decodeAuthorizationProof(proof);
  } else {
    assertSignerPubkey(proof.signerPubkey);
    assertCreatedAt(proof.createdAt);
    if (proof.signature.length !== SIGNATURE_LENGTH)
      throw new AuthorizationProofError(
        `signature must be exactly ${SIGNATURE_LENGTH} bytes, got ${proof.signature.length}`,
        "invalid-length",
      );
    decoded = proof;
  }

  const id = authorizationProofEventId(
    template,
    decoded.signerPubkey,
    decoded.createdAt,
  );

  let valid: boolean;
  try {
    valid = schnorr.verify(
      decoded.signature,
      hexToBytes(id),
      decoded.signerPubkey,
    );
  } catch {
    valid = false;
  }
  if (!valid)
    throw new AuthorizationProofError(
      "signature does not verify",
      "invalid-signature",
    );

  return decoded;
}

/**
 * Produces a `MarmotAuthorizationProof` by asking an external Nostr event signer to sign
 * the exact proof event, then strictly validating the returned event before extracting the
 * envelope (spec "Producing a proof" steps 2-5). `createdAt` defaults to the producer's
 * current Unix time in whole seconds when omitted; an injected `createdAt` is used verbatim.
 *
 * The signer pubkey, `created_at`, and template are validated before the signer is ever
 * invoked (so an invalid request never reaches the signer). The returned event's `pubkey`,
 * `created_at`, `kind`, `tags`, and `content` must exactly equal the request, its `id` must
 * equal the recomputed NIP-01 id, and its signature must verify — each substituted field
 * yields its own `returned-*` reason, checked in that order. No hex string is
 * case-normalized: canonical-encoding.md ("Text") requires byte/text equality, not
 * case-insensitive comparison.
 *
 * A throw or rejection from `signer.signEvent` propagates unchanged — that is a signing
 * failure, not a proof rejection.
 */
export async function produceAuthorizationProof(
  params: ProduceAuthorizationProofParams,
): Promise<AuthorizationProof> {
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);

  const expected = buildAuthorizationProofEvent(
    params.template,
    params.signerPubkey,
    createdAt,
  );
  const expectedId = getEventHash(expected);

  const draft: UnsignedEvent = {
    ...expected,
    tags: cloneTags(expected.tags),
  };
  const signed: unknown = await params.signer.signEvent(draft);

  if (typeof signed !== "object" || signed === null)
    throw new AuthorizationProofError(
      "signer returned a non-object",
      "returned-event-malformed",
    );
  const returned = signed as Partial<
    UnsignedEvent & { id: string; sig: string }
  >;

  if (returned.pubkey !== expected.pubkey)
    throw new AuthorizationProofError(
      "returned event pubkey does not match the request",
      "returned-pubkey-mismatch",
    );
  if (returned.created_at !== expected.created_at)
    throw new AuthorizationProofError(
      "returned event created_at does not match the request",
      "returned-created-at-mismatch",
    );
  if (returned.kind !== expected.kind)
    throw new AuthorizationProofError(
      "returned event kind does not match the request",
      "returned-kind-mismatch",
    );
  if (!tagsEqual(returned.tags, expected.tags))
    throw new AuthorizationProofError(
      "returned event tags do not match the request",
      "returned-tags-mismatch",
    );
  if (returned.content !== expected.content)
    throw new AuthorizationProofError(
      "returned event content does not match the request",
      "returned-content-mismatch",
    );
  if (returned.id !== expectedId)
    throw new AuthorizationProofError(
      "returned event id does not match the recomputed id",
      "returned-id-mismatch",
    );
  if (typeof returned.sig !== "string" || !/^[0-9a-f]{128}$/.test(returned.sig))
    throw new AuthorizationProofError(
      "returned event signature is not valid hex",
      "returned-signature-invalid",
    );

  const signature = hexToBytes(returned.sig);
  let valid: boolean;
  try {
    valid = schnorr.verify(
      signature,
      hexToBytes(expectedId),
      params.signerPubkey,
    );
  } catch {
    valid = false;
  }
  if (!valid)
    throw new AuthorizationProofError(
      "returned event signature does not verify",
      "returned-signature-invalid",
    );

  return { signerPubkey: params.signerPubkey.slice(), createdAt, signature };
}
