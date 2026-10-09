/**
 * Proposal-sender authorization, mirroring MDK `authorize_proposal`
 * (`cgka-engine/src/app_components.rs`): every proposal is judged against its
 * OWN authenticated sender, standalone on arrival and again inside any commit
 * that carries it. In v1 a non-admin may only send SelfRemove, and an admin
 * may not send SelfRemove.
 *
 * Found against MDK (White Noise): a marmot-ts member that is not an admin
 * sent a standalone rename. marmot-ts admins staged it, and the next commit
 * any of them made (even a self-update) bundled it by reference. MDK rejected
 * that commit and the group split.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  createProposal,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type Proposal,
  selfRemoveProposalType,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { groupProfileEntry } from "../../core/components/dictionary.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
import {
  MarmotGroupEngine,
  ProposalAuthorizationError,
} from "../group-engine.js";
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

/** Admin (leaf 0) plus two non-admin members (leaves 1, 2) at epoch 1. */
async function group() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const kp = (slot: number) =>
    generateKeyPackage({
      credential: createCredential(testAccount(slot).pubkey),
      signer: testAccount(slot).signer,
      ciphersuiteImpl: impl,
    });
  const admin = testAccount(6);
  const { clientState: epoch0 } = await createSimpleGroup(
    await kp(6),
    impl,
    "Group",
    { adminPubkeys: [admin.pubkey], relays: ["wss://relay.test"] },
  );
  const m1 = await kp(9);
  const m2 = await kp(11);
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [m1, m2].map((k) => ({
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: k.publicPackage },
    })),
    ratchetTreeExtension: true,
  });
  const join = (k: typeof m1) =>
    joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: k.publicPackage,
      privateKeys: k.privatePackage,
      ratchetTree: undefined,
    });
  return {
    impl,
    ctx,
    adminPubkey: admin.pubkey,
    adminEpoch1: add.newState,
    member1Epoch1: await join(m1),
    member2Epoch1: await join(m2),
  };
}

type Ctx = Awaited<ReturnType<typeof group>>["ctx"];

const rename: Proposal = (() => {
  const entry = groupProfileEntry({ name: "renamed", description: "" });
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: entry.componentId,
      operation: "update",
      update: entry.data,
    },
  };
})();

/** A standalone proposal built with raw ts-mls, bypassing the send gate. */
async function rawProposal(ctx: Ctx, state: ClientState, proposal: Proposal) {
  const { message } = await createProposal({
    context: ctx,
    state,
    wireAsPublicMessage: true,
    proposal,
  });
  return testPeeler(ctx.cipherSuite).wrapGroupMessage(message, state);
}

async function ingestInto(
  impl: CiphersuiteImpl,
  state: ClientState,
  envelope: NostrEvent,
) {
  const engine = new MarmotGroupEngine({
    state,
    ciphersuite: impl,
    peeler: testPeeler(impl),
  });
  const kinds: string[] = [];
  for await (const r of engine.ingest([envelope])) kinds.push(r.kind);
  return { engine, kinds };
}

describe("standalone proposal admission (MDK authorize_proposal)", () => {
  it.each([
    ["rename (AppDataUpdate)", () => rename],
    [
      "Remove",
      (): Proposal => ({
        proposalType: defaultProposalTypes.remove,
        remove: { removed: 2 },
      }),
    ],
  ] as const)(
    "rejects a non-admin's standalone %s and does not stage it",
    async (_label, build) => {
      const { impl, ctx, adminEpoch1, member1Epoch1 } = await group();
      const envelope = await rawProposal(ctx, member1Epoch1, build());
      const { engine, kinds } = await ingestInto(impl, adminEpoch1, envelope);

      expect(kinds).toEqual(["rejected"]);
      expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);

      // The admin's next commit therefore carries no foreign proposal, so
      // every peer (MDK included) accepts it.
      const sent = await engine.send({ kind: "selfUpdate" });
      expect(sent.kind).toBe("selfUpdate");
    },
  );

  it("rejects an admin's standalone SelfRemove", async () => {
    const { impl, ctx, adminEpoch1, member1Epoch1 } = await group();
    const envelope = await rawProposal(ctx, adminEpoch1, {
      proposalType: selfRemoveProposalType,
    });
    const { engine, kinds } = await ingestInto(impl, member1Epoch1, envelope);
    expect(kinds).toEqual(["rejected"]);
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
  });

  it("stages a non-admin's SelfRemove and an admin's Remove", async () => {
    const { impl, ctx, adminEpoch1, member1Epoch1, member2Epoch1 } =
      await group();
    const leave = await rawProposal(ctx, member1Epoch1, {
      proposalType: selfRemoveProposalType,
    });
    expect(
      Object.keys(
        (await ingestInto(impl, member2Epoch1, leave)).engine.state
          .unappliedProposals,
      ),
    ).toHaveLength(1);

    const kick = await rawProposal(ctx, adminEpoch1, {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 2 },
    });
    expect(
      Object.keys(
        (await ingestInto(impl, member1Epoch1, kick)).engine.state
          .unappliedProposals,
      ),
    ).toHaveLength(1);
  });
});

describe("commit carrying a proposal its sender may not make", () => {
  it("rejects an admin commit that references a non-admin's AppDataUpdate", () => {
    const admin = testAccount(6);
    const member = testAccount(9);
    const leaf = (pubkey: string) => ({
      nodeType: 1,
      leaf: { credential: createCredential(pubkey) },
    });
    const callback = createAdminCommitPolicyCallback({
      // Leaf 0 (node 0) is the admin, leaf 1 (node 2) the member.
      ratchetTree: [
        leaf(admin.pubkey),
        undefined,
        leaf(member.pubkey),
      ] as never,
      adminPubkeys: [admin.pubkey],
      ciphersuiteId: 1,
    });
    expect(
      callback({
        kind: "commit",
        senderLeafIndex: 0 as never,
        proposals: [{ proposal: rename, senderLeafIndex: 1 }],
      }),
    ).toBe("reject");
    // The same proposal sent by the admin itself is fine.
    expect(
      callback({
        kind: "commit",
        senderLeafIndex: 0 as never,
        proposals: [{ proposal: rename, senderLeafIndex: 0 }],
      }),
    ).toBe("accept");
  });
});

describe("outbound standalone proposals", () => {
  it("refuses a non-admin's standalone AppDataUpdate before publishing", async () => {
    const { impl, member1Epoch1 } = await group();
    const engine = new MarmotGroupEngine({
      state: member1Epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    await expect(
      engine.send({ kind: "proposal", proposal: rename }),
    ).rejects.toThrow(ProposalAuthorizationError);
  });

  it("refuses an admin's SelfRemove and allows a non-admin's", async () => {
    const { impl, adminEpoch1, member1Epoch1 } = await group();
    const selfRemove: Proposal = { proposalType: selfRemoveProposalType };
    const admin = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    await expect(
      admin.send({ kind: "proposal", proposal: selfRemove }),
    ).rejects.toThrow("self_remove sender is an active admin");

    const member = new MarmotGroupEngine({
      state: member1Epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    expect(
      (await member.send({ kind: "proposal", proposal: selfRemove })).kind,
    ).toBe("proposal");
  });
});
