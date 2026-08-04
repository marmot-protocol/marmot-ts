/** @module @category Engine */
import {
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  type ClientState,
  type IncomingMessageCallback,
  type LeafIndex,
  type Proposal,
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

/**
 * A pure side-channel decorator around an `IncomingMessageCallback`, used to
 * capture a commit's own proposals for the WIRE-03/CONV-01 commit-legality
 * validators (`src/core/components/integrity.ts`).
 *
 * WHY this exists: ts-mls has no OpenMLS `StagedCommit` equivalent —
 * `processMessage` returns the fully-applied `newState` in one step, and
 * `IncomingMessageCallback` is the only pre-apply hook, but it never sees the
 * resulting `GroupContext`. `validateCommitLegality` needs both the
 * pre-apply (`parentState`) and post-apply (`resultingState`) `ClientState`,
 * plus the commit's own proposals, so it can only run AFTER `processMessage`
 * resolves. This wrapper's sole job is to make the commit's proposals
 * available at that later point — it is a side channel, not a policy
 * decision. It feeds the same algorithm ported from MDK's
 * `refs/mdk/crates/cgka-engine/src/app_components.rs`
 * `validate_app_component_integrity_for_staged_commit`.
 *
 * `callback` delegates every decision to `inner` unchanged — this is a
 * decorator, NOT a policy change. The MIP-03 admin gate, the
 * account-identity-proof check, and the admin-self-remove guard in
 * `createAdminCommitPolicyCallback` all keep their exact current behavior.
 * Its only extra effect: when `incoming.kind === "commit"`, it appends
 * `incoming.proposals.map((p) => p.proposal)` to a private buffer BEFORE
 * returning `inner(incoming)`, so proposals are captured even for a commit
 * the admin gate itself rejects.
 *
 * No validation logic may be added inside this wrapper or inside `inner`
 * (Pitfall 1 — validating inside the callback runs before the resulting
 * `GroupContext` exists and would produce wrong verdicts or throw mid-apply).
 *
 * Contract: `take()` returns the buffered proposals and clears the buffer.
 * Callers MUST call `take()` immediately before each `processMessage` call
 * (discarding the result, to clear any stale proposals left over from a
 * prior message) and again immediately after `processMessage` returns (to
 * read exactly the proposals of the commit just processed). This makes it
 * safe to reuse one `callback`/`take()` pair across a loop of several
 * commits processed with the same wrapped callback.
 */
export function withCapturedProposals(inner: IncomingMessageCallback): {
  callback: IncomingMessageCallback;
  take(): Proposal[];
} {
  let buffered: Proposal[] = [];

  const callback: IncomingMessageCallback = (incoming) => {
    if (incoming.kind === "commit") {
      buffered = buffered.concat(incoming.proposals.map((p) => p.proposal));
    }
    return inner(incoming);
  };

  const take = (): Proposal[] => {
    const result = buffered;
    buffered = [];
    return result;
  };

  return { callback, take };
}
