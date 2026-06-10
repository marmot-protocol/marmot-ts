import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import {
  type AccountIdentityProofSigner,
  signAccountIdentityProof,
} from "../../core/account-identity-proof.js";

/**
 * Builds an {@link AccountIdentityProofSigner} from a test `PrivateKeyAccount`.
 *
 * Every Marmot KeyPackage/leaf MUST carry a valid account identity proof, so
 * test clients and key packages need a signer that signs the proof digest with
 * the account's Nostr secret key (BIP-340). `PrivateKeyAccount` exposes the raw
 * key at `account.signer.key`.
 */
export function accountProofSignerFor(
  account: PrivateKeyAccount<any>,
): AccountIdentityProofSigner {
  const secretKey = account.signer.key;
  return (request) => signAccountIdentityProof(request, secretKey);
}
