/** @module @category Core - Engine */
import {
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  type ClientState,
  type IncomingMessageCallback,
  type LeafIndex,
} from "ts-mls";

import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  verifyLeafAccountIdentityProof,
} from "../account-identity-proof.js";
import { getCredentialPubkey } from "../credential.js";

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

      const isSelfUpdateOnly = incoming.proposals.every(
        (p) =>
          p.proposal.proposalType === defaultProposalTypes.update &&
          p.senderLeafIndex !== undefined &&
          Number(p.senderLeafIndex) === Number(senderLeafIndex),
      );

      return isSelfUpdateOnly ? "accept" : "reject";
    } catch {
      if (onUnverifiableCommit === "retry") {
        throw new Error("unverifiable commit sender");
      }
      return "reject";
    }
  };
}
