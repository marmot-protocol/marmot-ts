import {
  AuthenticationService,
  Credential,
  CredentialBasic,
  defaultCredentialTypes,
} from "ts-mls";

/** Marmot credential policy (MIP-00): `basic` credential with 32-byte identity. */
export const marmotAuthService: AuthenticationService = {
  async validateCredential(
    credential: Credential,
    _signaturePublicKey: Uint8Array,
  ): Promise<boolean> {
    if (credential.credentialType !== defaultCredentialTypes.basic)
      return false;

    const basic = credential as CredentialBasic;
    if (!(basic.identity instanceof Uint8Array)) return false;
    if (basic.identity.length !== 32) return false;

    return true;
  },
};
