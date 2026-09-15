/**
 * The own-commit known-state shortcut reuses a recorded child instead of
 * replaying the commit. When the commit's proposals cannot be rebuilt off the
 * wire (a PrivateMessage commit, a non-member sender, or a reference the parent
 * no longer stages), it must still run every legality check that does not need
 * those proposals — not only the `0x8009` one (08-REVIEW round 2, WR-03). A
 * persisted pre-upgrade edge that de-leafs an admin is exactly the input class
 * the shortcut must not grandfather in.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { createCommit, defaultProposalTypes, processMessage } from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  seamGroup,
  snapshot,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
import { resolveCandidateParent } from "../fork-recovery.js";

describe("known-state shortcut without rebuildable proposals (WR-03)", () => {
  it("still rejects a recorded child that leaves an admin without a member leaf", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, admin2Epoch1, forgedEpoch1 } =
      await seamGroup({ forgedMember: "tampered" });
    const [adminLeaf] = getPubkeyLeafNodeIndexes(adminEpoch1, adminPubkey);
    if (adminLeaf === undefined) throw new Error("expected admin1's leaf");

    // admin2 removes admin1's only leaf without dropping admin1 from
    // admin_policy. Sent as a PrivateMessage, so the shortcut cannot rebuild
    // the commit's proposals off the wire.
    const orphaning = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: adminLeaf },
        },
      ],
    });

    // The recorded child, reached with no Marmot gates, from a third member's
    // perspective (a member other than the committer can replay the commit).
    const parent = snapshot(forgedEpoch1!);
    const replayed = await processMessage({
      context: {
        cipherSuite: impl,
        authService: ctx.authService,
        externalPsks: {},
      },
      state: snapshot(forgedEpoch1!),
      message: orphaning.commit,
    });
    if (replayed.kind !== "newState") throw new Error("expected newState");
    expect(getMarmotGroupView(replayed.newState)?.adminPubkeys).toContain(
      adminPubkey,
    );

    const view = getMarmotGroupView(parent);
    if (!view) throw new Error("expected a Marmot group view");
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent,
      message: orphaning.commit,
      callback: createAdminCommitPolicyCallback({
        ratchetTree: parent.ratchetTree,
        adminPubkeys: view.adminPubkeys,
        ciphersuiteId: impl.id,
      }),
      known: {
        parentTag: bytesToHex(parent.confirmationTag),
        state: replayed.newState,
      },
    });

    expect(resolution.kind).toBe("rejected");
    expect(
      resolution.kind === "rejected" ? resolution.violation?.reason : undefined,
    ).toBe("admin-leaf-coupling");
  });
});
