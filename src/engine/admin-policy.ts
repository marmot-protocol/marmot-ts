/** @module @category Engine */
import {
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  type ClientState,
  type IncomingMessageCallback,
  type LeafIndex,
} from "ts-mls";

import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  verifyLeafAccountIdentityProof,
} from "../core/account-identity-proof.js";
import { getCredentialPubkey } from "../core/credential.js";

function toLeafIndex(index: number): LeafIndex {
  return index as LeafIndex;
}

/**
 * Build an incoming-message callback that enforces MIP-03 "admin-only commits".
 */
export function createAdminCommitPolicyCallback(args: {
  ratchetTree: ClientState["ratchetTree"];
  adminPubkeys: string[];
  ciphersuiteId: number;
  onUnverifiableCommit?: "reject" | "retry";
}): IncomingMessageCallback {
  const {
    ratchetTree,
    adminPubkeys,
    ciphersuiteId,
    onUnverifiableCommit = "retry",
  } = args;

  return (incoming) => {
    if (incoming.kind === "proposal") return "accept";

    for (const { proposal } of incoming.proposals) {
      if (proposal.proposalType !== defaultProposalTypes.add) continue;
      if (!("add" in proposal)) continue;
      const leaf = proposal.add.keyPackage.leafNode;
      const hasProof = leaf.extensions.some(
        (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      );
      if (!hasProof) continue;
      try {
        verifyLeafAccountIdentityProof(leaf, ciphersuiteId);
      } catch {
        return "reject";
      }
    }

    // An admin MUST drop admin before self-removing (member-departure.md), so a
    // self_remove whose sender (the leaver) is still an active admin is invalid.
    // Checked before the admin short-circuit below, so even an admin committer
    // cannot splice in an admin's self_remove.
    for (const { proposal, senderLeafIndex } of incoming.proposals) {
      if (proposal.proposalType !== selfRemoveProposalType) continue;
      if (senderLeafIndex === undefined) return "reject";
      try {
        const leaverPubkey = getCredentialPubkey(
          getCredentialFromLeafIndex(
            ratchetTree,
            toLeafIndex(Number(senderLeafIndex)),
          ),
        );
        if (adminPubkeys.includes(leaverPubkey)) return "reject";
      } catch {
        return "reject";
      }
    }

    const senderLeafIndexUnknown = incoming.senderLeafIndex;
    if (senderLeafIndexUnknown === undefined) return "reject";

    const senderLeafIndex: LeafIndex =
      typeof senderLeafIndexUnknown === "number"
        ? toLeafIndex(senderLeafIndexUnknown)
        : senderLeafIndexUnknown;

    try {
      const senderCredential = getCredentialFromLeafIndex(
        ratchetTree,
        senderLeafIndex,
      );
      const senderPubkey = getCredentialPubkey(senderCredential);

      if (adminPubkeys.includes(senderPubkey)) return "accept";

      if (incoming.proposals.length === 0) return "accept";

      // A non-admin may commit only a self-update-only commit (its own Update)
      // or a self_remove-only commit (committing peers' departures), per
      // protocol-core/group-messaging.md.
      const isSelfUpdateOnly = incoming.proposals.every(
        (p) =>
          p.proposal.proposalType === defaultProposalTypes.update &&
          p.senderLeafIndex !== undefined &&
          Number(p.senderLeafIndex) === Number(senderLeafIndex),
      );

      const isSelfRemoveOnly = incoming.proposals.every(
        (p) => p.proposal.proposalType === selfRemoveProposalType,
      );

      return isSelfUpdateOnly || isSelfRemoveOnly ? "accept" : "reject";
    } catch {
      if (onUnverifiableCommit === "retry") {
        throw new Error("unverifiable commit sender");
      }
      return "reject";
    }
  };
}
