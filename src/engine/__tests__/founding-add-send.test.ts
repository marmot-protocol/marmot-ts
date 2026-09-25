/**
 * Engine-level test suite for `MarmotGroupEngine#send`'s `case "foundingAdd":`
 * seam (`src/engine/group-engine.ts`) — the founding Current-profile Add
 * commit (epoch 0 -> 1) that merges locally with no group-message
 * publication obligation.
 *
 * Covers:
 *  - FOUND-01: no transport envelope is ever constructed for the founding
 *    commit (proven with a call-counting peeler, not merely an unpublished
 *    envelope).
 *  - FOUND-02: the founding case runs through the identical
 *    `#assertStagedCommitLegal`/`validateCommitLegality` gate every other
 *    commit-producing send case uses.
 *  - FOUND-03: `confirmPublished(result.pending)` reaches `Stable` at
 *    epoch 1.
 *  - D-01: the founding Add's `PendingState.kind` is the existing `"commit"`
 *    literal, so it is recorded into retained history and the fork tree by
 *    `confirmPublished`'s unmodified commit-recording branch (CR-09).
 *  - D-02: the `foundingGroupCreated` result's `welcome` shape (one Welcome
 *    secrets entry per invitee).
 *  - R-01: leaving a `foundingGroupCreated` result unconfirmed is caught,
 *    not silently left as stale staged state -- canonical state stays at
 *    epoch 0 and a subsequent commit-producing send is refused while
 *    `PendingPublish`.
 *
 * @see refs/marmot/protocol-core/joining.md lines 21-30 -- "the
 *   founding-creation exception": a founding Add "has no group-message
 *   publication obligation because no pre-existing peer needs it".
 * @see .planning/phases/10-founding-group-creation-via-welcome/10-01-PLAN.md
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { forgeKeyPackage } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { proposeInviteUser } from "../../client/group/proposals/invite-user.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

/** A real crypto-backed peeler that also counts `wrapGroupMessage` calls (FOUND-01). */
function countingPeeler(ciphersuite: CiphersuiteImpl): {
  peeler: GroupPeeler<NostrEvent>;
  wrapCount: () => number;
} {
  let wraps = 0;
  const peeler: GroupPeeler<NostrEvent> = {
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
    async wrapGroupMessage(message, state) {
      wraps++;
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
  return { peeler, wrapCount: () => wraps };
}

/** A fresh solo epoch-0 group with a genuine admin identity. */
async function foundingGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Founding Test Group",
    { relays: ["wss://relay.test"] },
  );
  return { impl, adminAccount, adminPubkey: adminAccount.pubkey, epoch0 };
}

/** Builds a genuine, valid invitee KeyPackage for `slot`. */
async function inviteeKeyPackage(slot: number, impl: CiphersuiteImpl) {
  const account = testAccount(slot);
  return generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    ciphersuiteImpl: impl,
  });
}

describe('MarmotGroupEngine#send case "foundingAdd"', () => {
  it("FOUND-01: builds no transport envelope for the founding commit", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const invitee2 = await inviteeKeyPackage(11, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        proposeInviteUser(invitee1.publicPackage),
        proposeInviteUser(invitee2.publicPackage),
      ],
    });

    expect(result.kind).toBe("foundingGroupCreated");
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");
    expect(result.welcome).toBeDefined();
    // This is the behavioral form of FOUND-01: it cannot be satisfied by an
    // envelope that is built and then dropped -- the peeler's wrap method
    // must never be invoked at all across the whole send.
    expect(wrapCount()).toBe(0);
  });

  it("FOUND-03/D-01: transits PendingPublish (epoch still 0) then reaches Stable at epoch 1 on confirm", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");

    // D-01: the PendingPublish transit is real but never observed by a
    // caller that confirms in the same uninterrupted continuation -- checked
    // here, before any intervening await.
    expect(engine.lifecycle).toBe("PendingPublish");
    expect(Number(engine.state.groupContext.epoch)).toBe(0);

    engine.confirmPublished(result.pending);

    expect(engine.lifecycle).toBe("Stable");
    expect(Number(engine.state.groupContext.epoch)).toBe(1);
  });

  it("D-01/CR-09: records the founding commit into retained history and the fork tree on confirmation", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");
    engine.confirmPublished(result.pending);

    // The whole point of D-01: the CR-09 recording path ran for a commit
    // that was never published. Two nodes: the epoch-0 root plus the
    // epoch-1 child.
    expect(engine.history.size).toBe(2);
    const retainedEpochs = engine
      .retainedStates()
      .map((state) => Number(state.groupContext.epoch));
    expect(retainedEpochs).toContain(0);
    expect(retainedEpochs).toContain(1);
  });

  it("R-01: an unconfirmed foundingGroupCreated result is caught, not silently left as stale staged state", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee = await inviteeKeyPackage(9, impl);

    await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [proposeInviteUser(invitee.publicPackage)],
    });

    // Deliberately never confirmed. Canonical state must stay at epoch 0 --
    // this is the executable form of R-01, which CONTEXT.md flags as the
    // test most likely to be skipped and most valuable to keep.
    expect(Number(engine.state.groupContext.epoch)).toBe(0);
    expect(engine.lifecycle).toBe("PendingPublish");

    await expect(
      engine.send({ kind: "commit", actorPubkey: adminPubkey }),
    ).rejects.toThrow(/PendingPublish/);
  });

  it("FOUND-02: a foundingAdd whose Add proposal carries a KeyPackage with a missing account-identity proof is refused", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler, wrapCount } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const forged = await forgeKeyPackage({
      account: testAccount(3),
      ciphersuiteImpl: impl,
      proof: "missing",
    });

    // A plain literal Add proposal (not `proposeInviteUser`, which runs its
    // own client-layer proof check before the send is even attempted) so
    // this test exercises the SHARED `#assertStagedCommitLegal` gate itself
    // -- the same gate `case "commit"`/`case "selfUpdate"` call -- not a
    // separate, earlier client-side validator.
    await expect(
      engine.send({
        kind: "foundingAdd",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: forged.publicPackage },
          },
        ],
      }),
    ).rejects.toThrow(CommitLegalityError);

    // Nothing staged: no envelope built, still Stable at epoch 0.
    expect(wrapCount()).toBe(0);
    expect(engine.lifecycle).toBe("Stable");
    expect(Number(engine.state.groupContext.epoch)).toBe(0);
  });

  it("D-02 shape: welcome.welcome.secrets has one entry per invitee for a two-invitee founding Add", async () => {
    const { impl, adminPubkey, epoch0 } = await foundingGroup();
    const { peeler } = countingPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: epoch0,
      ciphersuite: impl,
      peeler,
    });
    const invitee1 = await inviteeKeyPackage(9, impl);
    const invitee2 = await inviteeKeyPackage(11, impl);

    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: adminPubkey,
      extraProposals: [
        proposeInviteUser(invitee1.publicPackage),
        proposeInviteUser(invitee2.publicPackage),
      ],
    });
    if (result.kind !== "foundingGroupCreated") throw new Error("unreachable");

    expect(result.welcome.welcome.secrets).toHaveLength(2);
  });
});
