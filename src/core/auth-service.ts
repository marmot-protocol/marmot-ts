import {
  AuthenticationService,
  Credential,
  defaultCredentialTypes,
} from "ts-mls";

/**
 * Marmot Authentication Service
 *
 * Implements the application-level identity validation logic for Marmot.
 * This service is injected into the ClientState at runtime.
 */
export const marmotAuthService: AuthenticationService = {
  async validateCredential(
    credential: Credential,
    _signaturePublicKey: Uint8Array,
  ): Promise<boolean> {
    // 1. Check if credential type is 'basic' (Marmot uses basic credentials)
    if (credential.credentialType !== defaultCredentialTypes.basic)
      return false;

    // 2. Extract the Nostr pubkey from the credential identity
    // const nostrPubkey = credential.identity;

    // 3. Verify that the signaturePublicKey belongs to the Nostr identity
    // NOTE: In MLS, the library handles the cryptographic signature verification
    // of the LeafNode using the signaturePublicKey.
    // This hook is for application-level identity validation.
    // For now, we accept all valid basic credentials.

    return true;
  },
};
