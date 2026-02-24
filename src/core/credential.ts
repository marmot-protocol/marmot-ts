import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Credential, CredentialBasic } from "ts-mls/credential.js";
import { defaultCredentialTypes, encode } from "ts-mls";
import { credentialEncoder } from "ts-mls/credential.js";

export function isHexKey(str: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(str);
}

/** Creates a MLS basic credential from a nostr public key. */
export function createCredential(pubkey: string): CredentialBasic {
  if (isHexKey(pubkey) === false)
    throw new Error("Invalid nostr public key, must be 64 hex characters");

  return {
    credentialType: defaultCredentialTypes.basic,
    identity: hexToBytes(pubkey),
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

  // NOTE: assuming the encoding is deterministic
  return (
    bytesToHex(encode(credentialEncoder, a)) ===
    bytesToHex(encode(credentialEncoder, b))
  );
}
