/** @module @category Engine */
import {
  bytesToBase64,
  type ClientState,
  contentTypes,
  type ContentTypeValue,
  type LeafIndex,
  type MlsMessage,
  type Proposal,
  type ProposalWithSender,
  proposalOrRefTypes,
  senderTypes,
  wireformats,
} from "ts-mls";

/**
 * Marmot v2 carries MLS handshake content — Commits and Proposals — as
 * `PublicMessage`, while application messages stay `PrivateMessage`
 * (`darkmatter/spec/foundation/mls-protocol.md`, "Handshake wire format"). The
 * kind-445 transport wrap provides confidentiality, so relays never see
 * plaintext handshake bytes. The inbound pipeline therefore cannot assume a
 * single wire format when classifying or ordering framed messages; these
 * accessors read the framed fields uniformly across both carriages.
 */

/**
 * The MLS framed content type (application / proposal / commit) carried by a
 * private- or public-message {@link MlsMessage}, or `undefined` for non-framed
 * messages (welcome / key package / group info).
 */
export function framedContentType(
  message: MlsMessage,
): ContentTypeValue | undefined {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return message.privateMessage.contentType;
    case wireformats.mls_public_message:
      return message.publicMessage.content.contentType;
    default:
      return undefined;
  }
}

/**
 * The MLS epoch carried by a private- or public-message {@link MlsMessage}, or
 * `undefined` for non-framed messages. Normalizes to `bigint` regardless of how
 * each wire format models the field.
 */
export function framedEpoch(message: MlsMessage): bigint | undefined {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return BigInt(message.privateMessage.epoch);
    case wireformats.mls_public_message:
      return BigInt(message.publicMessage.content.epoch);
    default:
      return undefined;
  }
}

/**
 * The {@link Proposal}s a commit actually carries, read straight off the wire
 * with NO `processMessage` replay — the union of its inline proposals and the
 * proposals its `ProposalRef` entries name in `parentState.unappliedProposals`.
 *
 * This exists for the one seam that cannot replay: `ForkRecovery`'s CONV-04
 * short-circuit reuses an already-known resulting state precisely BECAUSE the
 * commit cannot be reprocessed (an `UpdatePath` never encrypts a path secret to
 * the committer's own leaf, RFC 9420), so `withCapturedProposals` can never
 * observe that commit's proposals. Without this, that seam had no way to run
 * `validateCommitLegality` and silently grandfathered violations every other
 * seam refuses (CR-04).
 *
 * Returns `undefined` — never a partial list — when the proposal set cannot be
 * fully reconstructed:
 *  - the message is not a public-message commit (a `PrivateMessage`'s content
 *    is encrypted; Marmot v2 wires handshake content as `PublicMessage`, so
 *    this is a defensive branch), or
 *  - a `ProposalRef` names a proposal absent from `parentState`.
 *
 * Callers MUST treat `undefined` as "cannot validate" and fail closed, mirroring
 * `#treeResolution`'s policy for any link it cannot re-validate.
 *
 * @param parentState The state the commit was applied to — the only state whose
 * `unappliedProposals` can resolve this commit's refs.
 */
export function framedCommitProposals(
  message: MlsMessage,
  parentState: ClientState,
): Proposal[] | undefined {
  return framedCommitProposalsWithSender(message, parentState)?.proposals.map(
    (entry) => entry.proposal,
  );
}

/**
 * The sender-attributed form of {@link framedCommitProposals}, plus the
 * commit's own committer leaf index.
 *
 * This reproduces exactly what ts-mls's `applyProposals` assembles as
 * `allProposals` and hands to an {@link IncomingMessageCallback}: an inline
 * (by-value) proposal is attributed to the COMMITTER's leaf, while a
 * `ProposalRef` carries the ORIGINAL proposer's leaf from
 * `parentState.unappliedProposals` (`ts-mls/src/clientState.ts`
 * `applyProposals`). Getting that attribution right is load-bearing — the
 * `refs/marmot/protocol-core/group-messaging.md` admin gate's self_remove rule
 * and its non-admin self-update carve-out
 * both branch on per-proposal sender identity.
 *
 * Exists so `ForkRecovery`'s CONV-04 known-state short-circuit can run the same
 * admin-policy callback that `#treeResolution` runs on the identical class of
 * persisted edge (CR-11) — that seam cannot replay the commit, so it cannot
 * obtain these from `processMessage`.
 *
 * Returns `undefined` under exactly the same conditions as
 * {@link framedCommitProposals}: a non-public-message commit, or a
 * `ProposalRef` absent from `parentState`.
 */
export function framedCommitProposalsWithSender(
  message: MlsMessage,
  parentState: ClientState,
):
  | { proposals: ProposalWithSender[]; senderLeafIndex: LeafIndex | undefined }
  | undefined {
  if (message.wireformat !== wireformats.mls_public_message) return undefined;
  const content = message.publicMessage.content;
  if (content.contentType !== contentTypes.commit) return undefined;

  const senderLeafIndex =
    content.sender.senderType === senderTypes.member
      ? (content.sender.leafIndex as LeafIndex)
      : undefined;

  const proposals: ProposalWithSender[] = [];
  for (const entry of content.commit.proposals) {
    if (entry.proposalOrRefType === proposalOrRefTypes.proposal) {
      // By-value proposals are attributed to the committer, exactly as
      // ts-mls's `applyProposals` does.
      proposals.push({ proposal: entry.proposal, senderLeafIndex });
      continue;
    }
    // ts-mls keys `unappliedProposals` by the base64 of the proposal
    // reference (see its own `applyProposals` lookup). The staged entry
    // already carries the original proposer's leaf.
    const staged =
      parentState.unappliedProposals[bytesToBase64(entry.reference)];
    if (!staged) return undefined;
    proposals.push(staged);
  }
  return { proposals, senderLeafIndex };
}
