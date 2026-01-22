import { CryptoProvider, defaultCryptoProvider } from "ts-mls";
import { Capabilities } from "ts-mls/capabilities.js";
import { Credential } from "ts-mls/credential.js";
import {
  CiphersuiteImpl,
  getCiphersuiteFromName,
} from "ts-mls/crypto/ciphersuite.js";
import { Extension } from "ts-mls/extension.js";
import {
  KeyPackage,
  generateKeyPackage as MLSGenerateKeyPackage,
  PrivateKeyPackage,
  makeKeyPackageRef,
} from "ts-mls/keyPackage.js";
import { Lifetime } from "ts-mls/lifetime.js";

import { createThreeMonthLifetime } from "../utils/timestamp.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
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
export function keyPackageDefaultExtensions(): Extension[] {
  return ensureLastResortExtension([]);
}

/** Calculates a key package reference with the hash implementation based on the key package's cipher suite */
export async function calculateKeyPackageRef(
  keyPackage: KeyPackage,
  cryptoProvider?: CryptoProvider,
): Promise<Uint8Array> {
  const ciphersuite = getCiphersuiteFromName(keyPackage.cipherSuite);
  const ciphersuiteImpl = await (
    cryptoProvider ?? defaultCryptoProvider
  ).getCiphersuiteImpl(ciphersuite);
  return await makeKeyPackageRef(keyPackage, ciphersuiteImpl.hash);
}

/** Options for generating a marmot key package */
export type GenerateKeyPackageOptions = {
  credential: Credential;
  capabilities?: Capabilities;
  lifetime?: Lifetime;
  extensions?: Extension[];
  ciphersuiteImpl: CiphersuiteImpl;
};

/** Generate a marmot key package that is compliant with MIP-00 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  ciphersuiteImpl,
}: GenerateKeyPackageOptions): Promise<CompleteKeyPackage> {
  if (credential.credentialType !== "basic")
    throw new Error("Marmot key packages must use a basic credential");

  // Ensure the credential has a valid pubkey
  getCredentialPubkey(credential);

  return await MLSGenerateKeyPackage(
    credential,
    capabilities
      ? ensureMarmotCapabilities(capabilities)
      : defaultCapabilities(),
    lifetime ?? createThreeMonthLifetime(),
    extensions
      ? ensureLastResortExtension(extensions)
      : keyPackageDefaultExtensions(),
    ciphersuiteImpl,
  );
}
