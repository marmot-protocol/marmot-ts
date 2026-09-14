/**
 * @module @category Core - App Components
 *
 * The `marmot.member.account-identity-proof.v2` proof class (component `0x8009`): the fixed
 * kind-450 signing template and producer, and (added in a later task of this module) the
 * leaf/KeyPackage/whole-tree validators, GroupContext profile classifier, and container
 * location guards.
 *
 * This class supplies only the plain `{ kind, tags, content }` template the shared
 * `MarmotAuthorizationProof` envelope primitive needs — all envelope bytes, `created_at`
 * range enforcement, NIP-01 event-id reconstruction, BIP-340 verification, and
 * external-signer produce validation live in `../authorization-proof.js` and are reused
 * here, never re-implemented.
 *
 * This is a purely additive replacement for the legacy `marmot.account-identity-proof.v2`
 * custom LeafNode extension (`0xf2f1`, `../account-identity-proof.js`), which this module
 * does not import from or modify.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 * @see refs/marmot/foundation/authorization-proofs.md
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  type AuthorizationProofSigner,
  type AuthorizationProofTemplate,
  encodeAuthorizationProof,
  produceAuthorizationProof,
} from "../authorization-proof.js";
import { ACCOUNT_IDENTITY_PROOF_COMPONENT_ID } from "./ids.js";

/** The kind-450 proof event carries this fixed `d` tag value (spec-mandated; not editable). */
const ACCOUNT_IDENTITY_PROOF_DOMAIN = "marmot.account-identity-proof.v2";
/** The (unpublished, local-only) Nostr event kind the proof signs. */
const ACCOUNT_IDENTITY_PROOF_EVENT_KIND = 450;
/** The fixed content string of the kind-450 proof event (spec-mandated). */
const ACCOUNT_IDENTITY_PROOF_CONTENT =
  "Authorize this MLS leaf key for my Marmot account";

/**
 * MLS signature scheme code points (RFC 9420 / IANA TLS SignatureScheme), keyed by MLS
 * ciphersuite id. Re-homed verbatim from the verified legacy table
 * (`../account-identity-proof.js`'s `MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE`) per the research
 * "Don't Hand-Roll" guidance — these values are already verified against
 * `refs/mdk` `ciphersuite.signature_algorithm() as u16` and must not be re-derived.
 */
const MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE: Record<number, number> = {
  1: 0x0807, // Ed25519
  2: 0x0403, // ecdsa_secp256r1_sha256
  3: 0x0807, // Ed25519 (duplicates 1)
  4: 0x0808, // Ed448
  5: 0x0603, // ecdsa_secp521r1_sha512
  6: 0x0808, // Ed448 (duplicates 4)
  7: 0x0503, // ecdsa_secp384r1_sha384
};

/** Formats a `uint16` as `0x` followed by exactly four lowercase hexadecimal digits. */
function toHex4(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

/**
 * The reason a `0x8009` account identity proof (or a GroupContext/KeyPackage location
 * check) was rejected. One literal per spec validation step — never a coarse bucket. The
 * nine D-13 minimum reasons (`invalid-location`, `missing-support`, `missing-data`,
 * `duplicate-data`, `ciphersuite-mismatch`, `signature-key-mismatch`, `identity-mismatch`,
 * `invalid-proof`, `legacy-extension-present`) are all present; `invalid-credential`,
 * `invalid-dictionary`, `legacy-group`, `mixed-profile`, and `missing-requirement` are the
 * additions D-13 allows.
 */
export type AccountIdentityProofRejectReason =
  | "invalid-credential"
  | "legacy-extension-present"
  | "invalid-dictionary"
  | "duplicate-data"
  | "missing-support"
  | "missing-data"
  | "invalid-location"
  | "ciphersuite-mismatch"
  | "signature-key-mismatch"
  | "identity-mismatch"
  | "invalid-proof"
  | "legacy-group"
  | "mixed-profile"
  | "missing-requirement";

/** Thrown for every rejection in this module. */
export class AccountIdentityProofError extends Error {
  constructor(
    message: string,
    readonly reason: AccountIdentityProofRejectReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AccountIdentityProofError";
  }
}

/**
 * The account-identity-proof profile a GroupContext (or, per-leaf, a LeafNode) classifies
 * as: `"current"` (`0x8009` required/present, no `0xf2f1`), `"legacy"` (`0xf2f1` required,
 * no `0x8009`), `"mixed"` (both), or `"neither"`.
 */
export type AccountIdentityProofProfile =
  "current" | "legacy" | "mixed" | "neither";

/** The container an `assertNoAccountIdentityProofComponent` location guard checks. */
export type AccountIdentityProofLocation =
  "group-context" | "key-package" | "group-info";

/** Returns the MLS signature scheme code point for a ciphersuite id. */
export function mlsSignatureSchemeForCiphersuite(ciphersuite: number): number {
  const scheme = MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE[ciphersuite];
  if (scheme === undefined)
    throw new AccountIdentityProofError(
      `unknown MLS signature scheme for ciphersuite ${ciphersuite}`,
      "ciphersuite-mismatch",
    );
  return scheme;
}

/**
 * Builds the exact `marmot.member.account-identity-proof.v2` kind-450 signing template for
 * a ciphersuite and MLS leaf signature key. Returns a fresh object (and fresh tag arrays)
 * on every call, so mutating one call's result never affects another's.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Signing event"
 */
export function accountIdentityProofTemplate(
  ciphersuite: number,
  mlsSignatureKey: Uint8Array,
): AuthorizationProofTemplate {
  return {
    kind: ACCOUNT_IDENTITY_PROOF_EVENT_KIND,
    tags: [
      ["d", ACCOUNT_IDENTITY_PROOF_DOMAIN],
      ["component", toHex4(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)],
      ["ciphersuite", toHex4(ciphersuite)],
      [
        "signature_scheme",
        toHex4(mlsSignatureSchemeForCiphersuite(ciphersuite)),
      ],
      ["mls_signature_key", bytesToHex(mlsSignatureKey)],
    ],
    content: ACCOUNT_IDENTITY_PROOF_CONTENT,
  };
}

/** Parameters for {@link produceAccountIdentityProof}. */
export interface ProduceAccountIdentityProofParams {
  signer: AuthorizationProofSigner;
  /** The 32-byte x-only Nostr account pubkey (the credential identity). */
  accountIdentity: Uint8Array;
  /** The MLS leaf signature public key this proof binds to the account. */
  mlsSignatureKey: Uint8Array;
  ciphersuite: number;
  /** Injected Unix timestamp in seconds; defaults to the current time (D-03). */
  createdAt?: number;
}

/**
 * Produces a `0x8009` account identity proof: builds the exact signing template (rejecting
 * an unknown ciphersuite before the signer is ever invoked), asks `params.signer` to sign
 * it via the shared `MarmotAuthorizationProof` primitive, and returns the 104-byte encoded
 * component ready to carry in a LeafNode `app_data_dictionary` entry.
 *
 * A throw from `produceAuthorizationProof` (a signing failure — malformed signer return,
 * substituted fields, bad signature) propagates unchanged as `AuthorizationProofError`; it
 * is not wrapped into `AccountIdentityProofError`, since it is a signer problem, not a leaf
 * rejection.
 */
export async function produceAccountIdentityProof(
  params: ProduceAccountIdentityProofParams,
): Promise<Uint8Array> {
  const template = accountIdentityProofTemplate(
    params.ciphersuite,
    params.mlsSignatureKey,
  );
  const proof = await produceAuthorizationProof({
    template,
    signerPubkey: params.accountIdentity,
    signer: params.signer,
    createdAt: params.createdAt,
  });
  return encodeAuthorizationProof(proof);
}
