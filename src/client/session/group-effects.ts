/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { MlsWelcomeMessage, Proposal } from "ts-mls";

import type { PendingState, ProposalAction } from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { WelcomeRecipient } from "../transport/nostr/welcome-delivery.js";

/** Publishable work produced by group state transitions. */
export type GroupPublishWork =
  | { kind: "applicationMessage"; envelope: NostrEvent }
  | { kind: "proposal"; envelope: NostrEvent; pending: PendingState }
  | { kind: "selfUpdate"; envelope: NostrEvent; pending: PendingState }
  | {
      kind: "groupEvolution";
      envelope: NostrEvent;
      pending: PendingState;
      welcome?: MlsWelcomeMessage;
      actorPubkey: string;
      welcomeRecipients?: WelcomeRecipient[];
    };

/** Effects emitted by the group session layer for a runtime to drive. */
export type GroupEffects = {
  publish: GroupPublishWork[];
};

/** Result of runtime publication for one work item. */
export type GroupPublishResult = {
  work: GroupPublishWork;
  response: Record<string, PublishResponse>;
  /** State changes derived only after a commit publish is acknowledged. */
  notifications: StateNotification[];
};

/** Local protocol intent accepted by {@link GroupSession}. */
export type GroupSessionSendIntent =
  | { kind: "applicationMessage"; payload: Uint8Array }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "selfUpdate" }
  | {
      kind: "commit";
      actorPubkey: string;
      extraProposals?: (
        | Proposal
        | ProposalAction<Proposal>
        | (Proposal | ProposalAction<Proposal>)[]
      )[];
      proposalRefs?: string[];
      welcomeRecipients?: WelcomeRecipient[];
    };
