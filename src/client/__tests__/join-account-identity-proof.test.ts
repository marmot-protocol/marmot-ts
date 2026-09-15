/**
 * `joinFromWelcome` account identity proof profile enforcement (CUT-02, D-07):
 * joining accepts a current-profile group and rejects a mixed-profile group or
 * a group whose member proof is invalid, persisting nothing in either case
 * (T-07-26, T-07-27).
 */
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  createCommit,
  defaultCryptoProvider,
  defaultExtensionTypes,
  defaultProposalTypes,
  getCiphersuiteImpl,
  generateKeyPackageWithKey,
  selfRemoveProposalType,
  type CiphersuiteImpl,
  type ExtensionRequiredCapabilities,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";

import { MarmotClient } from "../marmot-client.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  dropAccountIdentityProofRequirement,
  forgeKeyPackage,
} from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { marmotAuthService } from "../../core/auth-service.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
import { createGroup, createSimpleGroup } from "../../core/group.js";
import {
  calculateKeyPackageRef,
  generateKeyPackage,
} from "../../core/key-package.js";
import {
  classifyGroupAccountIdentityProofProfile,
  produceAccountIdentityProof,
} from "../../core/components/account-identity-proof.js";
import { makeLeafAppComponentsExtension } from "../../core/components/dictionary.js";
import {
  adminPolicyEntry,
  groupProfileEntry,
} from "../../core/components/index.js";
import { createDefaultKeyPackageLifetime } from "../../utils/timestamp.js";
import type { StoredKeyPackage } from "../key-package-manager.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
// Legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`) -- referenced only as a literal to build a mixed-profile
// required_capabilities extension (CUT-01: no import from the legacy module).
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

describe("joinFromWelcome account identity proof profile (CUT-02, D-07)", () => {
  let ciphersuiteImpl: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let inviteeGroupStateStore: InMemoryKeyValueStore<SerializedClientState>;
  let inviteeClient: MarmotClient;

  beforeEach(async () => {
    ciphersuiteImpl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    mockNetwork = new MockNetwork();
    inviteeGroupStateStore = new InMemoryKeyValueStore<SerializedClientState>();
    const inviteeAccount = testAccount(9);
    inviteeClient = new MarmotClient({
      groupStateStore: inviteeGroupStateStore,
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: inviteeAccount.signer,
      network: mockNetwork,
    });
  });

  /** Adds `inviteeKeyPackage` to `state` via a real MLS commit, returning the Welcome. */
  async function commitInviteeAdd(
    state: Awaited<ReturnType<typeof createSimpleGroup>>["clientState"],
    inviteeKeyPackage: Awaited<
      ReturnType<typeof generateKeyPackage>
    >["publicPackage"],
  ) {
    const add = await createCommit({
      context: { cipherSuite: ciphersuiteImpl, authService: marmotAuthService },
      state,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: inviteeKeyPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    return add.welcome!.welcome!;
  }

  async function joinAsInvitee(
    welcome: Awaited<ReturnType<typeof commitInviteeAdd>>,
    inviteeKp: Awaited<ReturnType<typeof generateKeyPackage>>,
  ) {
    const keyPackageRef = await calculateKeyPackageRef(inviteeKp.publicPackage);
    return inviteeClient.groups.joinFromWelcome({
      welcome,
      candidates: [
        {
          publicPackage: inviteeKp.publicPackage,
          privatePackage: inviteeKp.privatePackage,
          keyPackageRef,
          hasMatchingSecret: true,
        },
      ],
      ciphersuiteImpl,
    });
  }

  it("joins a current-profile group", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Current",
      { adminPubkeys: [adminAccount.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    const { group } = await joinAsInvitee(welcome, inviteeKp);

    expect(
      classifyGroupAccountIdentityProofProfile(
        group.state.groupContext.extensions,
      ),
    ).toBe("current");
  });

  it("GRP-03: rejects a Welcome into a group that does not require 0x8009 without persisting it", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "No Requirement",
      { adminPubkeys: [adminAccount.pubkey] },
    );

    // ts-mls itself has no concept of a "required" component id and accepts
    // this AppDataUpdate generically; only the Marmot-layer join gate refuses
    // a group outside the current profile.
    const dropRequirement = await createCommit({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
      },
      state: clientState,
      wireAsPublicMessage: false,
      extraProposals: [dropAccountIdentityProofRequirement(clientState)],
      ratchetTreeExtension: true,
    });
    const droppedState = dropRequirement.newState;
    expect(
      classifyGroupAccountIdentityProofProfile(
        droppedState.groupContext.extensions,
      ),
    ).toBe("neither");

    const welcome = await commitInviteeAdd(
      droppedState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "missing-requirement",
    });
    expect(await inviteeGroupStateStore.keys()).toEqual([]);
  });

  it("GRP-03: rejects a Welcome when a current non-creator member's proof is invalid without persisting it", async () => {
    const adminAccount = testAccount(6);
    const badMemberAccount = testAccount(1);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Bad Member Proof",
      { adminPubkeys: [adminAccount.pubkey] },
    );

    const badKp = await forgeKeyPackage({
      account: badMemberAccount,
      ciphersuiteImpl,
      proof: "tampered",
    });
    const addBadMember = await createCommit({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
      },
      state: clientState,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: badKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const stateWithBadMember = addBadMember.newState;

    const welcome = await commitInviteeAdd(
      stateWithBadMember,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
    });
    expect(await inviteeGroupStateStore.keys()).toEqual([]);
  });

  it("GRP-03: rejects a group that requires both 0xf2f1 and 0x8009 (mixed profile) without persisting it", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);

    // Both leaves must advertise the legacy 0xf2f1 extension too, so MLS's
    // own capability-negotiation check (independent of the account-identity-
    // proof profile check) passes when the group's required_capabilities
    // names it.
    const mixedCapabilities = {
      ...defaultCapabilities(),
      extensions: [
        ...defaultCapabilities().extensions,
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ],
    };

    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      capabilities: mixedCapabilities,
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      capabilities: mixedCapabilities,
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const mixedRequiredCapabilities: ExtensionRequiredCapabilities = {
      extensionType: defaultExtensionTypes.required_capabilities,
      extensionData: {
        extensionTypes: [
          appDataDictionaryExtensionType,
          LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
        ].sort((a, b) => a - b),
        proposalTypes: [appDataUpdateProposalType, selfRemoveProposalType].sort(
          (a, b) => a - b,
        ),
        credentialTypes: [],
      },
    };

    const { clientState } = await createGroup({
      creatorKeyPackage: adminKp,
      components: [
        groupProfileEntry({ name: "Mixed", description: "" }),
        adminPolicyEntry([adminAccount.pubkey]),
      ],
      extensions: [mixedRequiredCapabilities],
      ciphersuiteImpl,
    });
    // Sanity: the group we just built really is mixed-profile at the source.
    expect(
      classifyGroupAccountIdentityProofProfile(
        clientState.groupContext.extensions,
      ),
    ).toBe("mixed");

    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "mixed-profile",
    });
    expect(await inviteeGroupStateStore.keys()).toEqual([]);
  });

  it("GRP-03: rejects a group whose creator leaf carries a proof bound to a different signature key", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);

    // A structurally valid leaf (MLS-legal), but its 0x8009 proof is signed
    // for a completely different, unrelated MLS signature key.
    const realSignatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const unrelatedSignatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const mismatchedProof = await produceAccountIdentityProof({
      signer: adminAccount.signer,
      accountIdentity: hexToBytes(adminAccount.pubkey),
      mlsSignatureKey: unrelatedSignatureKeyPair.publicKey,
      ciphersuite: ciphersuiteImpl.id,
    });
    const adminKp = await generateKeyPackageWithKey({
      credential: createCredential(adminAccount.pubkey),
      capabilities: defaultCapabilities(),
      lifetime: createDefaultKeyPackageLifetime(),
      signatureKeyPair: realSignatureKeyPair,
      cipherSuite: ciphersuiteImpl,
      leafNodeExtensions: [makeLeafAppComponentsExtension(mismatchedProof)],
    });

    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Bad Creator Proof",
      { adminPubkeys: [adminAccount.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "invalid-proof",
    });
    expect(await inviteeGroupStateStore.keys()).toEqual([]);
  });
});
