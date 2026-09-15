/**
 * Shared account-identity-proof (`0x8009`) forged fixtures for plan
 * 08-01..08-04: a wire-valid but Marmot-layer-invalid `KeyPackage` (missing or
 * tampered proof), and a wire-valid commit proposal that drops the `0x8009`
 * requirement from a group's `app_components` list.
 *
 * Test-only: `__tests__` is excluded from `tsconfig.build.json` and never
 * published.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  appDataUpdateProposalType,
  generateKeyPackageWithKey,
  type CiphersuiteImpl,
  type ClientState,
  type CustomExtension,
  type KeyPackage,
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
 * leaf carries no proof, or a proof tampered after signing.
 *
 * - `proof: "missing"`: the leaf carries no `app_data_dictionary` extension
 *   at all, so it has no `0x8009` entry.
 * - `proof: "tampered"`: the leaf carries a real, correctly-bound
 *   `0x8009` proof (same account, same MLS signature key, same ciphersuite,
 *   fixed `createdAt`) with its last byte flipped — a structurally valid
 *   envelope whose BIP-340 signature no longer verifies.
 */
export async function forgeKeyPackage(args: {
  account: ReturnType<typeof testAccount>;
  ciphersuiteImpl: CiphersuiteImpl;
  proof: "missing" | "tampered";
}): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const { account, ciphersuiteImpl, proof } = args;
  const signatureKeyPair = await ciphersuiteImpl.signature.keygen();

  let leafNodeExtensions: CustomExtension[];
  if (proof === "missing") {
    leafNodeExtensions = [];
  } else {
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
