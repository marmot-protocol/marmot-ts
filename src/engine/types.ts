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
  /** Parent state before apply; required for commits (retained-history). */
  parentState?: ClientState;
  /** Applied commit MLS message; required for commits (retained-history). */
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
};

/** A commit rejected by the admin-verification callback. */
export type RejectedIngestResult<TEnvelope> = {
  kind: "rejected";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
};

/** An envelope skipped without processing. */
export type SkippedIngestResult<TEnvelope> = {
  kind: "skipped";
  envelope: TEnvelope;
  message: MlsMessage;
  reason:
    | "past-epoch"
    | "wrong-wireformat"
    | "self-echo"
    | "duplicate"
    | "beyond-anchor"
    | "missing-retained-anchor"
    | "invalid-app-payload";
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
  | UnreadableIngestResult<TEnvelope>;

/** An {@link IngestResult} carrying its protocol-visible {@link Disposition}. */
export type DispositionedIngestResult<TEnvelope> = IngestResult<TEnvelope> & {
  disposition: Disposition;
};
