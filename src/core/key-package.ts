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
  generateKeyPackage as MLSGenerateKeyPackage,
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
import {
  type AccountIdentityProofSigner,
  buildAccountIdentityProofExtension,
} from "./account-identity-proof.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { makeLeafAppComponentsExtension } from "./components/index.js";
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
   * Optional Nostr-account signer. When provided, the generated key package
   * carries a `marmot.account-identity-proof.v1` LeafNode extension binding the
   * credential's Nostr account to the leaf signature key — required for wire
   * interop with darkmatter, which validates this proof on every leaf.
   */
  accountProofSigner?: AccountIdentityProofSigner;
  ciphersuiteImpl: CiphersuiteImpl;
};

/** Generate a marmot key package that is compliant with MIP-00 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  isLastResort = true,
  accountProofSigner,
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
  // Advertise the supported app components on the LeafNode so this member can
  // be added to groups that require them (matches darkmatter's leaf state).
  const leafNodeExtensions: CustomExtension[] = [
    makeLeafAppComponentsExtension(),
  ];

  // When an account signer is supplied, generate the leaf signature keypair
  // first, bind it to the Nostr account with an identity proof, and carry the
  // proof on the LeafNode (darkmatter validates this on every leaf).
  if (accountProofSigner) {
    const signatureKeyPair = await ciphersuiteImpl.signature.keygen();
    leafNodeExtensions.push(
      await buildAccountIdentityProofExtension({
        accountIdentity: hexToBytes(accountPubkey),
        mlsSignaturePublicKey: signatureKeyPair.publicKey,
        ciphersuite: ciphersuiteImpl.id,
        signer: accountProofSigner,
      }),
    );
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

  // In v2, generateKeyPackage takes a single params object
  return await MLSGenerateKeyPackage({
    credential,
    capabilities: resolvedCapabilities,
    lifetime: resolvedLifetime,
    extensions: resolvedExtensions,
    leafNodeExtensions,
    cipherSuite: ciphersuiteImpl,
  });
}
