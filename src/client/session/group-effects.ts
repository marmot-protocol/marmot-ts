/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { MlsWelcomeMessage, Proposal } from "ts-mls";

import type { PendingState, ProposalAction } from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { PublishResponse } from "../nostr-interface.js";
import type {
  WelcomeDeliveryOutcome,
  WelcomeRecipient,
} from "../transport/nostr/welcome-delivery.js";

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

/** Outcome of fallible work performed around a confirmed publication. */
export type AncillaryEffectOutcome =
  | { kind: "notRequired" }
  | { kind: "succeeded" }
  | { kind: "failed"; error: string };

/**
 * Outcome of the Welcome fanout performed after a confirmed group-evolution
 * publication. Unlike {@link AncillaryEffectOutcome}, a Welcome fanout
 * reports one outcome per invitee (via {@link WelcomeDeliveryOutcome}) so a
 * failed invitee is independently retryable (FOUND-04, D-06) — `persistence`
 * stays a single {@link AncillaryEffectOutcome} because persistence is one
 * write, not per-recipient.
 */
export type WelcomeFanoutOutcome =
  | { kind: "notRequired" }
  | { kind: "attempted"; outcomes: WelcomeDeliveryOutcome[] };

/** Result of runtime publication for one work item. */
export type GroupPublishResult = {
  work: GroupPublishWork;
  response: Record<string, PublishResponse>;
  /** State changes derived only after a commit publish is acknowledged. */
  notifications: StateNotification[];
  /** Persistence performed after the publication became irreversible. */
  persistence: AncillaryEffectOutcome;
  /** Welcome fanout performed after persistence for group-evolution commits. */
  welcomeDelivery: WelcomeFanoutOutcome;
  /** Confirmed work must never be republished, even if ancillary work failed. */
  retryPublication: boolean;
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
