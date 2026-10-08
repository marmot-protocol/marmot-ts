/**
 * Groups created before `app_data_dictionary` was made the last GroupContext
 * extension carry [app_data_dictionary, required_capabilities]. ts-mls applies
 * an AppDataUpdate by replacing the dictionary in place and OpenMLS (MDK) by
 * re-appending it, so every rename or admin change in such a group produced a
 * GroupContext MDK computed differently: MDK rejected the commit (confirmation
 * tag mismatch) and the group split.
 *
 * The admin now moves the dictionary last with a GroupContextExtensions
 * proposal in the same commit. Both libraries replace the list first and then
 * update the dictionary where it now sits, so they agree.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  createGroup as mlsCreateGroup,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type Proposal,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { groupProfileEntry } from "../../core/components/dictionary.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

function testPeeler(ciphersuite: CiphersuiteImpl): GroupPeeler<NostrEvent> {
  return {
    async peelGroupMessages(envelopes, state) {
      const { read, unreadable } = await decryptGroupMessages(
        envelopes,
        state,
        ciphersuite,
      );
      return {
        read: read.map(({ event, message }) => ({ envelope: event, message })),
        unreadable,
      };
    },
    wrapGroupMessage(message, state) {
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
}

const rename = (name: string): Proposal => {
  const entry = groupProfileEntry({ name, description: "" });
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: entry.componentId,
      operation: "update",
      update: entry.data,
    },
  };
};

const types = (state: ClientState) =>
  state.groupContext.extensions.map((extension) => extension.extensionType);

/** Admin + member at epoch 1, with the dictionary first or last. */
async function group(order: "legacy" | "current") {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const admin = testAccount(6);
  const adminKp = await generateKeyPackage({
    credential: createCredential(admin.pubkey),
    signer: admin.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: template } = await createSimpleGroup(
    adminKp,
    impl,
    "Old group",
    { adminPubkeys: [admin.pubkey], relays: ["wss://relay.test"] },
  );
  // Rebuild the creation state with an explicit extension order, so the
  // fixture does not depend on what createGroup currently emits.
  const dictionary = template.groupContext.extensions.filter(
    (e) => e.extensionType === appDataDictionaryExtensionType,
  );
  const rest = template.groupContext.extensions.filter(
    (e) => e.extensionType !== appDataDictionaryExtensionType,
  );
  const epoch0 = await mlsCreateGroup({
    context: ctx,
    groupId: randomBytes(32),
    keyPackage: adminKp.publicPackage,
    privateKeyPackage: adminKp.privatePackage,
    extensions:
      order === "legacy" ? [...dictionary, ...rest] : [...rest, ...dictionary],
  });
  const member = testAccount(9);
  const memberKp = await generateKeyPackage({
    credential: createCredential(member.pubkey),
    signer: member.signer,
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return {
    impl,
    adminPubkey: admin.pubkey,
    adminEpoch1: add.newState,
    memberEpoch1,
  };
}

describe("AppDataUpdate in a group whose app_data_dictionary is not last", () => {
  it("moves the dictionary last in the same commit, and a member agrees", async () => {
    const { impl, adminPubkey, adminEpoch1, memberEpoch1 } =
      await group("legacy");
    expect(types(adminEpoch1)[0]).toBe(appDataDictionaryExtensionType);
    const peeler = testPeeler(impl);
    const admin = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const sent = await admin.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [rename("Renamed")],
    });
    if (sent.kind !== "groupEvolution") throw new Error("expected commit");
    const resulting = sent.pending.newState;

    // What OpenMLS computes for the same commit: the extension list with the
    // dictionary removed and the updated dictionary appended.
    const before = types(adminEpoch1);
    expect(types(resulting)).toEqual([
      ...before.filter((t) => t !== appDataDictionaryExtensionType),
      appDataDictionaryExtensionType,
    ]);
    expect(getMarmotGroupView(resulting)?.name).toBe("Renamed");
    admin.confirmPublished(sent.pending);

    const member = new MarmotGroupEngine({
      state: memberEpoch1,
      ciphersuite: impl,
      peeler,
    });
    for await (const _ of member.ingest([sent.envelope])) void _;
    expect(bytesToHex(member.state.confirmationTag)).toBe(
      bytesToHex(resulting.confirmationTag),
    );
    expect(getMarmotGroupView(member.state)?.name).toBe("Renamed");
  });

  it("adds nothing when the dictionary is already last", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await group("current");
    const admin = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const sent = await admin.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [rename("Renamed")],
    });
    if (sent.kind !== "groupEvolution") throw new Error("expected commit");
    const commit = sent.pending.commitMessage!;
    if (
      commit.wireformat !== 1 ||
      commit.publicMessage.content.contentType !== 3
    )
      throw new Error("expected a public commit");
    const carried = commit.publicMessage.content.commit.proposals.map(
      (entry) =>
        entry.proposalOrRefType === 1 ? entry.proposal.proposalType : -1,
    );
    expect(carried).not.toContain(
      defaultProposalTypes.group_context_extensions,
    );
    expect(types(sent.pending.newState)).toEqual(types(adminEpoch1));
  });

  it("does not touch commits without an AppDataUpdate", async () => {
    const { impl, adminEpoch1 } = await group("legacy");
    const admin = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const sent = await admin.send({ kind: "selfUpdate" });
    if (sent.kind !== "selfUpdate") throw new Error("expected self-update");
    expect(types(sent.pending.newState)).toEqual(types(adminEpoch1));
  });
});
