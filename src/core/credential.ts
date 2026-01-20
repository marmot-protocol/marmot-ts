import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  Credential,
  CredentialBasic,
  credentialEncoder,
  isDefaultCredential,
} from "ts-mls/credential.js";
import { defaultCredentialTypes, encode } from "ts-mls";

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

const legacyDecoder = new TextDecoder();

/** Gets the nostr public key from a credential. */
export function getCredentialPubkey(credential: Credential): string {
  if (
    !isDefaultCredential(credential) ||
    credential.credentialType !== defaultCredentialTypes.basic
  )
    throw new Error(
      "Credential is not a basic credential, cannot get nostr public key",
    );

  const basicCredential = credential as CredentialBasic;

  const str = bytesToHex(basicCredential.identity);

  // Backwards compatibility with utf8 encoded public keys
  if (isHexKey(str) === false) {
    const decoded = legacyDecoder.decode(basicCredential.identity);
    if (isHexKey(decoded) === false)
      throw new Error("Invalid credential nostr public key");
    return decoded;
  }

  return str;
}

/** Checks if two credentials are the same. */
export function isSameCredential(a: Credential, b: Credential): boolean {
  // If they are basic credentials, we can just compare the identities
  const aIsBasic =
    isDefaultCredential(a) && a.credentialType === defaultCredentialTypes.basic;
  const bIsBasic =
    isDefaultCredential(b) && b.credentialType === defaultCredentialTypes.basic;

  if (aIsBasic && bIsBasic) {
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
