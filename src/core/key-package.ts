import {
  Capabilities,
  Credential,
  CryptoProvider,
  CiphersuiteId,
  CiphersuiteImpl,
  defaultCredentialTypes,
  defaultCryptoProvider,
  CustomExtension,
  encode,
  KeyPackage,
  keyPackageEncoder,
  generateKeyPackage as MLSGenerateKeyPackage,
  Lifetime,
  PrivateKeyPackage,
} from "ts-mls";

import { createThreeMonthLifetime } from "../utils/timestamp.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { getCredentialPubkey } from "./credential.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { ensureLastResortExtension } from "./extensions.js";

async function makeKeyPackageRef(
  value: KeyPackage,
  hash: CiphersuiteImpl["hash"],
): Promise<Uint8Array> {
  // `ts-mls` still implements this helper internally in keyPackage.ts, but it is
  // not re-exported from the package root in rc.9. This mirrors upstream logic.
  const label = new TextEncoder().encode("MLS 1.0 KeyPackage Reference");
  const encoded = encode(keyPackageEncoder, value);
  const payload = new Uint8Array(label.length + encoded.length);
  payload.set(label, 0);
  payload.set(encoded, label.length);
  return await hash.digest(payload);
}

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
  // In v2, keyPackage.cipherSuite is a numeric ciphersuite id.
  // Prefer id-first handling to avoid reverse mapping name<->id for correctness.
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
  ciphersuiteImpl: CiphersuiteImpl;
};

/** Generate a marmot key package that is compliant with MIP-00 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  isLastResort = true,
  ciphersuiteImpl,
}: GenerateKeyPackageOptions): Promise<CompleteKeyPackage> {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error("Marmot key packages must use a basic credential");

  // Ensure the credential has a valid pubkey
  getCredentialPubkey(credential);

  // In v2, generateKeyPackage takes a single params object
  return await MLSGenerateKeyPackage({
    credential,
    capabilities: capabilities
      ? ensureMarmotCapabilities(capabilities)
      : defaultCapabilities(),
    lifetime: lifetime ?? createThreeMonthLifetime(),
    // Marmot requires support for last_resort capability signaling (MIP-00),
    // but individual KeyPackages may be single-use or last-resort reusable.
    // `isLastResort` controls whether this KeyPackage is marked reusable.
    extensions: isLastResort
      ? ensureLastResortExtension(extensions ?? [])
      : extensions,
    cipherSuite: ciphersuiteImpl,
  });
}
