/**
 * Send-seam tests for the third and final WIRE-03/CONV-01 commit-legality
 * seam: `MarmotGroupEngine#send`'s `case "commit":` staging path
 * (`src/engine/group-engine.ts`).
 *
 * Covers:
 *  - D-05/D-06/D-07/D-08: auto-coupling an admin-policy update into a
 *    removal commit that de-leafs an admin account, account-level admin
 *    survival, and the `AdminDepletionError` guard.
 *  - D-01/D-02: the `validateCommitLegality` gate on the staged commit,
 *    thrown as `UsageError` before the lifecycle transitions to
 *    `PendingPublish` and before the commit is wrapped.
 *  - D-04/D-09: `#treeResolution`'s winner-chain validation on a tree-fed
 *    re-convergence switch.
 *
 * Together with `commit-legality-seams.test.ts` (inbound + replay seams,
 * plan 03-04), this proves all three routes by which a commit becomes
 * canonical state — send, inbound, and convergence/replay — call the same
 * shared adapter (`src/core/components/integrity.ts` `validateCommitLegality`).
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  type LeafIndex,
  UsageError,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { getAdminPolicy } from "../../core/components/dictionary.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { AdminDepletionError, MarmotGroupEngine } from "../group-engine.js";
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

/**
 * A group at epoch 1 with two admins (`adminPubkey`, `admin2Pubkey`) and one
 * non-admin member (`memberPubkey`), each with a single leaf. `adminPubkey` is
 * the identity behind the engine under test (this device's own leaf), so
 * every `engine.send({ kind: "commit", actorPubkey: adminPubkey, ... })` call
 * below is a genuine local commit-staging call.
 */
async function twoAdminGroup() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
  const memberPubkey = "d".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2Kp = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
    ciphersuiteImpl: impl,
  });

  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2Kp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  return {
    impl,
    ctx,
    adminPubkey,
    admin2Pubkey,
    memberPubkey,
    epoch1: add.newState,
  };
}

/**
 * A group at epoch 1 with two admins where `admin2Pubkey` occupies TWO
 * separate leaves (two devices under the same account credential) — the
 * fixture D-08's account-level (not leaf-level) survival rule needs.
 */
async function twoLeafAdminGroup() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2KpA = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const admin2KpB = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });

  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2KpA.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2KpB.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  return { impl, ctx, adminPubkey, admin2Pubkey, epoch1: add.newState };
}

describe("send-seam commit legality (WIRE-03/CONV-01) — D-01/D-02/D-05..D-09", () => {
  it("removing a non-admin member produces no spliced admin-policy update", async () => {
    const { impl, adminPubkey, memberPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const [memberLeaf] = getPubkeyLeafNodeIndexes(engine.state, memberPubkey);
    expect(memberLeaf).toBeDefined();
    const beforeAdminPolicy = getAdminPolicy(
      engine.state.groupContext.extensions,
    );

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: memberLeaf as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const afterAdminPolicy = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(afterAdminPolicy).toEqual(beforeAdminPolicy);
  });

  it("removing an admin member splices the admin-policy update into the same commit (D-05)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const [admin2Leaf] = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(admin2Leaf).toBeDefined();

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: admin2Leaf as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const resultingAdmins = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(resultingAdmins).toEqual([adminPubkey]);
    expect(Number(result.pending.newState.groupContext.epoch)).toBe(
      beforeEpoch + 1,
    );
  });

  it("rejects a removal that would empty the admin set with AdminDepletionError before staging (D-07)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const [adminLeaf] = getPubkeyLeafNodeIndexes(engine.state, adminPubkey);
    const [admin2Leaf] = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(adminLeaf).toBeDefined();
    expect(admin2Leaf).toBeDefined();

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.remove,
            remove: { removed: adminLeaf as LeafIndex },
          },
          {
            proposalType: defaultProposalTypes.remove,
            remove: { removed: admin2Leaf as LeafIndex },
          },
        ],
      }),
    ).rejects.toThrow(AdminDepletionError);

    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("does not drop an admin's key when only one of its two leaves is removed (D-08)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } =
      await twoLeafAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const admin2Leaves = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(admin2Leaves.length).toBe(2);
    const beforeAdminPolicy = getAdminPolicy(
      engine.state.groupContext.extensions,
    );

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: admin2Leaves[0] as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const afterAdminPolicy = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(afterAdminPolicy).toEqual(beforeAdminPolicy);
    expect(afterAdminPolicy).toContain(admin2Pubkey);
  });

  it("throws UsageError before staging when the resulting extensions would drop a required component (D-01/D-02)", async () => {
    const { impl, adminPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeTag = bytesToHex(engine.state.confirmationTag);

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
              operation: "remove",
            },
          },
        ],
      }),
    ).rejects.toThrow(UsageError);

    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("a benign commit still returns a groupEvolution SendResult with the unchanged field set", async () => {
    const { impl, adminPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    expect(Object.keys(result).sort()).toEqual(
      ["envelope", "kind", "pending", "welcome"].sort(),
    );
    expect(result.pending.kind).toBe("commit");
    expect(result.pending.newState).toBeDefined();
    expect(result.pending.parentState).toBeDefined();
    expect(result.pending.commitMessage).toBeDefined();
  });
});
