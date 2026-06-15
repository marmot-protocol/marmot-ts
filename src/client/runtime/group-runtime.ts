/** @module @category Client - Runtime */
import type { Debugger } from "debug";
import type { NostrEvent } from "applesauce-core/helpers/event";

import type { MarmotGroupView } from "../../core/client-state.js";
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
  getGroupData: () => MarmotGroupView | null;
  confirmPublished: (pending: PendingState) => void;
  publishFailed: (pending: PendingState) => void;
  save: () => Promise<void>;
  log?: Debugger;
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
  readonly #getGroupData: () => MarmotGroupView | null;
  readonly #confirmPublished: (pending: PendingState) => void;
  readonly #publishFailed: (pending: PendingState) => void;
  readonly #save: () => Promise<void>;
  readonly #log?: Debugger;

  constructor(options: GroupRuntimeOptions) {
    this.welcomeDelivery = options.welcomeDelivery;
    this.#getNetwork = options.getNetwork;
    this.#getRelays = options.getRelays;
    this.#getGroupData = options.getGroupData;
    this.#confirmPublished = options.confirmPublished;
    this.#publishFailed = options.publishFailed;
    this.#save = options.save;
    this.#log = options.log;
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

    const response = await this.#getNetwork().publish(relays, envelope);
    if (!hasAck(response)) {
      const errors = Object.values(response)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(`${failurePrefix}: ${errors || "no relay acknowledged"}`);
    }

    return response;
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
