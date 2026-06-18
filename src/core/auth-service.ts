import {
  AuthenticationService,
  Credential,
  CredentialBasic,
  defaultCredentialTypes,
} from "ts-mls";

import { isValidAccountIdentity } from "./credential.js";

/**
 * Marmot credential policy (MIP-00 / `foundation/identity.md`): a `basic`
 * credential whose identity is a valid 32-byte x-only secp256k1 public key.
 * Rejecting non-curve identities here is the inbound gate that stops a peer
 * adding a member whose account identity is not a real Nostr pubkey.
 */
export const marmotAuthService: AuthenticationService = {
  async validateCredential(
    credential: Credential,
    _signaturePublicKey: Uint8Array,
  ): Promise<boolean> {
    if (credential.credentialType !== defaultCredentialTypes.basic)
      return false;

    const basic = credential as CredentialBasic;
    if (!(basic.identity instanceof Uint8Array)) return false;
    return isValidAccountIdentity(basic.identity);
  },
};
