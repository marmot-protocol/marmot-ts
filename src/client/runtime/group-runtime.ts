/** @module @category Client - Runtime */
import { protocolVersions, wireformats } from "ts-mls";
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
import type { StateNotification } from "../../engine/state-notifications.js";
import { confirmPublicationRetention } from "./publication-retention.js";
import {
  PendingPublicationStore,
  type PendingPublication,
} from "./pending-publication.js";
import type {
  GroupEffects,
  GroupPublishResult,
  GroupPublishWork,
  WelcomeFanoutOutcome,
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
  confirmPublished: (pending: PendingState) => StateNotification[];
  publishFailed: (pending: PendingState) => void;
  save: () => Promise<void>;
  /** @internal Recovery storage supplied by the group owner. */
  pendingPublications?: PendingPublicationStore;
  restorePending?: (pending: PendingState) => void;
  isApplied?: (pending: PendingState) => boolean;
  /** Owner admission fence, checked before transport and after awaits. */
  assertOpen?: () => void;
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
  /** Admission fence; cancellation stops being reversible once publish starts. */
  signal?: AbortSignal;
};

/** An exact commit remains pending; retry it rather than preparing a replacement. */
export class PublicationUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicationUncertainError";
  }
}

/** Drives group publish effects through Nostr and confirms or rolls back state. */
export class GroupRuntime {
  readonly welcomeDelivery: NostrWelcomeDelivery;

  readonly #pendingPublications?: PendingPublicationStore;
  readonly #restorePending?: (pending: PendingState) => void;
  readonly #isApplied?: (pending: PendingState) => boolean;
  #recovery?: PendingPublication;
  #recoveryApplied = false;
  #hydration?: Promise<void>;
  readonly #publishing = new Map<string, Promise<GroupPublishResult>>();
  #resume?: Promise<GroupPublishResult[]>;

  readonly #getNetwork: () => NostrNetworkInterface;
  readonly #getRelays: () => string[] | undefined;
  readonly #getGroupRef: () => string;
  readonly #getGroupData: () => MarmotGroupView | null;
  readonly #confirmPublished: (pending: PendingState) => StateNotification[];
  readonly #publishFailed: (pending: PendingState) => void;
  readonly #save: () => Promise<void>;
  readonly #assertOpen: () => void;
  readonly #log?: Debugger;
  readonly #audit?: AuditEmitter;

  constructor(options: GroupRuntimeOptions) {
    this.#pendingPublications = options.pendingPublications;
    this.#restorePending = options.restorePending;
    this.#isApplied = options.isApplied;
    this.welcomeDelivery = options.welcomeDelivery;
    this.#getNetwork = options.getNetwork;
    this.#getRelays = options.getRelays;
    this.#getGroupRef = options.getGroupRef;
    this.#getGroupData = options.getGroupData;
    this.#confirmPublished = options.confirmPublished;
    this.#publishFailed = options.publishFailed;
    this.#save = options.save;
    this.#assertOpen = options.assertOpen ?? (() => {});
    this.#log = options.log;
    this.#audit = createAuditEmitter(
      options.audit && options.auditContext
        ? { ...options.auditContext, sink: options.audit }
        : undefined,
    );
  }

  /** Restore the publish gate before admitting inbound or new outbound work. */
  hydratePublication(): Promise<void> {
    return (this.#hydration ??= this.#hydratePublication());
  }

  async #hydratePublication(): Promise<void> {
    if (this.#recovery || !this.#pendingPublications) return;
    const record = await this.#pendingPublications.read();
    if (!record) return;
    if (this.#isApplied?.(record.work.pending)) {
      await this.#pendingPublications.clear();
      return;
    }
    this.#restorePending?.(record.work.pending);
    this.#recovery = record;
  }

  /** Retry the original signed event and exact pending state after a lost ACK. */
  retryPendingPublication(): Promise<GroupPublishResult[]> {
    if (this.#resume) return this.#resume;
    const resume = this.#retryPendingPublication();
    this.#resume = resume;
    void resume
      .finally(() => {
        if (this.#resume === resume) this.#resume = undefined;
      })
      .catch(() => {});
    return resume;
  }

  async #retryPendingPublication(): Promise<GroupPublishResult[]> {
    await this.hydratePublication();
    if (!this.#recovery) return [];
    if (
      this.#recoveryApplied ||
      this.#isApplied?.(this.#recovery.work.pending)
    ) {
      await this.#save();
      await this.#clearPublication();
      return [];
    }
    return this.publishEffects({ publish: [this.#recovery.work] });
  }

  async #preparePublication(work: PendingPublication["work"]): Promise<void> {
    if (!this.#pendingPublications) return;
    if (this.#recovery) {
      if (this.#recovery.work.envelope.id !== work.envelope.id)
        throw new PublicationUncertainError(
          "A prior commit requires byte-identical publication retry",
        );
      return;
    }
    const relays = this.#getRelays();
    if (!relays?.length)
      throw new Error("Group has no relays available to send messages.");
    const retainedWork =
      work.kind === "groupEvolution" ? { ...work, signal: undefined } : work;
    const record = {
      work: retainedWork,
      relays: [...relays],
      acknowledged: false,
    };
    await this.#pendingPublications.write(record);
    this.#recovery = record;
  }

  async #clearPublication(): Promise<void> {
    await this.#pendingPublications?.clear();
    this.#recovery = undefined;
    this.#recoveryApplied = false;
  }

  async publishEffects(effects: GroupEffects): Promise<GroupPublishResult[]> {
    const results: GroupPublishResult[] = [];
    for (const work of effects.publish) {
      results.push(await this.#publishWorkResult(work));
    }
    return results;
  }

  #publishWorkResult(work: GroupPublishWork): Promise<GroupPublishResult> {
    const id = work.envelope.id;
    const active = this.#publishing.get(id);
    if (active) return active;
    const publication = this.#executeWorkResult(work);
    this.#publishing.set(id, publication);
    void publication
      .finally(() => {
        if (this.#publishing.get(id) === publication)
          this.#publishing.delete(id);
      })
      .catch(() => {});
    return publication;
  }

  async #executeWorkResult(
    work: GroupPublishWork,
  ): Promise<GroupPublishResult> {
    switch (work.kind) {
      case "applicationMessage":
        return {
          work,
          response: await this.publishApplication(work.envelope),
          notifications: [],
          persistence: { kind: "notRequired" },
          welcomeDelivery: { kind: "notRequired" },
          retryPublication: false,
        };
      case "proposal":
        return {
          work,
          ...(await this.#publishProposalResult(work.envelope, work.pending)),
          welcomeDelivery: { kind: "notRequired" },
        };
      case "selfUpdate": {
        const result = await this.#publishSelfUpdateResult(
          work.envelope,
          work.pending,
        );
        return {
          work,
          ...result,
          welcomeDelivery: { kind: "notRequired" },
        };
      }
      case "groupEvolution": {
        const result = await this.#publishCommitResult({
          envelope: work.envelope,
          pending: work.pending,
          actorPubkey: work.actorPubkey,
          welcome: work.welcome,
          welcomeRecipients: work.welcomeRecipients,
          signal: work.signal,
        });
        return { work, ...result };
      }
    }
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
          signal: work.signal,
        });
    }
  }

  /**
   * Publish the original signed envelope on every attempt. Its timestamp,
   * ciphertext and source-epoch expiration are fixed before signing; retries
   * must reuse this artifact even after the current group policy changes.
   */
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
    return (await this.#publishProposalResult(envelope, pending)).response;
  }

  async #publishProposalResult(
    envelope: NostrEvent,
    pending: PendingState,
  ): Promise<{
    response: Record<string, PublishResponse>;
    notifications: [];
    persistence: GroupPublishResult["persistence"];
    retryPublication: false;
  }> {
    let response: Record<string, PublishResponse>;
    try {
      response = await this.#publishToGroupRelays(
        envelope,
        "Failed to publish proposal event",
      );
    } catch (error) {
      this.#publishFailed(pending);
      throw error;
    }

    try {
      this.#assertOpen();
      this.#confirmPublished(pending);
    } catch (error) {
      this.#assertOpen();
      return {
        response,
        notifications: [],
        persistence: { kind: "failed", error: errorDetail(error) },
        retryPublication: false,
      };
    }
    const persistence = await this.#persistConfirmedState();
    return {
      response,
      notifications: [],
      persistence,
      retryPublication: false,
    };
  }

  async publishSelfUpdate(
    envelope: NostrEvent,
    pending: PendingState,
  ): Promise<Record<string, PublishResponse>> {
    return (await this.#publishSelfUpdateResult(envelope, pending)).response;
  }

  async #publishSelfUpdateResult(
    envelope: NostrEvent,
    pending: PendingState,
  ): Promise<{
    response: Record<string, PublishResponse>;
    notifications: StateNotification[];
    persistence: GroupPublishResult["persistence"];
    retryPublication: false;
  }> {
    // A selfUpdate is a commit and now stages through `PendingPublish`
    // (CR-09/WR-17), so a publish failure MUST roll the lifecycle back —
    // otherwise the engine is stuck and can never prepare another commit.
    let response: Record<string, PublishResponse>;
    try {
      await this.#preparePublication({ kind: "selfUpdate", envelope, pending });
      response = await this.#publishToGroupRelays(
        envelope,
        "Failed to publish commit event",
      );
    } catch (err) {
      this.#publishFailed(pending);
      throw err;
    }

    let notifications: StateNotification[];
    try {
      this.#assertOpen();
      notifications = this.#confirmPublished(pending);
      if (this.#recovery?.work.pending === pending)
        this.#recoveryApplied = true;
    } catch (error) {
      this.#assertOpen();
      return {
        response,
        notifications: [],
        persistence: { kind: "failed", error: errorDetail(error) },
        retryPublication: false,
      };
    }
    const persistence = await this.#persistConfirmedState();
    return { response, notifications, persistence, retryPublication: false };
  }

  async publishCommit(
    options: PublishCommitOptions,
  ): Promise<Record<string, PublishResponse>> {
    return (await this.#publishCommitResult(options)).response;
  }

  async #publishCommitResult(options: PublishCommitOptions): Promise<{
    response: Record<string, PublishResponse>;
    notifications: StateNotification[];
    persistence: GroupPublishResult["persistence"];
    welcomeDelivery: GroupPublishResult["welcomeDelivery"];
    retryPublication: false;
  }> {
    let response: Record<string, PublishResponse>;
    try {
      options.signal?.throwIfAborted();
      await this.#preparePublication({
        kind: "groupEvolution",
        ...options,
        welcome: options.welcome?.welcome
          ? {
              version: protocolVersions.mls10,
              wireformat: wireformats.mls_welcome,
              welcome: options.welcome.welcome,
            }
          : undefined,
      });
      response = await this.#publishToGroupRelays(
        options.envelope,
        "Failed to publish commit",
        options.signal,
      );
    } catch (err) {
      this.#assertOpen();
      if (this.#recovery && err instanceof PublicationUncertainError) throw err;
      this.#publishFailed(options.pending);
      await this.#clearPublication();
      throw err;
    }

    let notifications: StateNotification[];
    try {
      this.#assertOpen();
      notifications = this.#confirmPublished(options.pending);
      if (this.#recovery?.work.pending === options.pending)
        this.#recoveryApplied = true;
    } catch (error) {
      this.#assertOpen();
      return {
        response,
        notifications: [],
        persistence: { kind: "failed", error: errorDetail(error) },
        welcomeDelivery: { kind: "notRequired" },
        retryPublication: false,
      };
    }
    const persistence = await this.#persistConfirmedState();

    const innerWelcome = options.welcome?.welcome;
    this.#assertOpen();
    let welcomeDelivery: GroupPublishResult["welcomeDelivery"] = {
      kind: "notRequired",
    };
    if (innerWelcome && options.welcomeRecipients?.length) {
      welcomeDelivery = await this.#deliverWelcomes(
        innerWelcome,
        options.actorPubkey,
        options.welcomeRecipients,
      );
    }
    this.#assertOpen();
    return {
      response,
      notifications,
      persistence,
      welcomeDelivery,
      retryPublication: false,
    };
  }

  async #persistConfirmedState(): Promise<GroupPublishResult["persistence"]> {
    this.#assertOpen();
    let persistence: GroupPublishResult["persistence"];
    try {
      await this.#save();
      if (this.#recoveryApplied) await this.#clearPublication();
      persistence = { kind: "succeeded" };
    } catch (error) {
      persistence = { kind: "failed", error: errorDetail(error) };
    }
    this.#assertOpen();
    return persistence;
  }

  async #publishToGroupRelays(
    envelope: NostrEvent,
    failurePrefix: string,
    signal?: AbortSignal,
  ): Promise<Record<string, PublishResponse>> {
    this.#assertOpen();
    const record =
      this.#recovery?.work.envelope.id === envelope.id
        ? this.#recovery
        : undefined;
    const relays = record?.relays ?? this.#getRelays();
    if (!relays)
      throw new Error("Group has no relays available to send messages.");

    this.#emitPublishAttempt(envelope, "group", relays);
    let response: Record<string, PublishResponse>;
    // Audit callbacks can synchronously cancel before any external attempt.
    signal?.throwIfAborted();
    try {
      const network = this.#getNetwork();
      signal?.throwIfAborted();
      response = record?.acknowledged
        ? record.response!
        : await network.publish(relays, envelope);
      this.#assertOpen();
    } catch (error) {
      this.#emitPublishFailure(envelope, "group", relays, "adapter", error);
      this.#assertOpen();
      if (record) {
        record.uncertain = true;
        throw new PublicationUncertainError(
          "Commit publication is uncertain; retry the retained commit",
          { cause: error },
        );
      }
      throw error;
    }
    const acked = Object.entries(response)
      .filter(([url, r]) => r.ok && (!record || relays.includes(url)))
      .map(([url]) => url);
    this.#log?.(
      "publish kind-%d eventId=%s relays=%o acked=%o",
      envelope.kind,
      envelope.id,
      relays,
      acked,
    );
    if (!acked.length) {
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
      const message = `${failurePrefix}: ${errors || "no relay acknowledged"}`;
      if (
        record &&
        (record.uncertain || Object.values(response).some((r) => r.uncertain))
      ) {
        record.uncertain = true;
        throw new PublicationUncertainError(message);
      }
      throw new Error(message);
    }

    if (record && !record.acknowledged) {
      // Persist the real ACK before canonical apply. A failed write leaves the
      // exact pending obligation recoverable and safe to republish.
      record.response = response;
      record.acknowledged = true;
      try {
        await this.#pendingPublications!.write(record);
      } catch (error) {
        throw new PublicationUncertainError(
          "Could not retain publication acknowledgement",
          { cause: error },
        );
      }
    }
    this.#emitPublishOutcome(envelope, "group", response, true);
    confirmPublicationRetention(this, envelope.id);
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

  /**
   * Delivers a Welcome to each recipient via the shared, non-throwing
   * {@link NostrWelcomeDelivery.deliverMany} fanout (D-06/D-07) and reduces
   * the result into {@link WelcomeFanoutOutcome}. This method itself must
   * never throw: it runs after the commit has been confirmed and persisted,
   * so a Welcome failure must never reject the publish (`publishFailed` is
   * exclusive to pre-confirm relay failures — Phase 03.1-02).
   */
  async #deliverWelcomes(
    welcome: import("ts-mls").Welcome,
    actorPubkey: string,
    recipients: WelcomeRecipient[],
  ): Promise<WelcomeFanoutOutcome> {
    const groupData = this.#getGroupData();
    if (!groupData) {
      const message = "MarmotGroupData not found in ClientState.";
      return {
        kind: "attempted",
        outcomes: recipients.map((recipient) => ({
          kind: "failed",
          recipient,
          error: message,
        })),
      };
    }

    this.#log?.(
      "Sending Welcome messages to %d recipient(s)",
      recipients.length,
    );

    try {
      const outcomes = await this.welcomeDelivery.deliverMany({
        welcome,
        author: actorPubkey,
        groupRelays: groupData.relays,
        recipients,
      });

      const failed = outcomes.filter((outcome) => outcome.kind === "failed");
      if (failed.length > 0) {
        this.#log?.(
          "%d/%d Welcome(s) failed to deliver: %O",
          failed.length,
          recipients.length,
          failed.map(
            (outcome) =>
              `${outcome.recipient.pubkey.slice(0, 16)}...: ${outcome.error}`,
          ),
        );
      }

      return { kind: "attempted", outcomes };
    } catch (error) {
      // deliverMany is contractually non-throwing, but this defensively
      // covers an unexpected throw so it can never reject the publish.
      const message = errorDetail(error);
      return {
        kind: "attempted",
        outcomes: recipients.map((recipient) => ({
          kind: "failed",
          recipient,
          error: message,
        })),
      };
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
