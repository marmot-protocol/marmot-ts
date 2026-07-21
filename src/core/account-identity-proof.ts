/** @module @category Core - Account Identity Proof */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import {
  type ClientState,
  type CustomExtension,
  defaultCredentialTypes,
  getGroupMembers,
  makeCustomExtension,
  type LeafNode,
} from "ts-mls";

import { BinaryReader, BinaryWriter } from "./binary.js";
import { getCredentialPubkey } from "./credential.js";

/**
 * The Marmot account identity proof, carried as a custom MLS LeafNode extension
 * (`marmot.account-identity-proof.v2`).
 *
 * An MLS BasicCredential names a Marmot (Nostr) account, but the MLS signature
 * key is a separate per-leaf key. This extension binds the two by having the
 * Nostr account key sign — with BIP-340 Schnorr — a canonical, unpublished
 * Nostr kind-450 event whose tags carry the account/leaf binding, so
 * account-scoped policy (e.g. admin authorization) can trust the credential
 * identity. Signing a real (if unpublished) Nostr event, rather than a
 * bespoke digest, lets external Nostr signers (NIP-07/NIP-46, hardware
 * signers) produce the proof via a normal `signEvent` path — see
 * {@link buildAccountIdentityProofEvent} and
 * {@link accountIdentityProofSignatureFromSignedEvent}.
 *
 * The signed message is the NIP-01 event id of the canonical kind-450 event:
 *   pubkey     = account identity (x-only Nostr pubkey, lowercase hex)
 *   created_at = 0
 *   kind       = 450
 *   content    = ""
 *   tags       = [
 *     ["d", "marmot.account-identity-proof.v2"],
 *     ["extension", "0xf2f1"],
 *     ["version", "2"],
 *     ["ciphersuite", "<decimal>"],
 *     ["signature_scheme", "<decimal>"],
 *     ["mls_signature_key", "<lowercase hex>"],
 *   ]
 *
 * Wire (`encode_proof`, fixed-width, big-endian; unchanged from v1 except the
 * version byte value and the meaning of the signature):
 *   uint8  version;                       // 2
 *   uint16 ciphersuite;
 *   uint16 signature_scheme;
 *   opaque account_identity[32];          // x-only Nostr pubkey, no length prefix
 *   uint16 mls_signature_public_key_len;
 *   opaque mls_signature_public_key[len];
 *   opaque signature[64];                 // BIP-340 Schnorr over the kind-450 event id
 *
 * @see darkmatter `crates/cgka-engine/src/account_identity_proof.rs`
 */
export const ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;
/** The (unpublished, local-only) Nostr event kind the proof signs. */
export const ACCOUNT_IDENTITY_PROOF_EVENT_KIND = 450;
const ACCOUNT_IDENTITY_PROOF_VERSION = 2;
const ACCOUNT_IDENTITY_PROOF_DOMAIN = "marmot.account-identity-proof.v2";
const ACCOUNT_IDENTITY_LEN = 32;
const SCHNORR_SIGNATURE_LEN = 64;

/**
 * MLS signature scheme code points (RFC 9420 / IANA TLS SignatureScheme),
 * keyed by MLS ciphersuite id. Used to record which scheme the leaf signature
 * key uses, matching OpenMLS `ciphersuite.signature_algorithm() as u16`
 * (verified against `refs/mdk` — each row's decimal is the exact
 * `signature_scheme` tag value emitted for that ciphersuite).
 */
const MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE: Record<number, number> = {
  1: 0x0807, // Ed25519 — 2055
  2: 0x0403, // ecdsa_secp256r1_sha256 — 1027
  3: 0x0807, // Ed25519 — 2055 (duplicates 1)
  4: 0x0808, // Ed448 — 2056
  5: 0x0603, // ecdsa_secp521r1_sha512 — 1539
  6: 0x0808, // Ed448 — 2056 (duplicates 4)
  7: 0x0503, // ecdsa_secp384r1_sha384 — 1283
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

/**
 * A Nostr event, signed by an external signer (NIP-07/NIP-46, hardware, etc).
 * Only the members needed to extract/verify the proof signature are required.
 */
export interface SignedAccountIdentityProofEvent {
  id: string;
  pubkey: string;
  sig: string;
}

/**
 * An external Nostr event signer (e.g. NIP-07 `window.nostr.signEvent`,
 * NIP-46 remote signer, or a hardware signer) capable of signing the
 * canonical unsigned kind-450 proof event and returning the signed event.
 */
export type AccountIdentityProofEventSigner = (
  event: UnsignedEvent,
) => SignedAccountIdentityProofEvent | Promise<SignedAccountIdentityProofEvent>;

/**
 * A hook that produces the 64-byte BIP-340 proof signature. Two shapes:
 * - a plain function: the raw-secret-key digest path (see
 *   {@link signAccountIdentityProof}) — signs the 32-byte kind-450 event id
 *   directly.
 * - `{ signEvent }`: the external-signer path — signs the canonical kind-450
 *   {@link buildAccountIdentityProofEvent} via a normal Nostr `signEvent` API;
 *   the 64-byte signature is extracted with
 *   {@link accountIdentityProofSignatureFromSignedEvent}.
 */
export type AccountIdentityProofSigner =
  | ((request: AccountIdentityProofRequest) => Uint8Array | Promise<Uint8Array>)
  | { signEvent: AccountIdentityProofEventSigner };

/**
 * Builds the canonical, unsigned Nostr kind-450 proof event for a request.
 * This event is a **local signing template only** — it is never published or
 * relayed (`foundation/registries.md`: kind 450 is "Local signing template,
 * not relayed"). Mirrors darkmatter `AccountIdentityProofRequest::proof_event`.
 */
export function buildAccountIdentityProofEvent(
  request: AccountIdentityProofRequest,
): UnsignedEvent {
  return {
    pubkey: bytesToHex(request.accountIdentity),
    created_at: 0,
    kind: ACCOUNT_IDENTITY_PROOF_EVENT_KIND,
    content: "",
    tags: [
      ["d", ACCOUNT_IDENTITY_PROOF_DOMAIN],
      [
        "extension",
        `0x${ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE.toString(16).padStart(4, "0")}`,
      ],
      ["version", String(ACCOUNT_IDENTITY_PROOF_VERSION)],
      ["ciphersuite", String(request.ciphersuite)],
      ["signature_scheme", String(request.signatureScheme)],
      ["mls_signature_key", bytesToHex(request.mlsSignaturePublicKey)],
    ],
  };
}

/**
 * Returns the canonical unsigned kind-450 proof event as a JSON string, for
 * handing to an external signer that accepts a serialized event template.
 * Mirrors darkmatter `AccountIdentityProofRequest::proof_event_json`.
 */
export function accountIdentityProofEventJson(
  request: AccountIdentityProofRequest,
): string {
  return JSON.stringify(buildAccountIdentityProofEvent(request));
}

/**
 * Returns the lowercase-hex NIP-01 event id of the canonical kind-450 proof
 * event. Mirrors darkmatter `AccountIdentityProofRequest::proof_event_id`.
 */
export function accountIdentityProofEventId(
  request: AccountIdentityProofRequest,
): string {
  return getEventHash(buildAccountIdentityProofEvent(request));
}

/** The 32-byte BIP-340 message digest the account key signs: the NIP-01 event
 * id of the canonical, unpublished kind-450 proof event (see
 * {@link buildAccountIdentityProofEvent}). */
export function accountIdentityProofSigningDigest(
  request: AccountIdentityProofRequest,
): Uint8Array {
  return hexToBytes(accountIdentityProofEventId(request));
}

/** Signs a proof request with a raw 32-byte Nostr secret key (BIP-340 Schnorr). */
export function signAccountIdentityProof(
  request: AccountIdentityProofRequest,
  secretKey: Uint8Array,
): Uint8Array {
  return schnorr.sign(accountIdentityProofSigningDigest(request), secretKey);
}

/**
 * Validates a signed kind-450 proof event against a request and extracts the
 * 64-byte BIP-340 Schnorr signature. Throws if the signed event's pubkey
 * differs from the request's account identity, if its id differs from the
 * rebuilt canonical proof-event id, or if the signature does not verify.
 * Mirrors darkmatter `AccountIdentityProofRequest::signature_from_signed_event`.
 */
export function accountIdentityProofSignatureFromSignedEvent(
  request: AccountIdentityProofRequest,
  event: SignedAccountIdentityProofEvent,
): Uint8Array {
  const accountIdentityHex = bytesToHex(request.accountIdentity);
  if (event.pubkey.toLowerCase() !== accountIdentityHex)
    throw new Error("proof event signer does not match account identity");

  const expectedId = accountIdentityProofEventId(request);
  if (event.id.toLowerCase() !== expectedId)
    throw new Error("signed proof event does not match proof request");

  const signature = hexToBytes(event.sig);
  if (
    !schnorr.verify(signature, hexToBytes(expectedId), request.accountIdentity)
  )
    throw new Error("invalid signed proof event: signature does not verify");

  return signature;
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

/** Builds the `marmot.account-identity-proof.v2` LeafNode extension. */
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
 *
 * `params.signer` may be either a raw-secret-key digest signer (a plain
 * function; see {@link signAccountIdentityProof}) or an external Nostr event
 * signer (`{ signEvent }`; see {@link AccountIdentityProofEventSigner}) —
 * both produce the same 64-byte BIP-340 signature.
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
  const signature =
    typeof params.signer === "function"
      ? await params.signer(request)
      : accountIdentityProofSignatureFromSignedEvent(
          request,
          await params.signer.signEvent(
            buildAccountIdentityProofEvent(request),
          ),
        );
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
      "missing marmot.account-identity-proof.v2 LeafNode extension",
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

/**
 * Verifies the Marmot account identity proof on every member leaf in the group.
 *
 * The spec requires a valid proof on every member leaf and KeyPackage — "there
 * is no legacy fallback" (`foundation/account-identity-proof` spec §Validation;
 * the spec doc is still filed under its pre-v2 name, see PROOF-V2.md).
 * Throws on the first leaf whose proof is missing or invalid, naming the member.
 */
export function verifyAllLeafAccountIdentityProofs(
  state: ClientState,
  ciphersuite: number,
): void {
  for (const leaf of getGroupMembers(state)) {
    try {
      verifyLeafAccountIdentityProof(leaf, ciphersuite);
    } catch (err) {
      const member =
        leaf.credential.credentialType === defaultCredentialTypes.basic
          ? getCredentialPubkey(leaf.credential)
          : "<non-basic credential>";
      throw new Error(
        `account identity proof invalid for member ${member}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
