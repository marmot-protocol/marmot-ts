import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  nodeTypes,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import { encodeAdminPolicyV1 } from "../../core/components/admin-policy.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
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

async function memberGroup() {
  const adminPubkey = "a".repeat(64);
  const memberPubkey = "d".repeat(64);
  const siblingPubkey = "3".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const context = {
    cipherSuite: impl,
    authService: { validateCredential: () => true },
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [], relays: ["wss://relay.test"] },
  );
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
    ciphersuiteImpl: impl,
  });
  const siblingKp = await generateKeyPackage({
    credential: createCredential(siblingPubkey),
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: siblingKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const memberState = await joinGroup({
    context,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { adminPubkey, memberPubkey, impl, memberState };
}

async function stageForeignProposal(
  engine: MarmotGroupEngine<NostrEvent>,
  adminPubkey: string,
) {
  const staged = await engine.send({
    kind: "proposal",
    proposal: {
      proposalType: appDataUpdateProposalType,
      appDataUpdate: {
        componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
        operation: "update",
        update: encodeAdminPolicyV1([adminPubkey]),
      },
    },
  });
  engine.confirmPublished(staged.pending);
}

describe("outbound commit authorization seams", () => {
  it.each(["commit", "selfUpdate"] as const)(
    "rejects a non-admin %s carrying an unauthorized by-reference proposal before staging",
    async (kind) => {
      const { adminPubkey, memberPubkey, impl, memberState } =
        await memberGroup();
      const engine = new MarmotGroupEngine({
        state: memberState,
        ciphersuite: impl,
        peeler: testPeeler(impl),
      });
      await stageForeignProposal(engine, adminPubkey);

      const send =
        kind === "commit"
          ? engine.send({
              kind,
              // A caller-supplied admin identity cannot override the local leaf.
              actorPubkey: adminPubkey,
            })
          : engine.send({ kind });

      await expect(send).rejects.toThrow("Not a group admin");
      expect(engine.lifecycle).toBe("Stable");
      expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(1);
      expect(memberPubkey).not.toBe(adminPubkey);
    },
  );

  it("allows a valid local self-update when an unrelated leaf credential is malformed", async () => {
    const { impl, memberState } = await memberGroup();
    const localNodeIndex = Number(memberState.privatePath.leafIndex) * 2;
    const unrelatedLeaf = memberState.ratchetTree.find(
      (node, nodeIndex) =>
        node?.nodeType === nodeTypes.leaf &&
        nodeIndex !== localNodeIndex &&
        node.leaf.credential.identity.length === 32 &&
        bytesToHex(node.leaf.credential.identity) !== "a".repeat(64),
    );
    if (!unrelatedLeaf || unrelatedLeaf.nodeType !== nodeTypes.leaf)
      throw new Error("expected unrelated leaf");
    unrelatedLeaf.leaf.credential = {
      credentialType: 1,
      identity: new Uint8Array(16),
    } as typeof unrelatedLeaf.leaf.credential;

    const engine = new MarmotGroupEngine({
      state: memberState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const result = await engine.send({ kind: "selfUpdate" });
    expect(result.kind).toBe("selfUpdate");
    expect(engine.lifecycle).toBe("PendingPublish");
  });
});
