/**
 * Tests that the invite proposal validates the invitee's `0x8009` account
 * identity proof (PROOF-04, PROOF-05, CUT-02, D-16), rejecting every failure
 * mode with a typed `AccountIdentityProofError` and exact reason.
 */
import {
  type CiphersuiteImpl,
  CustomExtension,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  makeAppDataDictionaryExtension,
  makeCustomExtension,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import {
  appComponentsEntry,
  buildAppDataDictionary,
  componentEntry,
} from "../../../../core/components/dictionary.js";
import { encodeComponentsList } from "../../../../core/components/app-components-list.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "../../../../core/components/ids.js";
import { createCredential } from "../../../../core/credential.js";
import { generateKeyPackage } from "../../../../core/key-package.js";
import type { ProposalContext } from "../../marmot-group.js";
import { proposeInviteUser } from "../invite-user.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
const OTHER_SUITE = "MLS_128_DHKEMP256_AES128GCM_SHA256_P256" as const;

async function keyPackageWithProof(
  impl: CiphersuiteImpl,
  secretKey: Uint8Array,
) {
  const account = PrivateKeyAccount.fromKey(secretKey);
  const credential = createCredential(account.pubkey);
  return generateKeyPackage({
    credential,
    ciphersuiteImpl: impl,
    signer: account.signer,
  });
}

/** Rebuilds the leaf's app_data_dictionary extension from raw entries, bypassing every builder-time guard (used to construct malformed fixtures). */
function rebuildLeafDictionary(
  entries: Parameters<typeof buildAppDataDictionary>[0],
): CustomExtension {
  return makeAppDataDictionaryExtension(buildAppDataDictionary(entries));
}

function findProofEntry(kp: Awaited<ReturnType<typeof keyPackageWithProof>>) {
  const dictExt = kp.publicPackage.leafNode.extensions[0]!;
  return dictExt;
}

async function rejects(
  action: ReturnType<typeof proposeInviteUser>,
  ctx: ProposalContext,
  reason: string,
) {
  await expect(action(ctx)).rejects.toMatchObject({
    name: "AccountIdentityProofError",
    reason,
  });
}

describe("proposeInviteUser account identity proof verification", () => {
  it("accepts an invitee whose leaf carries a valid 0x8009 proof", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(5);
    secretKey[31] = 11;
    const kp = await keyPackageWithProof(impl, secretKey);

    const action = proposeInviteUser(kp.publicPackage);
    const proposal = await action({ ciphersuite: impl } as ProposalContext);
    expect(proposal.proposalType).toBeDefined();
    expect(proposal.add.keyPackage).toBe(kp.publicPackage);
  });

  it("rejects an invitee whose 0x8009 proof signature is tampered (invalid-proof)", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(6);
    secretKey[31] = 13;
    const kp = await keyPackageWithProof(impl, secretKey);

    // Tamper a byte of the proof entry's signature, then rebuild the whole
    // dictionary with the mutated bytes (validators re-decode the dictionary
    // from scratch, so mutating extensionData in place is not sufficient).
    const dictExt = findProofEntry(kp);
    const proofOffset = dictExt.extensionData.length - 1;
    const tamperedDictionaryBytes = Uint8Array.from(dictExt.extensionData);
    tamperedDictionaryBytes[proofOffset] ^= 0xff;
    kp.publicPackage.leafNode.extensions = [
      makeCustomExtension({
        extensionType: dictExt.extensionType,
        extensionData: tamperedDictionaryBytes,
      }),
    ];

    const action = proposeInviteUser(kp.publicPackage);
    await rejects(
      action,
      { ciphersuite: impl } as ProposalContext,
      "invalid-proof",
    );
  });

  it("rejects an invitee whose dictionary lacks the 0x8009 data entry (missing-data)", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(7);
    secretKey[31] = 17;
    const kp = await keyPackageWithProof(impl, secretKey);

    // Support list still names 0x8009 (so the "missing-support" check passes),
    // but there is no keyed 0x8009 data entry.
    kp.publicPackage.leafNode.extensions = [
      rebuildLeafDictionary([
        appComponentsEntry([
          APP_COMPONENTS_COMPONENT_ID,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        ]),
        componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      ]),
    ];

    const action = proposeInviteUser(kp.publicPackage);
    await rejects(
      action,
      { ciphersuite: impl } as ProposalContext,
      "missing-data",
    );
  });

  it("rejects an invitee whose leaf carries only the legacy 0xf2f1 extension (legacy-extension-present)", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(8);
    secretKey[31] = 19;
    const kp = await keyPackageWithProof(impl, secretKey);

    kp.publicPackage.leafNode.extensions = [
      makeCustomExtension({
        extensionType: 0xf2f1,
        extensionData: new Uint8Array(104),
      }),
    ];

    const action = proposeInviteUser(kp.publicPackage);
    await rejects(
      action,
      { ciphersuite: impl } as ProposalContext,
      "legacy-extension-present",
    );
  });

  it("rejects an invitee with a KeyPackage-level 0x8009 dictionary (invalid-location)", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const secretKey = new Uint8Array(32).fill(9);
    secretKey[31] = 23;
    const kp = await keyPackageWithProof(impl, secretKey);

    // A valid leaf, but the KeyPackage's own (not the leaf's) extensions
    // carry a dictionary with a 0x8009 entry -- PROOF-05.
    kp.publicPackage.extensions = [
      ...kp.publicPackage.extensions,
      rebuildLeafDictionary([
        componentEntry(
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          new Uint8Array(104),
        ),
      ]),
    ];

    const action = proposeInviteUser(kp.publicPackage);
    await rejects(
      action,
      { ciphersuite: impl } as ProposalContext,
      "invalid-location",
    );
  });

  it("rejects an invitee whose ciphersuite differs from the group's (ciphersuite-mismatch)", async () => {
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const otherImpl = await getCiphersuiteImpl(
      OTHER_SUITE,
      defaultCryptoProvider,
    );
    const secretKey = new Uint8Array(32).fill(10);
    secretKey[31] = 29;
    const kp = await keyPackageWithProof(impl, secretKey);

    const action = proposeInviteUser(kp.publicPackage);
    await rejects(
      action,
      { ciphersuite: otherImpl } as ProposalContext,
      "ciphersuite-mismatch",
    );
  });
});
