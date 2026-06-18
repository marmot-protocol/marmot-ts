/** @module @category Core - Credentials */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Credential, CredentialBasic, defaultCredentialTypes } from "ts-mls";

export function isHexKey(str: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(str);
}

/**
 * Whether `identity` is a valid Marmot account identity: exactly 32 bytes and a
 * valid x-only secp256k1 public key (it lifts to a point on the curve via
 * BIP-340 `lift_x`). `foundation/identity.md`: "clients reject credentials whose
 * identity is not a valid x-only secp256k1 public key." Mirrors darkmatter
 * `validate_credential_identity` (`k256::schnorr::VerifyingKey::from_bytes`).
 */
export function isValidAccountIdentity(identity: Uint8Array): boolean {
  if (identity.length !== 32) return false;
  try {
    // lift_x: an x-only key is valid iff its x-coordinate is < the field prime
    // and lies on the curve. Parsing it as a compressed point (even-y prefix)
    // performs exactly that check; an invalid x throws.
    secp256k1.Point.fromHex(`02${bytesToHex(identity)}`);
    return true;
  } catch {
    return false;
  }
}

/** Creates a MLS basic credential from a nostr public key. */
export function createCredential(pubkey: string): CredentialBasic {
  if (isHexKey(pubkey) === false)
    throw new Error("Invalid nostr public key, must be 64 hex characters");

  const identity = hexToBytes(pubkey);
  if (!isValidAccountIdentity(identity))
    throw new Error(
      "Invalid nostr public key: not a valid x-only secp256k1 public key",
    );

  return {
    credentialType: defaultCredentialTypes.basic,
    identity,
  };
}

/** Gets the nostr public key from a credential. */
export function getCredentialPubkey(credential: Credential): string {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error(
      "Credential is not a basic credential, cannot get nostr public key",
    );

  // Type assertion needed because TypeScript doesn't narrow credential type
  const basicCredential = credential as CredentialBasic;
  const str = bytesToHex(basicCredential.identity);

  // Marmot requires identity to be the raw 32-byte Nostr pubkey.
  // If this is not 32 bytes, bytesToHex() will not yield 64 hex chars.
  if (isHexKey(str) === false)
    throw new Error("Invalid credential nostr public key");

  return str;
}

/** Checks if two credentials are the same. */
export function isSameCredential(a: Credential, b: Credential): boolean {
  // If they are basic credentials, we can just compare the identities
  if (
    a.credentialType === defaultCredentialTypes.basic &&
    b.credentialType === defaultCredentialTypes.basic
  ) {
    const aBasic = a as CredentialBasic;
    const bBasic = b as CredentialBasic;
    return bytesToHex(aBasic.identity) === bytesToHex(bBasic.identity);
  }
  return false;
}
