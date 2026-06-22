import type { PrivateKeyAccount } from "applesauce-accounts/accounts";

import {
  type AccountIdentityProofSigner,
  signAccountIdentityProof,
} from "@internet-privacy/marmot-ts";

/**
 * Builds an {@link AccountIdentityProofSigner} from a local `PrivateKeyAccount`.
 *
 * Every Marmot v2 KeyPackage/leaf MUST carry a valid account identity proof
 * (BIP-340 over the account's Nostr key) or a spec-conformant peer rejects the
 * membership. The applesauce `EventSigner` cannot sign the proof digest, so we
 * reach for the raw secret the account exposes at `account.signer.key`.
 */
export function accountProofSignerFor(
  account: PrivateKeyAccount<any>,
): AccountIdentityProofSigner {
  const secretKey = account.signer.key;
  return (request) => signAccountIdentityProof(request, secretKey);
}
