/**
 * Tests that the invite proposal verifies a Marmot account identity proof when
 * the invitee's LeafNode carries one, and rejects a forged proof.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  signAccountIdentityProof,
} from "../../../../core/account-identity-proof.js";
import { createCredential } from "../../../../core/credential.js";
import { generateKeyPackage } from "../../../../core/key-package.js";
import type { ProposalContext } from "../../marmot-group.js";
import { proposeInviteUser } from "../invite-user.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

async function keyPackageWithProof(
  impl: CiphersuiteImpl,
  secretKey: Uint8Array,
) {
  const credential = createCredential(
    bytesToHex(schnorr.getPublicKey(secretKey)),
  );
  return generateKeyPackage({
    credential,
    ciphersuiteImpl: impl,
    accountProofSigner: (request) =>
      signAccountIdentityProof(request, secretKey),
  });
}

describe("proposeInviteUser account identity proof verification", () => {
  it("accepts an invitee whose leaf carries a valid proof", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(5);
    secretKey[31] = 11;
    const kp = await keyPackageWithProof(impl, secretKey);

    const action = proposeInviteUser(kp.publicPackage);
    const proposal = await action({ ciphersuite: impl } as ProposalContext);
    expect(proposal.proposalType).toBeDefined();
    expect(proposal.add.keyPackage).toBe(kp.publicPackage);
  });

  it("rejects an invitee whose proof signature is forged", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(6);
    secretKey[31] = 13;
    const kp = await keyPackageWithProof(impl, secretKey);

    // Tamper a byte of the proof extension's signature.
    const proofExt = kp.publicPackage.leafNode.extensions.find(
      (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    )!;
    proofExt.extensionData[proofExt.extensionData.length - 1] ^= 0xff;

    const action = proposeInviteUser(kp.publicPackage);
    await expect(
      action({ ciphersuite: impl } as ProposalContext),
    ).rejects.toThrow();
  });

  it("allows a legacy invitee with no proof extension", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const credential = createCredential("a".repeat(64));
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
    // No accountProofSigner → leaf carries no proof extension.
    expect(
      kp.publicPackage.leafNode.extensions.some(
        (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ),
    ).toBe(false);

    const action = proposeInviteUser(kp.publicPackage);
    await expect(
      action({ ciphersuite: impl } as ProposalContext),
    ).resolves.toBeDefined();
  });
});
