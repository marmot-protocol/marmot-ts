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
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  appDataDictionaryExtensionType,
  defaultCredentialTypes,
  defaultExtensionTypes,
  getAppDataDictionary,
  getGroupMembers,
  type ClientState,
  type CredentialBasic,
  type ExtensionRequiredCapabilities,
  type GroupContextExtension,
  type KeyPackage,
  type LeafNode,
} from "ts-mls";

import {
  type AuthorizationProof,
  type AuthorizationProofSigner,
  type AuthorizationProofTemplate,
  AuthorizationProofError,
  decodeAuthorizationProof,
  encodeAuthorizationProof,
  produceAuthorizationProof,
  verifyAuthorizationProof,
} from "../authorization-proof.js";
import { BinaryReader } from "../binary.js";
import { decodeComponentsList } from "./app-components-list.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "./ids.js";

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
 *
 * Phase 9 (UPD-01) adds two more, both emitted by the commit-legality bucket
 * classifier in `./integrity.js`, not by any validator in this module:
 * - `member-identity-changed` (D-05): the replacement leaf at an existing
 *   member's index carries a different account identity than the leaf it
 *   replaced. Deliberately NOT `identity-mismatch` — that literal means the
 *   proof's signer does not match this leaf's own credential identity (a
 *   single-leaf check). Conflating the two would collapse a membership-model
 *   violation into a proof-binding error.
 * - `unattributable-leaf` (D-02): a changed leaf that, with the commit's full
 *   proposal list and committer index available, matches no Add proposal, no
 *   Update proposal sender, and is not the committer's update-path leaf —
 *   fail closed.
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
  | "missing-requirement"
  | "member-identity-changed"
  | "unattributable-leaf";

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

// ---------------------------------------------------------------------------
// Validators, profile classifier, and container location guards
// ---------------------------------------------------------------------------

/**
 * The deployed legacy `marmot.account-identity-proof.v2` custom LeafNode extension type
 * (`../account-identity-proof.js`). Not exported: CUT-01 forbids any legacy export from this
 * module — it exists here only so validators can detect and reject it (Pitfall 10).
 */
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

/**
 * Signature-key byte lengths a scheme accepts. Ed25519/Ed448 (`0x0807`/`0x0808`) have one
 * valid length; the ECDSA schemes accept both noble's default compressed SEC1 output and
 * MLS/OpenMLS's uncompressed SEC1 form (planning-time fact, RESEARCH).
 */
const SIGNATURE_KEY_LENGTHS_BY_SCHEME: Record<number, readonly number[]> = {
  0x0807: [32],
  0x0808: [57],
  0x0403: [33, 65],
  0x0503: [49, 97],
  0x0603: [67, 133],
};

/** A single raw `{ componentId, data }` entry read directly off `app_data_dictionary` bytes. */
interface RawDictionaryEntry {
  componentId: number;
  data: Uint8Array;
}

/**
 * Raw-parses `app_data_dictionary` extension bytes as an MLS vector of
 * `{ uint16 componentId; opaque data<V> }`, without building a `Map` — so duplicate
 * component ids (including duplicate `0x8009` entries) survive into the result instead of
 * being silently collapsed by a dictionary-style decoder (Pitfall 8). Never routes through
 * `ts-mls`'s `getAppDataDictionary`, which throws on a duplicate id rather than reporting
 * the count.
 */
function readDictionaryEntries(
  extensionData: Uint8Array,
): RawDictionaryEntry[] {
  try {
    const reader = new BinaryReader(extensionData);
    const entries = reader.vector((r) => ({
      componentId: r.uint16(),
      data: r.opaque(),
    }));
    reader.end();
    return entries;
  } catch (err) {
    throw new AccountIdentityProofError(
      `account identity proof dictionary did not decode: ${err instanceof Error ? err.message : String(err)}`,
      "invalid-dictionary",
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Narrows a heterogeneous extension list (GroupContext, GroupInfo, LeafNode, or KeyPackage
 * extensions all pass structurally) down to the `app_data_dictionary`-typed entries whose
 * `extensionData` is raw bytes.
 */
function dictionaryExtensionsOf(
  extensions: readonly { extensionType: number }[],
): { extensionType: number; extensionData: Uint8Array }[] {
  return extensions.filter(
    (ext): ext is { extensionType: number; extensionData: Uint8Array } =>
      ext.extensionType === appDataDictionaryExtensionType &&
      (ext as { extensionData?: unknown }).extensionData instanceof Uint8Array,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Converts any throw from the shared envelope primitive's decode/verify steps (an
 * `AuthorizationProofError`, or any other error) into `AccountIdentityProofError` with
 * reason `invalid-proof`, preserving the original as `cause`. No untyped error may escape a
 * validator in this module (T-07-06).
 */
function wrapAsInvalidProof(err: unknown): AccountIdentityProofError {
  return new AccountIdentityProofError(
    `account identity proof envelope invalid: ${err instanceof Error ? err.message : String(err)}`,
    "invalid-proof",
    {
      cause:
        err instanceof AuthorizationProofError
          ? err
          : err instanceof Error
            ? err
            : undefined,
    },
  );
}

/**
 * Validates a `0x8009` account identity proof on a single MLS LeafNode against an explicit
 * ciphersuite (D-16: never inferred from the leaf itself). Throws `AccountIdentityProofError`
 * on the first failing check, in the exact order documented below.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Validation"
 */
export function validateLeafAccountIdentityProof(
  leaf: LeafNode,
  ciphersuite: number,
): void {
  // 1. Credential must be basic with a 32-byte, on-curve x-only identity.
  if (leaf.credential.credentialType !== defaultCredentialTypes.basic)
    throw new AccountIdentityProofError(
      "leaf credential is not a basic credential",
      "invalid-credential",
    );
  const identity = (leaf.credential as CredentialBasic).identity;
  if (identity.length !== 32)
    throw new AccountIdentityProofError(
      "credential identity must be exactly 32 bytes",
      "invalid-credential",
    );
  try {
    schnorr.utils.lift_x(bytesToNumberBE(identity));
  } catch {
    throw new AccountIdentityProofError(
      "credential identity is not a valid x-only secp256k1 point",
      "invalid-credential",
    );
  }

  // 2. Any legacy 0xf2f1 extension anywhere on the leaf is an outright reject (CUT-02,
  //    Pitfall 10) — covers both legacy-only and mixed leaves.
  if (
    leaf.extensions.some(
      (ext) =>
        ext.extensionType === LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    )
  )
    throw new AccountIdentityProofError(
      "leaf carries the legacy 0xf2f1 account identity proof extension",
      "legacy-extension-present",
    );

  // 3. Exactly one app_data_dictionary extension.
  const dictionaryExtensions = dictionaryExtensionsOf(leaf.extensions);
  if (dictionaryExtensions.length > 1)
    throw new AccountIdentityProofError(
      "leaf carries more than one app_data_dictionary extension",
      "duplicate-data",
    );
  if (dictionaryExtensions.length === 0)
    throw new AccountIdentityProofError(
      "leaf carries no app_data_dictionary extension",
      "missing-support",
    );

  const entries = readDictionaryEntries(dictionaryExtensions[0]!.extensionData);

  // 4. Duplicate 0x8009 entries reject first (Pitfall 8); otherwise the entries must be
  //    strictly ascending (a general dictionary-structure requirement this raw parse must
  //    re-check itself, since it bypasses ts-mls's own sorted+unique enforcement).
  const proofEntries = entries.filter(
    (e) => e.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  );
  if (proofEntries.length > 1)
    throw new AccountIdentityProofError(
      "leaf app_data_dictionary carries more than one 0x8009 entry",
      "duplicate-data",
    );
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1]!.componentId >= entries[i]!.componentId)
      throw new AccountIdentityProofError(
        "leaf app_data_dictionary entries are not sorted ascending by componentId",
        "invalid-dictionary",
      );
  }

  // 5. Support-list membership (Pitfall 7: independent of the data-entry check below).
  const supportEntry = entries.find(
    (e) => e.componentId === APP_COMPONENTS_COMPONENT_ID,
  );
  let supportsProof = false;
  if (supportEntry !== undefined) {
    try {
      supportsProof = decodeComponentsList(supportEntry.data).includes(
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      );
    } catch (err) {
      throw new AccountIdentityProofError(
        `leaf app_components support list did not decode: ${err instanceof Error ? err.message : String(err)}`,
        "invalid-dictionary",
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }
  if (!supportsProof)
    throw new AccountIdentityProofError(
      "leaf does not advertise 0x8009 in its app_components support list",
      "missing-support",
    );

  // 6. The data entry itself must exist.
  if (proofEntries.length === 0)
    throw new AccountIdentityProofError(
      "leaf app_data_dictionary has no 0x8009 entry",
      "missing-data",
    );

  // 7. SafeAAD (0x0002) must not list 0x8009 (PROOF-06, D-08).
  const safeAadEntry = entries.find(
    (e) => e.componentId === SAFE_AAD_COMPONENT_ID,
  );
  if (safeAadEntry !== undefined) {
    let safeAadIds: number[];
    try {
      safeAadIds = decodeComponentsList(safeAadEntry.data);
    } catch (err) {
      throw new AccountIdentityProofError(
        `leaf SafeAAD entry did not decode: ${err instanceof Error ? err.message : String(err)}`,
        "invalid-dictionary",
        { cause: err instanceof Error ? err : undefined },
      );
    }
    if (safeAadIds.includes(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID))
      throw new AccountIdentityProofError(
        "leaf SafeAAD entry lists 0x8009, which is not a valid SafeAAD location",
        "invalid-location",
      );
  }

  // 8. The leaf's own signature key must be a valid length for the ciphersuite's scheme,
  //    checked before the event is reconstructed (spec: "MUST be valid for that ciphersuite
  //    before the event is reconstructed").
  const scheme = mlsSignatureSchemeForCiphersuite(ciphersuite);
  const allowedLengths = SIGNATURE_KEY_LENGTHS_BY_SCHEME[scheme] ?? [];
  if (!allowedLengths.includes(leaf.signaturePublicKey.length))
    throw new AccountIdentityProofError(
      `leaf signature key length ${leaf.signaturePublicKey.length} is not valid for signature scheme 0x${scheme.toString(16)}`,
      "signature-key-mismatch",
    );

  // 9. Decode the 104-byte envelope.
  let decoded: AuthorizationProof;
  try {
    decoded = decodeAuthorizationProof(proofEntries[0]!.data);
  } catch (err) {
    throw wrapAsInvalidProof(err);
  }

  // 10. The proof's signer must be exactly the credential identity (Production and reuse).
  if (!bytesEqual(decoded.signerPubkey, identity))
    throw new AccountIdentityProofError(
      "account identity proof signer does not match credential identity",
      "identity-mismatch",
    );

  // 11. Reconstruct the exact signing event from the leaf's own signature key (T-07-02) and
  //     verify the BIP-340 signature.
  try {
    verifyAuthorizationProof(
      accountIdentityProofTemplate(ciphersuite, leaf.signaturePublicKey),
      decoded,
    );
  } catch (err) {
    throw wrapAsInvalidProof(err);
  }
}

/**
 * True iff `holder`'s own extension list carries any account-identity-proof material at all:
 * the legacy `0xf2f1` extension, a `0x8009` dictionary entry, or a dictionary that fails to
 * decode (fail closed — an undecodable dictionary might be hiding proof material). Does not
 * itself validate the material; use {@link validateLeafAccountIdentityProof} or
 * {@link validateKeyPackageAccountIdentityProof} for that.
 *
 * Accepts a LeafNode or a KeyPackage. It only inspects `holder.extensions`, so for a
 * KeyPackage it reports KeyPackage-level (misplaced or legacy) material, not material on the
 * embedded leaf — check `keyPackage.leafNode` separately.
 */
export function hasAccountIdentityProofMaterial(holder: {
  readonly extensions: readonly { extensionType: number }[];
}): boolean {
  if (
    holder.extensions.some(
      (ext) =>
        ext.extensionType === LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    )
  )
    return true;

  for (const ext of dictionaryExtensionsOf(holder.extensions)) {
    let entries: RawDictionaryEntry[];
    try {
      entries = readDictionaryEntries(ext.extensionData);
    } catch {
      return true;
    }
    if (
      entries.some((e) => e.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)
    )
      return true;
  }
  return false;
}

/**
 * Rejects `0x8009` account identity proof data appearing anywhere it is not valid: the
 * GroupContext dictionary, KeyPackage-level extensions, or a GroupInfo extension list
 * (PROOF-06, D-08). `location` names the container in the thrown message. Structurally
 * accepts any of ts-mls's GroupContext, GroupInfo, LeafNode, or KeyPackage extension array
 * types (all are `{ extensionType: number, ... }[]`).
 */
export function assertNoAccountIdentityProofComponent(
  extensions: readonly { extensionType: number }[],
  location: AccountIdentityProofLocation,
): void {
  for (const ext of dictionaryExtensionsOf(extensions)) {
    const entries = readDictionaryEntries(ext.extensionData);
    if (
      entries.some((e) => e.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)
    )
      throw new AccountIdentityProofError(
        `account identity proof component 0x8009 is not a valid ${location} entry`,
        "invalid-location",
      );
  }
}

/**
 * Validates a `0x8009` account identity proof carried on a KeyPackage: rejects an explicit
 * `expectedCiphersuite` mismatch, a legacy `0xf2f1` or `0x8009` entry at the KeyPackage
 * level (PROOF-05), then validates the embedded LeafNode using the KeyPackage's own
 * ciphersuite (D-16 — never a caller-supplied "current" ciphersuite).
 */
export function validateKeyPackageAccountIdentityProof(
  keyPackage: KeyPackage,
  expectedCiphersuite?: number,
): void {
  if (
    expectedCiphersuite !== undefined &&
    expectedCiphersuite !== keyPackage.cipherSuite
  )
    throw new AccountIdentityProofError(
      `KeyPackage ciphersuite ${keyPackage.cipherSuite} does not match expected ciphersuite ${expectedCiphersuite}`,
      "ciphersuite-mismatch",
    );

  if (
    keyPackage.extensions.some(
      (ext) =>
        ext.extensionType === LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    )
  )
    throw new AccountIdentityProofError(
      "KeyPackage-level extensions carry the legacy 0xf2f1 proof extension",
      "legacy-extension-present",
    );

  assertNoAccountIdentityProofComponent(keyPackage.extensions, "key-package");

  validateLeafAccountIdentityProof(keyPackage.leafNode, keyPackage.cipherSuite);
}

/**
 * Validates the `0x8009` account identity proof of every member leaf in `state`. Throws on
 * the first invalid leaf, wrapping the original `AccountIdentityProofError` as `cause` and
 * naming only the member's tree position — never a pubkey (T-07-08).
 */
export function validateGroupMemberAccountIdentityProofs(
  state: ClientState,
  ciphersuite: number,
): void {
  const members = getGroupMembers(state);
  for (let index = 0; index < members.length; index++) {
    try {
      validateLeafAccountIdentityProof(members[index]!, ciphersuite);
    } catch (err) {
      if (err instanceof AccountIdentityProofError)
        throw new AccountIdentityProofError(
          `account identity proof invalid for group member ${index}: ${err.message}`,
          err.reason,
          { cause: err },
        );
      throw err;
    }
  }
}

/**
 * Classifies a GroupContext's account-identity-proof profile from its extensions, modelled
 * on MDK's `protocol_profile_of_group_extensions` (D-07): `"current"` (0x8009 required, no
 * legacy requirement), `"legacy"` (0xf2f1 required, no 0x8009 requirement), `"mixed"`
 * (both), or `"neither"`. Throws `invalid-location` if the GroupContext dictionary itself
 * carries `0x8009` data (Pitfall 9) — that is always a class-level violation, not a profile.
 */
export function classifyGroupAccountIdentityProofProfile(
  extensions: GroupContextExtension[],
): AccountIdentityProofProfile {
  assertNoAccountIdentityProofComponent(extensions, "group-context");

  const legacyRequired = extensions.some((ext) => {
    if (ext.extensionType !== defaultExtensionTypes.required_capabilities)
      return false;
    const required = ext as ExtensionRequiredCapabilities;
    return required.extensionData.extensionTypes.includes(
      LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    );
  });

  let dictionary: ReturnType<typeof getAppDataDictionary>;
  try {
    dictionary = getAppDataDictionary(extensions);
  } catch (err) {
    throw new AccountIdentityProofError(
      `group app_components could not classify proof profile: ${err instanceof Error ? err.message : String(err)}`,
      "invalid-dictionary",
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const appComponentsData = dictionary?.find(
    (entry) => entry.componentId === APP_COMPONENTS_COMPONENT_ID,
  )?.data;

  let currentRequired = false;
  if (appComponentsData !== undefined) {
    try {
      currentRequired = decodeComponentsList(appComponentsData).includes(
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      );
    } catch (err) {
      throw new AccountIdentityProofError(
        `group app_components could not classify proof profile: ${err instanceof Error ? err.message : String(err)}`,
        "invalid-dictionary",
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  if (currentRequired && legacyRequired) return "mixed";
  if (currentRequired) return "current";
  if (legacyRequired) return "legacy";
  return "neither";
}

/**
 * Throws unless `extensions` classify as the `"current"` account-identity-proof profile
 * (D-07, D-13): `"legacy"` -> `legacy-group`, `"mixed"` -> `mixed-profile`, `"neither"` ->
 * `missing-requirement`.
 */
export function assertCurrentGroupAccountIdentityProofProfile(
  extensions: GroupContextExtension[],
): void {
  const profile = classifyGroupAccountIdentityProofProfile(extensions);
  switch (profile) {
    case "current":
      return;
    case "legacy":
      throw new AccountIdentityProofError(
        "group requires the legacy 0xf2f1 proof extension, not 0x8009",
        "legacy-group",
      );
    case "mixed":
      throw new AccountIdentityProofError(
        "group requires both the legacy 0xf2f1 proof extension and 0x8009",
        "mixed-profile",
      );
    case "neither":
      throw new AccountIdentityProofError(
        "group requires neither the legacy 0xf2f1 proof extension nor 0x8009",
        "missing-requirement",
      );
  }
}

/**
 * The result of a non-throwing classification of whether a GroupContext's
 * extensions support the current account-identity-proof profile.
 */
export type GroupProfileSupport =
  | { kind: "supported" }
  | { kind: "unsupported"; proofReason: AccountIdentityProofRejectReason };

/**
 * Non-throwing wrapper over {@link assertCurrentGroupAccountIdentityProofProfile}
 * (D-01a, D-11): returns `{ kind: "supported" }` when `extensions` classify as
 * the current profile, or `{ kind: "unsupported", proofReason }` otherwise —
 * `proofReason` is the caught `AccountIdentityProofError.reason`
 * (`legacy-group`, `mixed-profile`, or `missing-requirement`), or
 * `"invalid-dictionary"` for any other thrown value.
 *
 * Never throws. Two call sites rely on that: `validateCommitLegality`'s D-01a
 * profile check (the sibling commit-legality module), which must stay
 * non-throwing so fork-recovery and tree-fed convergence (neither of which
 * wrap the call) can map a violation instead of aborting, and the D-11
 * load-time classifier that marks a stored group's profile without breaking
 * `Promise.all`-batched loading of every other group.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `protocol_profile_of_group_extensions`
 */
export function getGroupProfileSupport(
  extensions: GroupContextExtension[],
): GroupProfileSupport {
  try {
    assertCurrentGroupAccountIdentityProofProfile(extensions);
    return { kind: "supported" };
  } catch (err) {
    if (err instanceof AccountIdentityProofError)
      return { kind: "unsupported", proofReason: err.reason };
    return { kind: "unsupported", proofReason: "invalid-dictionary" };
  }
}
