/**
 * Admin authorization is evaluated against each commit's EXACT parent state,
 * on every seam — never against a state built once and reused (08-REVIEW
 * round 2, CR-01/CR-02). MDK runs `require_admin_for_staged_commit` against
 * the `MlsGroup` the commit is staged on, so a demotion earlier in a batch or
 * on a competing branch changes the verdict for exactly the commits whose
 * parent carries it.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `require_admin_for_staged_commit`
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  createCommit,
  encode,
  mlsMessageEncoder,
  type Proposal,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  seamGroup,
  testPeeler,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { commitDigest } from "../../core/convergence.js";
import { encodeAdminPolicyV1 } from "../../core/components/admin-policy.js";
import { encodeGroupProfileV1 } from "../../core/components/group-profile.js";
import {
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../../core/components/ids.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { IngestResult } from "../types.js";

function adminPolicyUpdate(adminPubkeys: string[]): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
      operation: "update",
      update: encodeAdminPolicyV1(adminPubkeys),
    },
  };
}

/** An admin-only change: a non-admin may not commit an AppDataUpdate. */
function profileUpdate(name: string): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: GROUP_PROFILE_COMPONENT_ID,
      operation: "update",
      update: encodeGroupProfileV1({ name, description: "" }),
    },
  };
}

async function drain(
  engine: MarmotGroupEngine<NostrEvent>,
  envelopes: NostrEvent[],
): Promise<IngestResult<NostrEvent>[]> {
  const out: IngestResult<NostrEvent>[] = [];
  for await (const r of engine.ingest(envelopes)) out.push(r);
  return out;
}

describe("admin authorization uses each commit's own parent state", () => {
  it("CR-01: a commit from an admin demoted earlier in the SAME batch is rejected", async () => {
    const { impl, ctx, adminPubkey, admin2Pubkey, adminEpoch1, admin2Epoch1 } =
      await seamGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // Commit 1 (epoch 1 -> 2): admin2 drops itself from admin_policy.
    const demote = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [adminPolicyUpdate([adminPubkey])],
    });
    expect(getMarmotGroupView(demote.newState)?.adminPubkeys).not.toContain(
      admin2Pubkey,
    );
    // Commit 2 (epoch 2 -> 3): the now-demoted admin2 commits an admin-only
    // profile change.
    const demotedCommit = await createCommit({
      context: ctx,
      state: demote.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [profileUpdate("renamed by a non-admin")],
    });

    // Both transport envelopes open under the epoch-1 state, so both commits
    // are read in one pass and processed by one `ingestEnvelopes` call.
    const envelopes = [
      await peeler.wrapGroupMessage(demote.commit, admin2Epoch1),
      await peeler.wrapGroupMessage(demotedCommit.commit, admin2Epoch1),
    ];

    const results = await drain(engine, envelopes);

    const processed = results.filter((r) => r.kind === "processed");
    const rejected = results.filter((r) => r.kind === "rejected");
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      kind: "rejected",
      reason: "admin-policy",
      message: demotedCommit.commit,
    });
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    expect(getMarmotGroupView(engine.state)?.name).not.toBe(
      "renamed by a non-admin",
    );
  });

  it("CR-02: pool replay authorizes a fork candidate against its fork parent, not the canonical tip", async () => {
    const { impl, ctx, adminPubkey, admin2Pubkey, adminEpoch1, admin2Epoch1 } =
      await seamGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // Canonical branch (epoch 1 -> 2): the engine's own confirmed commit
    // demotes admin2.
    const demote = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [adminPolicyUpdate([adminPubkey])],
    });
    if (demote.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(demote.pending);
    expect(getMarmotGroupView(engine.state)?.adminPubkeys).not.toContain(
      admin2Pubkey,
    );

    // Competing branch (epoch 1 -> 2'): admin2, still an admin at its real
    // parent, commits an admin-only change.
    const competing = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [profileUpdate("renamed on the competing fork")],
    });
    const competingDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, competing.commit)),
    );
    const envelope = await peeler.wrapGroupMessage(
      competing.commit,
      admin2Epoch1,
    );

    const results = await drain(engine, [envelope]);

    // Authorized at its own parent, so it is a scored fork candidate —
    // never a permanent, dedup-remembered `rejected` verdict.
    expect(results.filter((r) => r.kind === "rejected")).toHaveLength(0);
    const recordedDigests = engine.history
      .tags()
      .map((tag) => engine.history.node(tag)?.edge?.commitDigest)
      .filter((d): d is Uint8Array => d !== undefined)
      .map((d) => bytesToHex(d));
    expect(recordedDigests).toContain(competingDigest);
  });
});
