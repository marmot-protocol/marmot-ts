/**
 * Shared account-identity-proof (`0x8009`) forged fixtures for plan
 * 08-01..08-04 and 09-01..09-04: a wire-valid but Marmot-layer-invalid
 * `KeyPackage` (missing, tampered, or stale proof), a wire-valid commit
 * proposal that drops the `0x8009` requirement from a group's
 * `app_components` list, a resulting-tree splice for testing UPD-01's
 * identity-equality check at the pure-validator level, and a dictionary-strip
 * fixture for UPD-03.
 *
 * Test-only: `__tests__` is excluded from `tsconfig.build.json` and never
 * published.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  generateKeyPackageWithKey,
  nodeTypes,
  type CiphersuiteImpl,
  type ClientState,
  type CustomExtension,
  type KeyPackage,
  type LeafNode,
  type PrivateKeyPackage,
  type Proposal,
} from "ts-mls";

import { encodeComponentsList } from "../../core/components/app-components-list.js";
import { produceAccountIdentityProof } from "../../core/components/account-identity-proof.js";
import {
  getAppComponents,
  makeLeafAppComponentsExtension,
} from "../../core/components/dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
} from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
import { createDefaultKeyPackageLifetime } from "../../utils/timestamp.js";
import type { testAccount } from "./test-accounts.js";

/**
 * Fixed `created_at` reused by every forged/tampered proof in this module so
 * a "tampered" proof is a genuine bit-flip of an otherwise-valid signed
 * proof, not a proof invalidated for an unrelated reason (e.g. a stale
 * timestamp).
 */
const FORGE_CREATED_AT = 1700000000;

/** Flips the last byte of `bytes`, without mutating the input. */
function tamperLastByte(bytes: Uint8Array): Uint8Array {
  const tampered = new Uint8Array(bytes);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
  return tampered;
}

/**
 * Builds a cryptographically valid MLS `KeyPackage` (ts-mls signs whatever
 * `leafNodeExtensions` it is given) through ts-mls's public
 * `generateKeyPackageWithKey`, bypassing `src/core/key-package.ts`'s
 * `generateKeyPackage` (which always attaches a real `0x8009` proof) so the
 * leaf carries no proof, a proof tampered after signing, or a proof that is
 * genuinely stale.
 *
 * - `proof: "missing"`: the leaf carries no `app_data_dictionary` extension
 *   at all, so it has no `0x8009` entry.
 * - `proof: "tampered"`: the leaf carries a real, correctly-bound
 *   `0x8009` proof (same account, same MLS signature key, same ciphersuite,
 *   fixed `createdAt`) with its last byte flipped — a structurally valid
 *   envelope whose BIP-340 signature no longer verifies.
 * - `proof: "stale"` (Phase 9, UPD-02/D-08): the leaf carries a genuinely,
 *   validly signed proof bound to a DIFFERENT MLS signature key — not a
 *   tampered one. A second signature keypair is generated and
 *   `produceAccountIdentityProof` is called with it as `mlsSignatureKey`
 *   (same account, same ciphersuite, same `FORGE_CREATED_AT`); the resulting
 *   bytes are attached unmodified to a leaf whose actual signature key is
 *   the FIRST keypair. No byte is flipped in this mode — the envelope stays
 *   a structurally valid, correctly-signed proof. This models
 *   a proof carried across a signature-key rotation: per D-08 it is
 *   cryptographically indistinguishable from a corrupt proof, because the
 *   104-byte envelope stores no MLS signature key (the key is a signed
 *   input, recoverable only by reconstructing the event), so it correctly
 *   surfaces as `invalid-proof`, not a distinct "stale" reason.
 */
export async function forgeKeyPackage(args: {
  account: ReturnType<typeof testAccount>;
  ciphersuiteImpl: CiphersuiteImpl;
  proof: "missing" | "tampered" | "stale";
}): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const { account, ciphersuiteImpl, proof } = args;
  const signatureKeyPair = await ciphersuiteImpl.signature.keygen();

  let leafNodeExtensions: CustomExtension[];
  if (proof === "missing") {
    leafNodeExtensions = [];
  } else if (proof === "tampered") {
    const validProof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: signatureKeyPair.publicKey,
      ciphersuite: ciphersuiteImpl.id,
      createdAt: FORGE_CREATED_AT,
    });
    leafNodeExtensions = [
      makeLeafAppComponentsExtension(tamperLastByte(validProof)),
    ];
  } else {
    const otherSignatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const staleProof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: otherSignatureKeyPair.publicKey,
      ciphersuite: ciphersuiteImpl.id,
      createdAt: FORGE_CREATED_AT,
    });
    leafNodeExtensions = [makeLeafAppComponentsExtension(staleProof)];
  }

  return generateKeyPackageWithKey({
    credential: createCredential(account.pubkey),
    capabilities: defaultCapabilities(),
    lifetime: createDefaultKeyPackageLifetime(),
    signatureKeyPair,
    cipherSuite: ciphersuiteImpl,
    leafNodeExtensions,
  });
}

/**
 * Builds a wire-valid `AppDataUpdate` proposal that rewrites the group's
 * `app_components` (`0x0001`) required-component list to drop
 * `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` (`0x8009`) — the "commit that drops
 * the `0x8009` requirement" fixture (D-04). ts-mls itself has no concept of
 * required ids and applies this generically; only the Marmot-layer
 * `validateCommitAccountIdentityProofs`/`validateCommitLegality` (and, before
 * this phase, `validateAppComponentIntegrity`'s protected-set rule) reject
 * it.
 */
export function dropAccountIdentityProofRequirement(
  state: ClientState,
): Proposal {
  const currentIds = getAppComponents(state.groupContext.extensions) ?? [];
  const withoutProof = currentIds.filter(
    (id) => id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  );
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: APP_COMPONENTS_COMPONENT_ID,
      operation: "update",
      update: encodeComponentsList(withoutProof),
    },
  };
}

/**
 * Returns a shallow-cloned `ClientState` whose `ratchetTree` is a copied
 * array with the node at `leafIndex * 2` replaced by a leaf node carrying
 * `leaf`. Does not mutate `state` or its input arrays.
 *
 * This is the Phase 9 (UPD-01, D-11) fixture that makes replacement-leaf
 * identity binding testable at the pure-validator level:
 * `validateCommitAccountIdentityProofs` takes two `ClientState` values, the
 * tree diff (`../../core/components/tree-diff.js`) compares signature bytes,
 * and `validateLeafAccountIdentityProof` never checks the MLS leaf
 * signature — so splicing another member's genuine, fully-valid leaf into a
 * different index produces a changed leaf whose own proof is valid but whose
 * account identity differs from the prior occupant's.
 *
 * This fixture is deliberately NOT wire-valid (the spliced leaf's signature
 * does not cover its new tree position) and must never be fed through
 * `processMessage`, which verifies leaf signatures and would reject it
 * first — a seam test built on it would pass for the wrong reason.
 */
export function spliceLeafAtIndex(
  state: ClientState,
  leafIndex: number,
  leaf: LeafNode,
): ClientState {
  const ratchetTree = [...state.ratchetTree];
  ratchetTree[leafIndex * 2] = { nodeType: nodeTypes.leaf, leaf };
  return { ...state, ratchetTree };
}

/**
 * Returns a copy of `leaf` whose `extensions` array has every
 * `app_data_dictionary` entry removed, so the leaf carries no `0x8009`
 * support or data. Does not mutate the input.
 *
 * This is the UPD-03 fixture plan 09-04 consumes.
 */
export function stripLeafAccountIdentityProof(leaf: LeafNode): LeafNode {
  return {
    ...leaf,
    extensions: leaf.extensions.filter(
      (ext) => ext.extensionType !== appDataDictionaryExtensionType,
    ),
  };
}
