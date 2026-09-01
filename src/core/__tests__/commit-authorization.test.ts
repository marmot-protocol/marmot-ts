import {
  defaultProposalTypes,
  selfRemoveProposalType,
  type Proposal,
  type ProposalWithSender,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { decideCommitAuthorization } from "../commit-authorization.js";

const ADMIN = "a".repeat(64);
const MEMBER = "d".repeat(64);
const ACTOR_LEAF = 2;

function withSender(
  proposal: Proposal,
  senderLeafIndex = ACTOR_LEAF,
): ProposalWithSender {
  return { proposal, senderLeafIndex };
}

const update = (senderLeafIndex = ACTOR_LEAF): ProposalWithSender =>
  withSender(
    {
      proposalType: defaultProposalTypes.update,
      update: {} as Proposal extends { update: infer T } ? T : never,
    } as Proposal,
    senderLeafIndex,
  );

const selfRemove = withSender({
  proposalType: selfRemoveProposalType,
  selfRemove: {},
} as Proposal);

const remove = withSender({
  proposalType: defaultProposalTypes.remove,
  remove: { removed: 1 },
} as Proposal);

describe("decideCommitAuthorization", () => {
  it("allows an admin to commit any proposal union", () => {
    expect(
      decideCommitAuthorization({
        actorPubkey: ADMIN,
        actorLeafIndex: ACTOR_LEAF,
        adminPubkeys: [ADMIN],
        proposals: [remove],
      }),
    ).toEqual({ authorized: true });
  });

  it.each([
    { name: "an empty self-update", proposals: [] },
    { name: "only its own Update", proposals: [update()] },
    { name: "only SelfRemove proposals", proposals: [selfRemove] },
  ])("allows a non-admin to commit $name", ({ proposals }) => {
    expect(
      decideCommitAuthorization({
        actorPubkey: MEMBER,
        actorLeafIndex: ACTOR_LEAF,
        adminPubkeys: [ADMIN],
        proposals,
      }),
    ).toEqual({ authorized: true });
  });

  it.each([
    { name: "a foreign Update", proposals: [update(ACTOR_LEAF + 1)] },
    { name: "a Remove", proposals: [remove] },
    { name: "mixed Update and SelfRemove", proposals: [update(), selfRemove] },
  ])("rejects a non-admin committing $name", ({ proposals }) => {
    expect(
      decideCommitAuthorization({
        actorPubkey: MEMBER,
        actorLeafIndex: ACTOR_LEAF,
        adminPubkeys: [ADMIN],
        proposals,
      }),
    ).toEqual({
      authorized: false,
      reason: "non-admin-proposal-union",
    });
  });
});
