/** @module @category Client - Runtime */
import type { Debugger } from "debug";
import type { NostrEvent } from "applesauce-core/helpers/event";

import type { MarmotGroupView } from "../../core/client-state.js";
import {
  createAuditEmitter,
  errorDetail,
  type AuditContextOptions,
  type AuditEmitter,
  type AuditSink,
} from "../../audit/index.js";
import type { PendingState } from "../../engine/types.js";
import { hasAck } from "../../utils/index.js";
import type {
  GroupEffects,
  GroupPublishResult,
  GroupPublishWork,
} from "../session/group-effects.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../nostr-interface.js";
import {
  NostrWelcomeDelivery,
  type WelcomeRecipient,
} from "../transport/nostr/welcome-delivery.js";

export type GroupRuntimeOptions = {
  welcomeDelivery: NostrWelcomeDelivery;
  getNetwork: () => NostrNetworkInterface;
  getRelays: () => string[] | undefined;
  getGroupRef: () => string;
  getGroupData: () => MarmotGroupView | null;
  confirmPublished: (pending: PendingState) => void;
  publishFailed: (pending: PendingState) => void;
  save: () => Promise<void>;
  log?: Debugger;
  audit?: AuditSink;
  auditContext?: AuditContextOptions;
};

export type PublishCommitOptions = {
  envelope: NostrEvent;
  pending: PendingState;
  actorPubkey: string;
  welcome?: { welcome?: import("ts-mls").Welcome };
  welcomeRecipients?: WelcomeRecipient[];
};

/** Drives group publish effects through Nostr and confirms or rolls back state. */
export class GroupRuntime {
  readonly welcomeDelivery: NostrWelcomeDelivery;

  readonly #getNetwork: () => NostrNetworkInterface;
  readonly #getRelays: () => string[] | undefined;
  readonly #getGroupRef: () => string;
  readonly #getGroupData: () => MarmotGroupView | null;
  readonly #confirmPublished: (pending: PendingState) => void;
  readonly #publishFailed: (pending: PendingState) => void;
  readonly #save: () => Promise<void>;
  readonly #log?: Debugger;
  readonly #audit?: AuditEmitter;

  constructor(options: GroupRuntimeOptions) {
    this.welcomeDelivery = options.welcomeDelivery;
    this.#getNetwork = options.getNetwork;
    this.#getRelays = options.getRelays;
    this.#getGroupRef = options.getGroupRef;
    this.#getGroupData = options.getGroupData;
    this.#confirmPublished = options.confirmPublished;
    this.#publishFailed = options.publishFailed;
    this.#save = options.save;
    this.#log = options.log;
    this.#audit = createAuditEmitter(
      options.audit && options.auditContext
        ? { ...options.auditContext, sink: options.audit }
        : undefined,
    );
  }

  async publishEffects(effects: GroupEffects): Promise<GroupPublishResult[]> {
    const results: GroupPublishResult[] = [];
    for (const work of effects.publish) {
      results.push({ work, response: await this.publishWork(work) });
    }
    return results;
  }

  async publishWork(
    work: GroupPublishWork,
  ): Promise<Record<string, PublishResponse>> {
    switch (work.kind) {
      case "applicationMessage":
        return this.publishApplication(work.envelope);
      case "proposal":
        return this.publishProposal(work.envelope, work.pending);
      case "selfUpdate":
        return this.publishSelfUpdate(work.envelope, work.pending);
      case "groupEvolution":
        return this.publishCommit({
          envelope: work.envelope,
          pending: work.pending,
          actorPubkey: work.actorPubkey,
          welcome: work.welcome,
          welcomeRecipients: work.welcomeRecipients,
        });
    }
  }

  async publishApplication(
    envelope: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    return this.#publishToGroupRelays(
      envelope,
      "Failed to publish application message",
    );
  }

  async publishProposal(
    envelope: NostrEvent,
    pending: PendingState,
  ): Promise<Record<string, PublishResponse>> {
    const response = await this.#publishToGroupRelays(
      envelope,
      "Failed to publish proposal event",
    );
    this.#confirmPublished(pending);
    await this.#save();
    return response;
  }

  async publishSelfUpdate(
    envelope: NostrEvent,
    pending: PendingState,
  ): Promise<Record<string, PublishResponse>> {
    const response = await this.#publishToGroupRelays(
      envelope,
      "Failed to publish commit event",
    );
    this.#confirmPublished(pending);
    await this.#save();
    return response;
  }

  async publishCommit(
    options: PublishCommitOptions,
  ): Promise<Record<string, PublishResponse>> {
    let response: Record<string, PublishResponse>;
    try {
      response = await this.#publishToGroupRelays(
        options.envelope,
        "Failed to publish commit",
      );
    } catch (err) {
      this.#publishFailed(options.pending);
      throw err;
    }

    this.#confirmPublished(options.pending);
    await this.#save();

    const innerWelcome = options.welcome?.welcome;
    if (innerWelcome && options.welcomeRecipients?.length) {
      await this.#deliverWelcomes(
        innerWelcome,
        options.actorPubkey,
        options.welcomeRecipients,
      );
    }

    return response;
  }

  async #publishToGroupRelays(
    envelope: NostrEvent,
    failurePrefix: string,
  ): Promise<Record<string, PublishResponse>> {
    const relays = this.#getRelays();
    if (!relays)
      throw new Error("Group has no relays available to send messages.");

    this.#emitPublishAttempt(envelope, "group", relays);
    let response: Record<string, PublishResponse>;
    try {
      response = await this.#getNetwork().publish(relays, envelope);
    } catch (error) {
      this.#emitPublishFailure(envelope, "group", relays, "adapter", error);
      throw error;
    }
    const acked = Object.entries(response)
      .filter(([, r]) => r.ok)
      .map(([url]) => url);
    this.#log?.(
      "publish kind-%d eventId=%s relays=%o acked=%o",
      envelope.kind,
      envelope.id,
      relays,
      acked,
    );
    if (!hasAck(response)) {
      const errors = Object.values(response)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      this.#emitPublishOutcome(envelope, "group", response, false);
      this.#emitPublishFailure(
        envelope,
        "group",
        relays,
        "required_acks",
        errors || "no relay acknowledged",
      );
      throw new Error(`${failurePrefix}: ${errors || "no relay acknowledged"}`);
    }

    this.#emitPublishOutcome(envelope, "group", response, true);
    return response;
  }

  #emitPublishAttempt(
    envelope: NostrEvent,
    targetKind: string,
    relays: string[],
  ): void {
    this.#audit?.emit(
      {
        type: "publish_attempt",
        msg_id: envelope.id,
        artifact_kind: artifactKindFromNostrEvent(envelope),
        target_kind: targetKind,
        transport: transportEnvelopeFromNostrEvent(envelope),
        relay_urls: relays,
        required_acks: 1,
      },
      { groupRef: this.#groupRef() },
    );
  }

  #emitPublishOutcome(
    envelope: NostrEvent,
    targetKind: string,
    response: Record<string, PublishResponse>,
    metRequiredAcks: boolean,
  ): void {
    this.#audit?.emit(
      {
        type: "publish_outcome",
        msg_id: envelope.id,
        artifact_kind: artifactKindFromNostrEvent(envelope),
        target_kind: targetKind,
        transport: transportEnvelopeFromNostrEvent(envelope),
        accepted_relay_urls: Object.keys(response).filter(
          (url) => response[url]?.ok,
        ),
        failed_relays: Object.values(response)
          .filter((relay) => !relay.ok)
          .map((relay) => ({
            relay_url: relay.from,
            reason: relay.message ?? "publish_failed",
          })),
        required_acks: 1,
        met_required_acks: metRequiredAcks,
      },
      { groupRef: this.#groupRef() },
    );
  }

  #emitPublishFailure(
    envelope: NostrEvent,
    targetKind: string,
    relays: string[],
    stage: string,
    reason: unknown,
  ): void {
    this.#audit?.emit(
      {
        type: "publish_failure",
        msg_id: envelope.id,
        artifact_kind: artifactKindFromNostrEvent(envelope),
        stage,
        target_kind: targetKind,
        transport: transportEnvelopeFromNostrEvent(envelope),
        relay_urls: relays,
        reason: typeof reason === "string" ? reason : errorDetail(reason),
      },
      { groupRef: this.#groupRef() },
    );
  }

  #groupRef(): string | undefined {
    return this.#getGroupRef();
  }

  async #deliverWelcomes(
    welcome: import("ts-mls").Welcome,
    actorPubkey: string,
    recipients: WelcomeRecipient[],
  ): Promise<void> {
    const groupData = this.#getGroupData();
    if (!groupData)
      throw new Error("MarmotGroupData not found in ClientState.");

    this.#log?.(
      "Sending Welcome messages to %d recipient(s)",
      recipients.length,
    );
    const welcomeResults = await Promise.allSettled(
      recipients.map((recipient) =>
        this.welcomeDelivery.deliver({
          welcome,
          author: actorPubkey,
          groupRelays: groupData.relays,
          recipient,
        }),
      ),
    );

    const failureDetails = welcomeResults
      .map((result, i) => ({ result, recipient: recipients[i] }))
      .filter(
        (
          item,
        ): item is {
          result: PromiseRejectedResult;
          recipient: WelcomeRecipient;
        } => item.result.status === "rejected",
      )
      .map((item) => {
        const msg =
          item.result.reason instanceof Error
            ? item.result.reason.message
            : String(item.result.reason);
        return `${item.recipient.pubkey.slice(0, 16)}...: ${msg}`;
      });

    if (failureDetails.length > 0) {
      this.#log?.(
        "%d/%d Welcome(s) failed to deliver: %O",
        failureDetails.length,
        recipients.length,
        failureDetails,
      );
      throw new Error(
        `Failed to deliver ${failureDetails.length}/${recipients.length} Welcome message(s): ${failureDetails.join(
          "; ",
        )}`,
      );
    }
  }
}

function artifactKindFromNostrEvent(event: NostrEvent) {
  if (event.kind === 444) return "welcome";
  if (event.kind === 445) return "unknown";
  return "unknown";
}

function transportEnvelopeFromNostrEvent(event: NostrEvent) {
  const groupTag = event.tags.find((tag) => tag[0] === "h")?.[1];
  return {
    transport: "nostr",
    wire_id: event.id,
    wire_kind: event.kind.toString(),
    wire_pubkey_hex: event.pubkey,
    transport_group_id: groupTag,
    nostr_event_id: event.id,
    nostr_kind: event.kind,
    nostr_pubkey_hex: event.pubkey,
  };
}
