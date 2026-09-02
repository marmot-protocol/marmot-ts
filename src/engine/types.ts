/** @module @category Engine */
import type {
  CiphersuiteImpl,
  ClientState,
  MlsMessage,
  MlsWelcomeMessage,
  ProcessMessageResult,
  Proposal,
} from "ts-mls";

import type { MarmotGroupView } from "../core/client-state.js";
import type { DeferredReason, Disposition } from "../core/inbound.js";
import type { StateNotification } from "./state-notifications.js";

/** A decrypted transport envelope paired with its MLS message. */
export type PeeledMessagePair<TEnvelope> = {
  envelope: TEnvelope;
  message: MlsMessage;
};

/** Crypto boundary between the engine and transport-specific wrapping. */
export interface GroupPeeler<TEnvelope> {
  peelGroupMessages(
    envelopes: TEnvelope[],
    state: ClientState,
  ): Promise<{
    read: PeeledMessagePair<TEnvelope>[];
    unreadable: TEnvelope[];
  }>;

  wrapGroupMessage(message: MlsMessage, state: ClientState): Promise<TEnvelope>;

  /** A stable transport id for an envelope (used to key the ingestion pool). */
  idOf(envelope: TEnvelope): string;
}

/** Staged state awaiting publish confirmation (publish-before-apply). */
export type PendingState = {
  kind: "proposal" | "commit" | "selfUpdate";
  newState: ClientState;
  /**
   * Parent state before apply. Required for BOTH commit-producing kinds —
   * `"commit"` and `"selfUpdate"` (CR-09) — because `confirmPublished` records
   * the applied commit into retained history and the fork tree from it.
   * Absent only for `"proposal"`.
   */
  parentState?: ClientState;
  /**
   * Applied commit MLS message. Required for both `"commit"` and
   * `"selfUpdate"`; absent only for `"proposal"`.
   */
  commitMessage?: MlsMessage;
};

export type ProposalContext = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  groupData: MarmotGroupView;
};

export type ProposalAction<T extends Proposal | Proposal[]> = (
  context: ProposalContext,
) => Promise<T>;

/** Application intent when calling {@link MarmotGroupEngine.send}. */
export type SendIntent =
  | { kind: "applicationMessage"; payload: Uint8Array }
  | { kind: "proposal"; proposal: Proposal }
  | {
      kind: "commit";
      actorPubkey: string;
      extraProposals?: (
        | Proposal
        | ProposalAction<Proposal>
        | (Proposal | ProposalAction<Proposal>)[]
      )[];
      proposalRefs?: string[];
    }
  | { kind: "selfUpdate" };

/** Engine response to {@link MarmotGroupEngine.send}. */
export type SendResult<TEnvelope> =
  | { kind: "applicationMessage"; envelope: TEnvelope; newState: ClientState }
  | { kind: "proposal"; envelope: TEnvelope; pending: PendingState }
  | {
      kind: "groupEvolution";
      envelope: TEnvelope;
      welcome: MlsWelcomeMessage | undefined;
      pending: PendingState;
    }
  | { kind: "selfUpdate"; envelope: TEnvelope; pending: PendingState };

/** An envelope whose MLS message was successfully processed. */
export type ProcessedIngestResult<TEnvelope> = {
  kind: "processed";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
  /**
   * Commit-digest-attributed group-state notifications (D-10/D-11,
   * `convergence.md` "Applying the selected branch"). Optional — populated by
   * the seam that wires notification derivation.
   *
   * ATTRIBUTION (WR-18): these are NOT always this `message`'s own
   * notifications. In the normal in-order case they are. But when this result
   * reports an applied fork resolution, the array is the concatenation of the
   * notifications derived from EVERY commit on the adopted winner chain, while
   * `message` is merely the representative fork-pool envelope the rewind was
   * reported against — it may be unrelated to most of the entries. Never pair
   * `message` with `notifications` positionally; each entry carries its own
   * `commitDigest`, which is the only correct way to attribute it.
   */
  notifications?: StateNotification[];
};

/** A commit rejected by the admin-verification callback. */
export type RejectedIngestResult<TEnvelope> = {
  kind: "rejected";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
  /**
   * Additive, extensible rejection reason (D-03). The protocol-visible
   * category stays `authorization_failed` regardless of which reason fires —
   * `foundation/errors.md` requires pre-convergence rejections be described
   * "by category alone".
   */
  reason?: "admin-policy" | "component-integrity" | "admin-leaf-coupling";
};

/** An envelope skipped without processing. */
export type SkippedIngestResult<TEnvelope> = {
  kind: "skipped";
  envelope: TEnvelope;
  /**
   * Absent for exactly one reason — `"self-evicted"` — because input for a
   * group this client has been removed from is classified by its group
   * before any peel or decrypt (`member-departure.md`: such input "need not
   * be decrypted or authenticated"). Every other skip reason still populates
   * this (D-13).
   */
  message?: MlsMessage;
  reason:
    | "past-epoch"
    | "wrong-wireformat"
    | "self-echo"
    | "duplicate"
    | "beyond-anchor"
    | "missing-retained-anchor"
    | "invalid-app-payload"
    | "self-evicted";
};

/** An envelope that could not be decrypted or processed after all retry attempts. */
export type UnreadableIngestResult<TEnvelope> = {
  kind: "unreadable";
  envelope: TEnvelope;
  errors: unknown[];
  /**
   * The envelope failed to *decrypt* (its kind-445 wrapper did not open against
   * any tried state), as opposed to decoding/processing after decryption. Such
   * failures are retryable: the unlocking epoch/fork state may arrive later, so
   * the engine pools them rather than treating them as terminal. A permanent
   * MLS forward-secrecy failure (`gen-in-past`) is NOT flagged.
   */
  decryptFailure?: boolean;
};

/**
 * An envelope that cannot be processed yet but may become processable once more
 * protocol bytes arrive (`protocol-core/inbound-processing.md` "deferred"). Unlike
 * {@link UnreadableIngestResult}, this is NOT terminal: callers MUST retry when
 * the missing state becomes available rather than treating it as malformed.
 */
export type DeferredIngestResult<TEnvelope> = {
  kind: "deferred";
  envelope: TEnvelope;
  message: MlsMessage;
  reason: DeferredReason;
};

/**
 * An MLS application message that decrypted only on a losing/abandoned branch
 * (`protocol-core/inbound-processing.md`, `convergence.md`). Either it was
 * tentatively delivered as `accepted` on a branch a later convergence rewind
 * abandoned (Marmot v2 delivers eagerly), or it only ever decrypted on a
 * non-canonical fork node during the tree sweep. The spec requires it be
 * reported as `invalidated`, not delivered as accepted output — but the local
 * API is free to expose where it decrypted so a consumer (e.g. a full-history
 * debugger) can still attribute it to its fork.
 *
 * `message` is the MLS application message (the encrypted wrapper); `payload` is
 * its decrypted Marmot app payload bytes, so a consumer can identify the rumor
 * being retracted (e.g. to withdraw it from a UI, or to record it under its
 * fork). `tag` and `epoch` identify the losing branch: `tag` is the hex MLS
 * confirmation tag of the fork-tree node the payload decrypted against (an
 * application message does not change the epoch or confirmation tag, so the node
 * is the delivery branch), and `epoch` is that node's MLS epoch. All three are
 * populated for invalidations the engine produces; they are optional only for
 * backward compatibility with consumers that ignore them.
 */
export type InvalidatedIngestResult<TEnvelope> = {
  kind: "invalidated";
  envelope: TEnvelope;
  message: MlsMessage;
  /** The decrypted Marmot app payload bytes of the invalidated message. */
  payload?: Uint8Array;
  /** Hex confirmation tag of the losing fork-tree node it decrypted against. */
  tag?: string;
  /** MLS epoch of that fork node. */
  epoch?: number;
};

/**
 * A `self_remove`-only commit this client built and staged during ingest because
 * it is the deterministically-elected committer for a peer's departure (B6,
 * `protocol-core/member-departure.md`). It is NOT applied yet — the layer that
 * owns the transport MUST publish `envelope` and then confirm/roll back the
 * `pending` state (publish-before-apply), exactly like a local commit send.
 */
export type AutoCommitIngestResult<TEnvelope> = {
  kind: "autoCommit";
  envelope: TEnvelope;
  pending: PendingState;
  /** This client's own pubkey — the auto-committer (actor) of the commit. */
  actorPubkey: string;
};

/**
 * An inbound commit that removed *this* client from the group — an admin's
 * involuntary `Remove`, or a peer committing this client's own `self_remove`
 * (`protocol-core/member-departure.md`). The commit applied and advanced state
 * to the `removedFromGroup` tombstone: no secrets advanced, so nothing further
 * can be decrypted, and retained history is moot. The transport-owning layer
 * surfaces this (a `removed` event); local-state teardown is left to the app —
 * the engine keeps the tombstone.
 */
export type RemovedIngestResult<TEnvelope> = {
  kind: "removed";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
  /**
   * Commit-digest-attributed group-state notifications (D-10/D-11/D-12) — in
   * particular the `selfRemoved` notification attributed to the very commit
   * that removed us.
   *
   * ATTRIBUTION (WR-18): as with {@link ProcessedIngestResult.notifications},
   * when this result reports an applied fork resolution the array spans the
   * WHOLE adopted winner chain, not just this `message`. Attribute entries by
   * their `commitDigest`, never by position against `message`.
   */
  notifications?: StateNotification[];
};

/**
 * A rewind superseded a previously-accepted commit and withdrew the
 * notifications derived from it (D-11, `convergence.md` "Applying the
 * selected branch"). Unlike every other {@link IngestResult} variant, this
 * carries NO `envelope` and NO `message`: a rewind supersedes a commit, and
 * there is no triggering transport envelope to attribute the withdrawal to.
 * It is generic-free — it is not parameterized on `TEnvelope`.
 */
export type StateInvalidatedIngestResult = {
  kind: "stateInvalidated";
  /** Digest of the superseded commit. */
  commitDigest: Uint8Array;
  /** Epoch the rewind selected as canonical. */
  forkEpoch: number;
  /** Notifications withdrawn because the commit that produced them was superseded. */
  withdrawn: StateNotification[];
};

/** Notifications made observable after a commit has been confirmed locally or adopted. */
export type AppliedNotificationsIngestResult = {
  kind: "appliedNotifications";
  commitDigest: Uint8Array;
  notifications: StateNotification[];
};

/** Result from ingesting group transport envelopes. */
export type IngestResult<TEnvelope> =
  | ProcessedIngestResult<TEnvelope>
  | RejectedIngestResult<TEnvelope>
  | SkippedIngestResult<TEnvelope>
  | DeferredIngestResult<TEnvelope>
  | InvalidatedIngestResult<TEnvelope>
  | AutoCommitIngestResult<TEnvelope>
  | RemovedIngestResult<TEnvelope>
  | UnreadableIngestResult<TEnvelope>
  | AppliedNotificationsIngestResult
  | StateInvalidatedIngestResult;

/** An {@link IngestResult} carrying its protocol-visible {@link Disposition}. */
export type DispositionedIngestResult<TEnvelope> = IngestResult<TEnvelope> & {
  disposition: Disposition;
};
