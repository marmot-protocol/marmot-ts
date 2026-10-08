/**
 * A removed receiver must judge the commit that removes it against the
 * commit's real resulting state.
 *
 * ts-mls returns a tombstone for a receiver the commit removes: the
 * post-commit tree with the PARENT GroupContext. Admin-leaf coupling then saw
 * the removed admin still listed in the admin policy with no leaf, so an admin
 * removed by another admin rejected its own removal and kept showing the group
 * as active. Found against MDK (White Noise 0.11 and HEAD): an MDK admin
 * removed a marmot-ts admin, and the marmot-ts client rejected the commit with
 * `admin-leaf-coupling`.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { adminPolicyEntry } from "../../core/components/dictionary.js";
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

/** Two admins: `first` (leaf 0) and `second` (leaf 1), both at epoch 2. */
async function twoAdmins() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const first = testAccount(6);
  const second = testAccount(0);
  const kp = (account: typeof first) =>
    generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
  const firstKp = await kp(first);
  const secondKp = await kp(second);
  const { clientState: epoch0 } = await createSimpleGroup(
    firstKp,
    impl,
    "Group",
    { adminPubkeys: [first.pubkey], relays: ["wss://relay.test"] },
  );
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: secondKp.publicPackage },
      },
    ],
  });
  const secondEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: secondKp.publicPackage,
    privateKeys: secondKp.privatePackage,
    ratchetTree: undefined,
  });
  const policy = adminPolicyEntry([first.pubkey, second.pubkey].sort());
  const promote = await createCommit({
    context: ctx,
    state: add.newState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: policy.componentId,
          operation: "update",
          update: policy.data,
        },
      },
    ],
  });
  const peeler = testPeeler(impl);
  const secondEngine = new MarmotGroupEngine({
    state: secondEpoch1,
    ciphersuite: impl,
    peeler,
  });
  for await (const _ of secondEngine.ingest([
    await peeler.wrapGroupMessage(promote.commit, add.newState),
  ]))
    void _;
  expect(Number(secondEngine.state.groupContext.epoch)).toBe(2);
  return {
    impl,
    ctx,
    first,
    second,
    firstEpoch2: promote.newState,
    secondEngine,
    peeler,
  };
}

describe("an admin removed by another admin", () => {
  it("accepts its removal and realizes it", async () => {
    const { impl, first, second, firstEpoch2, secondEngine, peeler } =
      await twoAdmins();
    // The second admin removes the first; the engine splices the admin-policy
    // update that drops the first admin into the same commit.
    const sent = await secondEngine.send({
      kind: "commit",
      actorPubkey: second.pubkey,
      extraProposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
      ],
    });
    if (sent.kind !== "groupEvolution") throw new Error("expected commit");

    const removed = new MarmotGroupEngine({
      state: firstEpoch2,
      ciphersuite: impl,
      peeler,
    });
    const kinds: string[] = [];
    for await (const result of removed.ingest([sent.envelope]))
      kinds.push(result.kind);

    expect(kinds).not.toContain("rejected");
    expect(kinds).toContain("removed");
    expect(removed.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(first.pubkey).not.toBe(second.pubkey);
  });

  it("still rejects a removal that leaves it in the admin policy", async () => {
    const { ctx, firstEpoch2, secondEngine, peeler } = await twoAdmins();
    // A raw commit that removes the second admin without an admin-policy
    // update: its resulting epoch lists an admin with no leaf, which is
    // invalid for every receiver, the removed one included.
    const bad = await createCommit({
      context: ctx,
      state: firstEpoch2,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: 1 } },
      ],
    });
    const results: { kind: string; reason?: string }[] = [];
    for await (const result of secondEngine.ingest([
      await peeler.wrapGroupMessage(bad.commit, firstEpoch2),
    ]))
      results.push(result as { kind: string; reason?: string });

    expect(results.map((r) => r.kind)).toContain("rejected");
    expect(results.find((r) => r.kind === "rejected")?.reason).toBe(
      "admin-leaf-coupling",
    );
    expect(secondEngine.state.groupActiveState.kind).not.toBe(
      "removedFromGroup",
    );
  });
});
