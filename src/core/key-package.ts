/** @module @category Core - Key Package */
import {
  Capabilities,
  Credential,
  CryptoProvider,
  CiphersuiteId,
  CiphersuiteImpl,
  defaultCredentialTypes,
  defaultCryptoProvider,
  CustomExtension,
  KeyPackage,
  generateKeyPackageWithKey as MLSGenerateKeyPackageWithKey,
  Lifetime,
  makeKeyPackageRef,
  PrivateKeyPackage,
} from "ts-mls";
import { hexToBytes } from "@noble/hashes/utils.js";

import {
  createDefaultKeyPackageLifetime,
  isLifetimeWithinCap,
} from "../utils/timestamp.js";
import type { AuthorizationProofSigner } from "./authorization-proof.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import {
  makeLeafAppComponentsExtension,
  produceAccountIdentityProof,
} from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { ensureLastResortExtension } from "./extensions.js";

/**
 * A complete key package containing both public and private components.
 *
 * The public package can be shared with others to add this participant to groups,
 * while the private package must be kept secret and is used for decryption and signing.
 */
export type CompleteKeyPackage = {
  /** The public key package that can be shared with others */
  publicPackage: KeyPackage;
  /** The private key package that must be kept secret */
  privatePackage: PrivateKeyPackage;
};

/** Create default extensions for a key package */
export function keyPackageDefaultExtensions(): CustomExtension[] {
  return ensureLastResortExtension([]);
}

/** Calculates a key package reference with the hash implementation based on the key package's cipher suite */
export async function calculateKeyPackageRef(
  keyPackage: KeyPackage,
  cryptoProvider?: CryptoProvider,
): Promise<Uint8Array> {
  const provider = cryptoProvider ?? defaultCryptoProvider;
  const ciphersuiteImpl = await provider.getCiphersuiteImpl(
    keyPackage.cipherSuite as CiphersuiteId,
  );
  return await makeKeyPackageRef(keyPackage, ciphersuiteImpl.hash);
}

/** Options for generating a marmot key package */
export type GenerateKeyPackageOptions = {
  credential: Credential;
  capabilities?: Capabilities;
  lifetime?: Lifetime;
  extensions?: CustomExtension[];
  /**
   * Whether to mark this KeyPackage as reusable using the MLS `last_resort` extension.
   *
   * - `true`: include the `last_resort` KeyPackage extension (reusable; helps with race windows)
   * - `false`: omit the extension (single-use; private init_key is expected to be consumed)
   *
   * Default: `true` for backwards compatibility with existing marmot-ts behavior.
   */
  isLastResort?: boolean;
  /**
   * The Nostr account signer that proves this KeyPackage's leaf by signing the
   * kind-450 account identity proof through `signEvent`; its public key MUST
   * equal the credential identity. Any signEvent-capable signer works (a local
   * key signer, NIP-07, NIP-46).
   */
  signer: AuthorizationProofSigner;
  /**
   * Injected `created_at` (Unix seconds) for the account identity proof.
   * Defaults to the current time. Core-only: meant for byte-stable tests and
   * fixtures; the client layer does not expose this option.
   */
  createdAt?: number;
  ciphersuiteImpl: CiphersuiteImpl;
};

/**
 * Generates a Marmot KeyPackage carrying a `0x8009` account identity proof on
 * its LeafNode.
 *
 * @see refs/marmot/foundation/key-packages.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  isLastResort = true,
  signer,
  createdAt,
  ciphersuiteImpl,
}: GenerateKeyPackageOptions): Promise<CompleteKeyPackage> {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error("Marmot key packages must use a basic credential");

  // Ensure the credential has a valid pubkey
  const accountPubkey = getCredentialPubkey(credential);

  const resolvedCapabilities = capabilities
    ? ensureMarmotCapabilities(capabilities)
    : defaultCapabilities();
  const resolvedLifetime = lifetime ?? createDefaultKeyPackageLifetime();
  // WIRE-01 produce path: the cap must hold regardless of how lifetime is
  // supplied. The default is always within cap, so this check only ever
  // rejects an explicit caller-supplied `lifetime` override (D-09).
  if (!isLifetimeWithinCap(resolvedLifetime))
    throw new Error(
      `generateKeyPackage: lifetime range ${resolvedLifetime.notAfter - resolvedLifetime.notBefore}s exceeds the 7,261,200s (84-day) cap`,
    );
  // Marmot requires support for last_resort capability signaling (MIP-00),
  // but individual KeyPackages may be single-use or last-resort reusable.
  // `isLastResort` controls whether this KeyPackage is marked reusable.
  const resolvedExtensions = isLastResort
    ? ensureLastResortExtension(extensions ?? [])
    : (extensions ?? []);

  // Every leaf carries exactly one 0x8009 account identity proof binding the
  // leaf signature key to the Nostr account (refs/marmot/app-components/
  // account-identity-proof-v2.md; refs/marmot/foundation/key-packages.md).
  // The leaf signature keypair is generated first so the proof can bind it.
  const signatureKeyPair = await ciphersuiteImpl.signature.keygen();
  const proof = await produceAccountIdentityProof({
    signer,
    accountIdentity: hexToBytes(accountPubkey),
    mlsSignatureKey: signatureKeyPair.publicKey,
    ciphersuite: ciphersuiteImpl.id,
    createdAt,
  });
  const leafNodeExtensions: CustomExtension[] = [
    makeLeafAppComponentsExtension(proof),
  ];

  return await MLSGenerateKeyPackageWithKey({
    credential,
    capabilities: resolvedCapabilities,
    lifetime: resolvedLifetime,
    extensions: resolvedExtensions,
    signatureKeyPair,
    leafNodeExtensions,
    cipherSuite: ciphersuiteImpl,
  });
}
