/** @module @category Core - Engine */
import type {
  CiphersuiteImpl,
  ClientState,
  MlsMessage,
  MlsWelcomeMessage,
  ProcessMessageResult,
  Proposal,
} from "ts-mls";

import type { MarmotGroupView } from "../client-state.js";
import type { Disposition } from "../inbound.js";

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

  wrapGroupMessage(
    message: MlsMessage,
    state: ClientState,
  ): Promise<TEnvelope>;
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
    | "beyond-anchor"
    | "missing-retained-anchor";
};

/** An envelope that could not be decrypted or processed after all retry attempts. */
export type UnreadableIngestResult<TEnvelope> = {
  kind: "unreadable";
  envelope: TEnvelope;
  errors: unknown[];
};

/** Result from ingesting group transport envelopes. */
export type IngestResult<TEnvelope> =
  | ProcessedIngestResult<TEnvelope>
  | RejectedIngestResult<TEnvelope>
  | SkippedIngestResult<TEnvelope>
  | UnreadableIngestResult<TEnvelope>;

/** An {@link IngestResult} carrying its protocol-visible {@link Disposition}. */
export type DispositionedIngestResult<TEnvelope> = IngestResult<TEnvelope> & {
  disposition: Disposition;
};
