/** @module @category Engine */
import {
  appDataUpdateProposalType,
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  type ClientState,
  type IncomingMessageCallback,
  type LeafIndex,
  type Proposal,
  type ProposalWithSender,
} from "ts-mls";

import { decodeAdminPolicyV1 } from "../core/components/admin-policy.js";
import { decodeAgentTextStreamQuicPolicyV1 } from "../core/components/agent-text-stream.js";
import { decodeComponentsList } from "../core/components/app-components-list.js";
import { decodeGroupAvatarUrlV1 } from "../core/components/avatar-url.js";
import { decodeEncryptedMediaPolicyV1 } from "../core/components/encrypted-media.js";
import { decodeGroupLifecycleV1 } from "../core/components/group-lifecycle.js";
import { decodeGroupProfileV1 } from "../core/components/group-profile.js";
import {
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_AVATAR_URL_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../core/components/ids.js";
import {
  type CommitIntegrityViolation,
  validateAddProposalAccountIdentityProofs,
} from "../core/components/integrity.js";
import { decodeMessageRetentionV1 } from "../core/components/message-retention.js";
import { decodeNostrRoutingV1 } from "../core/components/nostr-routing.js";
import { getCredentialPubkey } from "../core/credential.js";

function toLeafIndex(index: number): LeafIndex {
  return index as LeafIndex;
}

/**
 * Payload decoders for every app component whose format this library knows.
 * An AppDataUpdate for an id outside this table is opaque to the library and
 * left to the application (`app-components/README.md` "Unknown Data").
 */
const COMPONENT_PAYLOAD_DECODERS: ReadonlyMap<
  number,
  (data: Uint8Array) => unknown
> = new Map<number, (data: Uint8Array) => unknown>([
  [APP_COMPONENTS_COMPONENT_ID, decodeComponentsList],
  [GROUP_PROFILE_COMPONENT_ID, decodeGroupProfileV1],
  [GROUP_ADMIN_POLICY_COMPONENT_ID, decodeAdminPolicyV1],
  [NOSTR_ROUTING_COMPONENT_ID, decodeNostrRoutingV1],
  [GROUP_MESSAGE_RETENTION_COMPONENT_ID, decodeMessageRetentionV1],
  [AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, decodeAgentTextStreamQuicPolicyV1],
  [GROUP_AVATAR_URL_COMPONENT_ID, decodeGroupAvatarUrlV1],
  [GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, decodeEncryptedMediaPolicyV1],
  [GROUP_LIFECYCLE_COMPONENT_ID, decodeGroupLifecycleV1],
]);

/**
 * The pre-apply, parent-independent admission checks every inbound proposal —
 * standalone or carried by a commit — must pass before it is staged or applied
 * (CR-03). Returns the first violation, in this order:
 *
 * 1. every Add's KeyPackage carries a valid `0x8009` proof
 *    ({@link validateAddProposalAccountIdentityProofs}, D-08/D-09);
 * 2. every AppDataUpdate `update` for a known component id carries a payload
 *    that decodes with that component's codec (`component-integrity`).
 *    Without this, one AppDataUpdate — which the admin gate admits from any
 *    member as a standalone proposal, and which a later commit bundles by
 *    reference — could poison the group dictionary with bytes no member can
 *    decode.
 *
 * Shared by the admin callback and by every seam that labels a callback
 * rejection, so the verdict and its reason cannot differ per seam.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_app_data_update_batch`, `validate_membership_proposal`
 */
export function validatePreApplyProposals(
  proposals: readonly (Proposal | ProposalWithSender)[],
  ciphersuiteId: number,
): CommitIntegrityViolation | undefined {
  const addViolation = validateAddProposalAccountIdentityProofs(
    proposals,
    ciphersuiteId,
  );
  if (addViolation) return addViolation;
  for (const item of proposals) {
    const proposal = "proposal" in item ? item.proposal : item;
    if (
      proposal.proposalType !== appDataUpdateProposalType ||
      !("appDataUpdate" in proposal)
    )
      continue;
    const { appDataUpdate } = proposal;
    if (appDataUpdate.operation !== "update") continue;
    const decode = COMPONENT_PAYLOAD_DECODERS.get(appDataUpdate.componentId);
    if (!decode) continue;
    try {
      decode(appDataUpdate.update);
    } catch {
      return {
        reason: "component-integrity",
        detail: `AppDataUpdate payload for app component 0x${appDataUpdate.componentId.toString(16)} does not decode`,
      };
    }
  }
  return undefined;
}

/**
 * Build an incoming-message callback that enforces
 * `refs/marmot/protocol-core/group-messaging.md` "admin-only commits".
 *
 * Every Add — whether committed or proposed standalone — is validated
 * before apply with the same core validator
 * ({@link validateAddProposalAccountIdentityProofs}) that `proposeInviteUser`
 * (the invite seam) and the post-apply tree-diff adapter
 * (`src/core/components/integrity.ts` `validateCommitAccountIdentityProofs`)
 * use, so a bad Add cannot reach the queued-proposal or applied-tree state
 * through this callback regardless of which of the two `IncomingMessageCallback`
 * kinds it arrives as (D-08/D-09).
 *
 * @see refs/marmot/protocol-core/group-messaging.md "admin-only commits"
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_membership_proposal`
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
    if (incoming.kind === "proposal") {
      // Add proofs (D-09) and known-component AppDataUpdate payloads (CR-03)
      // are validated here. Standalone Update admission is deferred to
      // Phase 9 (D-10) -- a bad Update leaf is still caught at commit time by
      // the tree-diff adapter.
      return validatePreApplyProposals([incoming.proposal], ciphersuiteId)
        ? "reject"
        : "accept";
    }

    if (validatePreApplyProposals(incoming.proposals, ciphersuiteId))
      return "reject";

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
 * decorator, NOT a policy change. The
 * `refs/marmot/protocol-core/group-messaging.md` admin gate, the
 * account-identity-proof check, and the admin-self-remove guard in
 * `createAdminCommitPolicyCallback` all keep their exact current behavior.
 * Its only extra effect: BEFORE returning `inner(incoming)`, it appends the
 * proposal(s) to a private buffer — for `incoming.kind === "commit"`,
 * `incoming.proposals.map((p) => p.proposal)`; for `incoming.kind ===
 * "proposal"`, the single `incoming.proposal` — so proposals are captured
 * even for a message `inner` itself rejects.
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
  take(): {
    proposals: ProposalWithSender[];
    committerLeafIndex: number | undefined;
  };
} {
  let buffered: ProposalWithSender[] = [];
  let committerLeafIndex: number | undefined;

  const callback: IncomingMessageCallback = (incoming) => {
    if (incoming.kind === "commit") {
      buffered = buffered.concat(incoming.proposals);
      committerLeafIndex = incoming.senderLeafIndex;
    } else if (incoming.kind === "proposal") {
      buffered = buffered.concat(incoming.proposal);
    }
    return inner(incoming);
  };

  const take = () => {
    const result = { proposals: buffered, committerLeafIndex };
    buffered = [];
    committerLeafIndex = undefined;
    return result;
  };

  return { callback, take };
}
