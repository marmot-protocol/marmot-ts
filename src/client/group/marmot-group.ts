/** @module @category Client - Group */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import {
  bytesToHex,
  getEventHash,
  type NostrEvent,
} from "applesauce-core/helpers/event";
import { Debugger } from "debug";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  MlsMessage,
  type ProcessMessageResult,
  Proposal,
} from "ts-mls";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  getMarmotGroupView,
  type MarmotGroupView,
  serializeClientState,
} from "../../core/client-state.js";
import type { Disposition } from "../../core/inbound.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import type {
  DispositionedIngestResult as EngineDispositionedIngestResult,
  IngestResult as EngineIngestResult,
  ProposalAction,
  ProposalContext,
} from "../../engine/types.js";
import { serializeApplicationRumor } from "../../core/group-message.js";
import { getKeyPackage } from "../../core/key-package-event.js";
import { getCredentialPubkey } from "../../core/credential.js";
import {
  canonicalizeMimeType,
  decryptMediaFile,
  deriveMediaEncryptionKey,
  encryptMediaFile,
  type MediaAttachment,
  MIP04_VERSION,
} from "../../core/media.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { createWelcomeRumor } from "../../core/welcome.js";
import { logger } from "../../utils/debug.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { createGiftWrap, hasAck } from "../../utils/index.js";
import { unixNow } from "../../utils/nostr.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { proposeInviteUser } from "./proposals/invite-user.js";
import { proposeLeaveGroup } from "./proposals/leave-group.js";
import { NostrGroupPeeler } from "./nostr-peeler.js";

export { createAdminCommitPolicyCallback } from "../../engine/admin-policy.js";
export type { ProposalAction, ProposalContext } from "../../engine/types.js";

/** An error that is thrown when a group has no relays available to send messages. */
export class NoGroupRelaysError extends Error {
  constructor() {
    super("Group has no relays available to send messages.");
  }
}

/** An error that is thrown the client is unable to find the MarmotGroupData in the ClientState of a group. */
export class NoMarmotGroupDataError extends Error {
  constructor() {
    super("MarmotGroupData not found in ClientState.");
  }
}

/** An event whose MLS message was successfully processed */
export type ProcessedIngestResult = {
  kind: "processed";
  /** The result of processing the event */
  result: ProcessMessageResult;
  /** The event that was processed */
  event: NostrEvent;
  /** The MLS message that was processed */
  message: MlsMessage;
};

/** A commit that was rejected by the admin-verification callback */
export type RejectedIngestResult = {
  kind: "rejected";
  /** The result returned by processMessage (actionTaken === "reject") */
  result: ProcessMessageResult;
  /** The event that was rejected */
  event: NostrEvent;
  /** The MLS message that was rejected */
  message: MlsMessage;
};

/** An event that was skipped without processing */
export type SkippedIngestResult = {
  kind: "skipped";
  /** The event that was skipped */
  event: NostrEvent;
  /** The decoded MLS message */
  message: MlsMessage;
  /**
   * Why the event was skipped:
   * - `"past-epoch"` – commit belongs to an epoch we have already advanced past
   * - `"wrong-wireformat"` – the MLS wireformat is unexpected for a group message
   * - `"self-echo"` – this event was sent by us; state was already advanced at send time
   * - `"beyond-anchor"` – competing commit forks from before our retained anchor;
   *   the history needed to evaluate it was already pruned (retained-history.md)
   * - `"missing-retained-anchor"` – competing commit forks inside the rollback
   *   horizon but its retained anchor state was lost; the group can no longer
   *   converge and transitions to `Unrecoverable`
   */
  reason:
    | "past-epoch"
    | "wrong-wireformat"
    | "self-echo"
    | "beyond-anchor"
    | "missing-retained-anchor";
};

/** An event that could not be decrypted or processed after all retry attempts */
export type UnreadableIngestResult = {
  kind: "unreadable";
  /** The event that could not be processed */
  event: NostrEvent;
  /** All errors captured across every retry attempt, in chronological order */
  errors: unknown[];
};

/** Result from ingesting a group event */
export type IngestResult =
  | ProcessedIngestResult
  | RejectedIngestResult
  | SkippedIngestResult
  | UnreadableIngestResult;

/**
 * An {@link IngestResult} carrying its protocol-visible inbound-processing
 * {@link Disposition} (`protocol-core/inbound-processing.md`). This is what
 * {@link MarmotGroup.ingest} yields, so consumers can act on the classification
 * (accepted / stale / deferred / invalidated) without re-deriving it.
 */
export type DispositionedIngestResult = IngestResult & {
  /** The protocol-visible disposition classifying this result. */
  disposition: Disposition;
};

/**
 * Maps a client-facing {@link IngestResult} (`event` field) to its protocol-visible
 * {@link Disposition} via the transport-agnostic engine helper.
 */
export function ingestResultDisposition(result: IngestResult): Disposition {
  const { event, ...rest } = result;
  return engineIngestResultDisposition({
    ...rest,
    envelope: event,
  } as EngineIngestResult<NostrEvent>);
}

/**
 * The minimum interface for a group to store them MLS messages
 * Implementations should extend this with methods for querying and loading stored messages
 */
export interface BaseGroupHistory {
  /** Saves a new application message to the group history */
  saveMessage(message: Uint8Array): Promise<void>;
  /** Purge the group history, called when group is destroyed */
  purgeMessages(): Promise<void>;
}

/** Shape of the stored media in a {@link BaseGroupMedia} implementation */
export type StoredMedia = {
  /** Plaintext (decrypted) file bytes. */
  data: Uint8Array;
  /** The full MIP-04 attachment metadata associated with this blob. */
  attachment: MediaAttachment;
};

/** A factory function that creates a {@link BaseGroupHistory} instance for a group id */
export type GroupHistoryFactory<
  THistory extends BaseGroupHistory | undefined = undefined,
> = (groupId: Uint8Array) => THistory;

/** The minimal implementation of a group media store */
export interface BaseGroupMedia {
  /** Adds a new media entry to the group media store */
  addMedia(sha256: string, entry: StoredMedia): Promise<void>;
  /** Retrieves a media entry from the group media store */
  getMedia(sha256: string): Promise<StoredMedia | null>;
  /** Removes a media entry from the group media store */
  removeMedia(sha256: string): Promise<void>;
  /** Lists all media entries in the group media store */
  listMedia(): Promise<MediaAttachment[]>;
  /** Clears all media entries from the group media store */
  clearMedia(): Promise<void>;
}

/** A factory function that creates a {@link BaseGroupHistory} instance for a group id */
export type GroupMediaFactory<
  TMedia extends BaseGroupMedia | undefined = undefined,
> = (groupId: Uint8Array) => TMedia;

/** A method that creates a {@link ProposalAction} from a set of arguments */
export type ProposalBuilder<
  Args extends unknown[],
  T extends Proposal | Proposal[],
> = (...args: Args) => ProposalAction<T>;

export type MarmotGroupOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The key-value backend where serialized group state bytes are persisted */
  store: GenericKeyValueStore<SerializedClientState>;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The ciphersuite implementation to use for the group */
  ciphersuite: CiphersuiteImpl;
  /** The nostr relay pool to use for the group. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
  /** The storage interface for the groups application message history (optional) */
  history?: THistory | GroupHistoryFactory<THistory>;
  /**
   * Backend (or pre-wrapped store) for the plaintext blob cache used by
   * {@link MarmotGroup.decryptMedia}. Defaults to an in-memory cache when
   * not provided.
   */
  media?: TMedia | GroupMediaFactory<TMedia>;
};

/** Information about a welcome recipient */
export type WelcomeRecipient = {
  /** The recipient's Nostr public key */
  pubkey: string;
  /** The ID of KeyPackage event (kind 30443) used for add operation */
  keyPackageEventId: string;
  /** The KeyPackage event (kind 30443) used for add operation */
  keyPackageEvent: NostrEvent;
};

/** Map of events that can be emitted by a MarmotGroup */
export type MarmotGroupEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the group state is updated */
  stateChanged: (state: ClientState) => void;
  /** Emitted when a new application message is received */
  applicationMessage: (message: Uint8Array) => void;
  /** Emitted when the group state is saved */
  stateSaved: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when the group is destroyed */
  destroyed: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when history persistence fails (best-effort, non-blocking) */
  historyError: (error: Error) => void;
};

function mapEngineIngestResult(
  result: EngineDispositionedIngestResult<NostrEvent>,
): DispositionedIngestResult {
  const { envelope, disposition, ...rest } = result;
  return { ...rest, event: envelope, disposition };
}

/**
 * The main class for interacting with a MLS group
 * @template THistory - The type of the history store to use for the group, must implement the {@link BaseGroupHistory} interface. (Default is no history store)
 */
export class MarmotGroup<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> extends EventEmitter<MarmotGroupEvents<THistory, TMedia>> {
  /** The key-value backend where serialized group state bytes are persisted */
  readonly store: GenericKeyValueStore<SerializedClientState>;

  /** The signer used for the clients identity */
  readonly signer: EventSigner;

  /** The ciphersuite implementation to use for the group */
  readonly ciphersuite: CiphersuiteImpl;

  /** The nostr relay pool to use for the group */
  readonly network: NostrNetworkInterface;

  /** The storage interface for the groups application message history */
  readonly history: THistory;

  /** The storage interface for the groups media */
  readonly media: TMedia;

  /** Whether group state has been modified */
  dirty = false;

  readonly #engine: MarmotGroupEngine<NostrEvent>;
  readonly #peeler: NostrGroupPeeler;
  #groupData: MarmotGroupView | null = null;

  /**
   * Event IDs of application messages we sent ourselves, used to skip self-echoes in ingest()
   * NOTE: this is not persisted at the moment, its only in memory and used to skip self-echoes in ingest()
   */
  readonly #sentEventIds = new Set<string>();

  /** In-flight media decrypts keyed by plaintext SHA-256 hex. */
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  private log: Debugger;

  get id() {
    return this.state.groupContext.groupId;
  }

  /** The group id as a hex string */
  idStr: string;

  /** Read the current group state */
  get state() {
    return this.#engine.state;
  }

  /**
   * The group's lifecycle state (`group-state.md`). A new local commit may only
   * be prepared while `Stable`; the commit flow moves through `PendingPublish`
   * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
   * commit applying) and back to `Stable`.
   */
  get lifecycle() {
    return this.#engine.lifecycle;
  }

  get groupData() {
    if (!this.#groupData) this.#groupData = getMarmotGroupView(this.state);
    return this.#groupData;
  }

  get unappliedProposals() {
    return this.#engine.state.unappliedProposals;
  }

  /**
   * Overrides the current group state
   * @warning It is not recommended to use this
   */
  set state(newState: ClientState) {
    this.#engine.state = newState;
  }

  get relays() {
    return this.groupData?.relays;
  }

  constructor(
    state: ClientState,
    options: MarmotGroupOptions<THistory, TMedia>,
  ) {
    super();
    this.store = options.store;
    this.signer = options.signer;
    this.ciphersuite = options.ciphersuite;
    this.network = options.network;

    this.#peeler = new NostrGroupPeeler(this.ciphersuite);
    this.#engine = new MarmotGroupEngine({
      state,
      ciphersuite: this.ciphersuite,
      peeler: this.#peeler,
      onStateChanged: (newState) => {
        this.dirty = true;
        this.#groupData = null;
        this.emit("stateChanged", newState);
      },
    });

    if (options.history) {
      if (typeof options.history === "function") {
        this.history = options.history(this.id);
      } else {
        this.history = options.history;
      }
    } else {
      this.history = undefined as THistory;
    }

    if (options.media) {
      if (typeof options.media === "function") {
        this.media = options.media(this.id);
      } else {
        this.media = options.media;
      }
    } else {
      this.media = undefined as TMedia;
    }

    this.idStr = bytesToHex(this.id);
    this.log = logger.extend(`group:${this.idStr.slice(0, 8)}`);
  }

  /** Creates a new {@link MarmotGroup} instance from a {@link ClientState} object */
  static async fromClientState<
    THistory extends BaseGroupHistory | undefined = undefined,
    TMedia extends BaseGroupMedia | undefined = undefined,
  >(
    state: ClientState,
    options: Omit<MarmotGroupOptions<THistory, TMedia>, "ciphersuite"> & {
      cryptoProvider?: CryptoProvider;
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const cipherSuite = await cryptoProvider.getCiphersuiteImpl(
      state.groupContext.cipherSuite,
    );

    return new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
  }

  /**
   * Persists any pending changes to the group state in the store.
   *
   * @param force - When `true`, writes the current state even if `dirty` is
   *   `false`. Useful for persisting the initial state of a freshly constructed
   *   group (e.g. after `createGroup` / `joinGroupFromWelcome` / import) without
   *   having to mutate `dirty` externally.
   */
  async save(force = false) {
    if (!force && !this.dirty) return;

    const stateBytes = serializeClientState(this.state);
    await this.store.setItem(bytesToHex(this.id), stateBytes);
    this.dirty = false;
    this.emit("stateSaved", this);
  }

  /**
   * Performs a self-update commit (no proposals) to rotate this member's leaf key material.
   *
   * This is required by MIP-02 for forward secrecy after joining from a Welcome.
   *
   * Unlike {@link commit}, this operation is allowed for non-admin members.
   */
  async selfUpdate(): Promise<Record<string, PublishResponse>> {
    this.log("self-update commit");
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();

    const sendResult = await this.#engine.send({ kind: "selfUpdate" });
    if (sendResult.kind !== "selfUpdate") {
      throw new Error("Expected selfUpdate result from selfUpdate send");
    }

    const response = await this.network.publish(relays, sendResult.envelope);
    if (!hasAck(response)) {
      throw new Error("Failed to publish commit event: no relay acknowledged");
    }

    this.#engine.confirmPublished(sendResult.pending);
    await this.save();

    return response;
  }

  /**
   * Leaves the group by publishing a self-remove proposal for each of the
   * caller's leaf nodes, then purging all local group data from storage.
   *
   * Per RFC 9420 §12.4 a member cannot commit a Remove targeting their own
   * leaf. Instead, a Remove *proposal* is sent so that the next committer
   * (e.g. an admin calling {@link commit}) can include it and finalise the
   * departure. At least one relay must acknowledge the proposals before local
   * state is destroyed; if no relay acks, an error is thrown and local state
   * is preserved so the caller can retry.
   *
   * Unlike {@link commit}, this operation is allowed for non-admin members.
   *
   * @returns The relay publish responses for the leave proposal event(s).
   */
  async leave(): Promise<Record<string, PublishResponse>> {
    this.log("leave group");
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();

    const ownPubkey = await this.signer.getPublicKey();
    const removeProposals = await proposeLeaveGroup(ownPubkey)({
      state: this.state,
      ciphersuite: this.ciphersuite,
      groupData,
    });

    const responses: Record<string, PublishResponse> = {};
    for (const proposal of removeProposals) {
      const response = await this.sendProposal(proposal);
      Object.assign(responses, response);
    }

    if (!hasAck(responses)) {
      throw new Error(
        "Failed to publish leave proposals: no relay acknowledged. Local state preserved — retry leave() to try again.",
      );
    }

    await this.destroy();

    return responses;
  }

  /**
   * Creates and publishes a proposal as a private MLS message.
   * @returns Promise resolving to the publish response from the relays
   */
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    action: ProposalBuilder<Args, T>,
    ...args: Args
  ): Promise<Record<string, PublishResponse>>;
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    action: ProposalAction<T>,
  ): Promise<Record<string, PublishResponse>>;
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    ...args: Args
  ): Promise<Record<string, PublishResponse>> {
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const context: ProposalContext = {
      state: this.state,
      ciphersuite: this.ciphersuite,
      groupData: this.groupData,
    };

    let proposals: T;
    if (args.length === 1) {
      proposals = await (args[0] as ProposalAction<T>)(context);
    } else {
      proposals = await (args[0] as ProposalBuilder<Args, T>)(...args)(context);
    }

    if (!proposals) {
      throw new Error("Proposal is undefined. This should not happen.");
    }

    const proposalArray = Array.isArray(proposals) ? proposals : [proposals];

    const responses: Record<string, PublishResponse> = {};
    for (const proposal of proposalArray) {
      const response = await this.sendProposal(proposal as Proposal);
      Object.assign(responses, response);
    }

    return responses;
  }

  /** Sends a proposal to the group relays */
  async sendProposal(
    proposal: Proposal,
  ): Promise<Record<string, PublishResponse>> {
    const sendResult = await this.#engine.send({ kind: "proposal", proposal });
    if (sendResult.kind !== "proposal") {
      throw new Error("Expected proposal result from proposal send");
    }

    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();

    const response = await this.network.publish(relays, sendResult.envelope);
    if (!hasAck(response)) {
      throw new Error(
        "Failed to publish proposal event: no relay acknowledged",
      );
    }

    this.#engine.confirmPublished(sendResult.pending);
    await this.save();

    return response;
  }

  /**
   * Creates and sends an application message to the group.
   *
   * Application messages contain actual content shared within the group (e.g., chat messages,
   * reactions, etc.). The inner Nostr event (rumor) must be unsigned and will be serialized
   * according to the Marmot spec.
   *
   * @param rumor - The unsigned Nostr event (rumor) to send as an application message
   * @returns Promise resolving to the publish response from the relays
   */
  async sendApplicationRumor(
    rumor: Rumor,
  ): Promise<Record<string, PublishResponse>> {
    this.log("sending application rumor kind:%d", rumor.kind);
    const applicationData = serializeApplicationRumor(rumor);

    const sendResult = await this.#engine.send({
      kind: "applicationMessage",
      payload: applicationData,
    });

    this.#sentEventIds.add(sendResult.envelope.id);

    if (this.history) {
      try {
        await this.history.saveMessage(applicationData);
      } catch (err) {
        this.emit("historyError", err as Error);
      }
    }

    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();
    const response = await this.network.publish(relays, sendResult.envelope);
    if (!hasAck(response)) {
      const errors = Object.values(response)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(
        `Failed to publish application message: ${
          errors || "no relay acknowledged"
        }`,
      );
    }

    return response;
  }

  /**
   * Creates and sends a kind 9 chat message to the group.
   *
   * This is a convenience wrapper around {@link sendApplicationRumor} that constructs
   * the rumor for you. The message is encrypted via MLS and published as a kind 445
   * group event to the group's relays.
   *
   * @param content - The text content of the chat message
   * @param tags - Optional Nostr tags to include on the rumor
   * @returns Promise resolving to the publish response from the relays
   */
  async sendChatMessage(
    content: string,
    tags: string[][] = [],
  ): Promise<Record<string, PublishResponse>> {
    const pubkey = await this.signer.getPublicKey();
    const rumor: Rumor = {
      id: "",
      kind: 9,
      pubkey,
      created_at: unixNow(),
      content,
      tags,
    };
    rumor.id = getEventHash(rumor);
    return this.sendApplicationRumor(rumor);
  }

  /**
   * Creates a commit from proposals and sends it to the group.
   *
   * Proposal sources (can be combined):
   * - **`extraProposals`** — inline {@link Proposal} values and/or {@link ProposalAction}
   *   factories (each factory receives {@link ProposalContext}).
   * - **`proposalRefs`** — keys into `state.unappliedProposals` for proposals already
   *   held in state.
   *
   * If **`extraProposals`** or **`proposalRefs`** is present on `options` (including as
   * an empty array), the commit uses exactly the merged, resolved list in array order
   * (`extraProposals` first, then each ref in `proposalRefs`). Two empty arrays means a
   * no-proposal commit. If neither property is set, the MLS layer commits every proposal
   * currently in `state.unappliedProposals`.
   *
   * Requires a group admin. Publishes the commit to group relays and updates local state
   * after an ACK. When MLS returns a welcome and **`welcomeRecipients`** is non-empty,
   * sends gift-wrapped Welcome rumors (only after the commit ACK, per MIP-02).
   *
   * @returns Per-relay publish responses for the commit group event
   */
  async commit(options?: {
    /**
     * Flattened in order; function entries are async factories;
     * resolved proposals are ordered before any from `proposalRefs`.
     */
    extraProposals?: (
      | Proposal
      | ProposalAction<Proposal>
      | (Proposal | ProposalAction<Proposal>)[]
    )[];
    /** Lookup keys on `state.unappliedProposals`; an unknown key throws. */
    proposalRefs?: string[];
    /**
     * Per-recipient key-package metadata for MLS Welcome delivery after
     * adds; see {@link WelcomeRecipient}.
     */
    welcomeRecipients?: WelcomeRecipient[];
  }): Promise<Record<string, PublishResponse>> {
    this.log(
      "committing (%d extra proposals, %d recipients)",
      options?.extraProposals?.length ?? 0,
      options?.welcomeRecipients?.length ?? 0,
    );
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const actorPubkey = await this.signer.getPublicKey();
    const sendResult = await this.#engine.send({
      kind: "commit",
      actorPubkey,
      extraProposals: options?.extraProposals,
      proposalRefs: options?.proposalRefs,
    });

    if (sendResult.kind !== "groupEvolution") {
      throw new Error("Expected groupEvolution result from commit send");
    }

    let response: Record<string, PublishResponse>;
    try {
      const relays = this.relays;
      if (!relays) throw new NoGroupRelaysError();
      response = await this.network.publish(relays, sendResult.envelope);
      if (!hasAck(response)) {
        const errors = Object.values(response)
          .filter((r) => !r.ok && r.message)
          .map((r) => r.message)
          .join("; ");
        throw new Error(
          `Failed to publish commit: ${errors || "no relay acknowledged"}`,
        );
      }
    } catch (err) {
      this.#engine.publishFailed(sendResult.pending);
      throw err;
    }

    this.#engine.confirmPublished(sendResult.pending);
    await this.save();

    const { welcome } = sendResult;
    if (
      welcome &&
      options?.welcomeRecipients &&
      options.welcomeRecipients.length > 0
    ) {
      this.log(
        "Sending Welcome messages to %d recipient(s)",
        options.welcomeRecipients.length,
      );

      const innerWelcome = welcome?.welcome;
      if (!innerWelcome) return response;

      const welcomeResults = await Promise.allSettled(
        options.welcomeRecipients.map(async (recipient) => {
          const welcomeRumor = createWelcomeRumor({
            welcome: innerWelcome,
            author: actorPubkey,
            groupRelays: groupData.relays,
            keyPackageEventId: recipient.keyPackageEventId,
          });

          const giftWrapEvent = await createGiftWrap({
            rumor: welcomeRumor,
            recipient: recipient.pubkey,
            signer: this.signer,
          });

          let inboxRelays: string[];
          try {
            inboxRelays = await this.network.getUserInboxRelays(
              recipient.pubkey,
            );
            this.log("Retrieved inbox relays for recipient: %O", inboxRelays);
          } catch (error) {
            this.log(
              "Failed to get inbox relays for recipient %s...: %O",
              recipient.pubkey.slice(0, 16),
              error,
            );
            inboxRelays = groupData.relays || [];
          }

          if (inboxRelays.length === 0) {
            throw new Error(
              `No relays available to send Welcome to recipient ${recipient.pubkey.slice(
                0,
                16,
              )}...`,
            );
          }

          const publishResult = await this.network.publish(
            inboxRelays,
            giftWrapEvent,
          );

          this.log("Gift wrap publish result: %O", publishResult);

          return publishResult;
        }),
      );

      const failureDetails = welcomeResults
        .map((r, i) => ({
          result: r,
          recipient: options.welcomeRecipients![i],
        }))
        .filter(
          (
            x,
          ): x is {
            result: PromiseRejectedResult;
            recipient: WelcomeRecipient;
          } => x.result.status === "rejected",
        )
        .map((x) => {
          const msg =
            x.result.reason instanceof Error
              ? x.result.reason.message
              : String(x.result.reason);
          return `${x.recipient.pubkey.slice(0, 16)}…: ${msg}`;
        });

      if (failureDetails.length > 0) {
        this.log(
          "%d/%d Welcome(s) failed to deliver: %O",
          failureDetails.length,
          options.welcomeRecipients.length,
          failureDetails,
        );
        throw new Error(
          `Failed to deliver ${failureDetails.length}/${options.welcomeRecipients.length} Welcome message(s): ${failureDetails.join(
            "; ",
          )}`,
        );
      }
    }

    return response;
  }

  /**
   * Invites a user to the group using their KeyPackage event (kind 30443).
   *
   * This method:
   * 1. Validates the KeyPackage event (kind 30443)
   * 2. Validates that the credential identity matches the event pubkey
   * 3. Builds an Add proposal using the KeyPackage
   * 4. Commits the proposal
   * 5. After commit ack, sends a Welcome message to the invitee via NIP-59 gift wrap
   *
   * @param keyPackageEvent - The KeyPackage event (kind 30443) for the user to invite
   * @returns Promise resolving to the publish response from the relays
   * @throws Error if the event is not a key package kind or if the credential identity doesn't match
   */
  async inviteByKeyPackageEvent(
    keyPackageEvent: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    if (keyPackageEvent.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
      throw new Error(
        `inviteByKeyPackageEvent: Expected KeyPackage event kind ${ADDRESSABLE_KEY_PACKAGE_KIND}, got ${keyPackageEvent.kind}`,
      );
    }

    const keyPackage = getKeyPackage(keyPackageEvent);
    const credentialIdentity = getCredentialPubkey(
      keyPackage.leafNode.credential,
    );
    if (credentialIdentity !== keyPackageEvent.pubkey) {
      throw new Error(
        `inviteByKeyPackageEvent: Credential identity ${credentialIdentity} does not match event pubkey ${keyPackageEvent.pubkey}`,
      );
    }

    const proposalAction = proposeInviteUser(keyPackageEvent);

    return await this.commit({
      extraProposals: [proposalAction],
      welcomeRecipients: [
        {
          pubkey: keyPackageEvent.pubkey,
          keyPackageEventId: keyPackageEvent.id,
          keyPackageEvent,
        },
      ],
    });
  }

  /**
   * ingests an array of group messages and applies commits to the group state.
   *
   * Processing happens in two stages:
   * 1. Process all non-commit messages (proposals, application messages)
   *    - If a message fails to process, it's added to unreadable for retry
   * 2. Process commits according to MIP-03 (sorted by epoch, timestamp, event id)
   *    - Commits advance the epoch and update the group state
   *
   * After both stages, recursively retry unreadable messages until no more can be read.
   * Events that can never be processed are yielded as {@link UnreadableIngestResult}.
   *
   * @param events - Array of Nostr events containing encrypted MLS messages
   * @yields DispositionedIngestResult - The processing result plus its
   *   inbound-processing {@link Disposition}.
   */
  async *ingest(
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    const selfEcho: NostrEvent[] = [];
    const rest: NostrEvent[] = [];

    for (const event of events) {
      if (this.#sentEventIds.delete(event.id)) {
        selfEcho.push(event);
      } else {
        rest.push(event);
      }
    }

    for (const event of selfEcho) {
      const peeled = await this.#peeler.peelGroupMessages([event], this.state);
      const message = peeled.read[0]?.message;
      if (message) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          message,
          reason: "self-echo",
        };
        yield { ...skipped, disposition: ingestResultDisposition(skipped) };
      }
    }

    for await (const result of this.#engine.ingest(rest, options)) {
      const mapped = mapEngineIngestResult(result);

      if (
        mapped.kind === "processed" &&
        mapped.result.kind === "applicationMessage"
      ) {
        if (this.history) {
          try {
            await this.history.saveMessage(mapped.result.message);
          } catch (err) {
            this.emit("historyError", err as Error);
          }
        }
        this.emit("applicationMessage", mapped.result.message);
      }

      yield mapped;
    }

    await this.save();
  }

  /**
   * Encrypts a media file for sharing in a group message (MIP-04 v2).
   *
   * Derives the per-file key from the current MLS epoch, encrypts with
   * ChaCha20-Poly1305, and returns the ciphertext alongside a fully
   * populated {@link MediaAttachment} ready to be serialised into an
   * `imeta` tag via `createImetaTagForAttachment` from applesauce.
   *
   * **Caller responsibilities:**
   * 1. Upload `encrypted` to Blossom (or any content-addressed store).
   * 2. Set `attachment.url` to the resulting upload URL.
   * 3. Pass `attachment` (with `url`) to `createImetaTagForAttachment` and
   *    include the resulting tag on the group message rumor.
   */
  async encryptMedia(
    blob: Blob,
    metadata: {
      filename: string;
      type?: string;
      dimensions?: string;
      blurhash?: string;
      alt?: string;
      size?: number;
    },
  ): Promise<{ encrypted: Uint8Array; attachment: MediaAttachment }> {
    const mimeType = metadata.type ?? blob.type;
    if (!mimeType) {
      throw new Error(
        "encryptMedia: MIME type is required — pass metadata.type or ensure blob.type is set",
      );
    }

    const plaintext = new Uint8Array(await blob.arrayBuffer());
    const plaintextHash = bytesToHex(sha256(plaintext));

    const skeleton: MediaAttachment = {
      sha256: plaintextHash,
      type: canonicalizeMimeType(mimeType),
      filename: metadata.filename,
      nonce: "",
      version: MIP04_VERSION,
      size: metadata.size ?? blob.size,
      ...(metadata.dimensions !== undefined
        ? { dimensions: metadata.dimensions }
        : {}),
      ...(metadata.blurhash !== undefined
        ? { blurhash: metadata.blurhash }
        : {}),
      ...(metadata.alt !== undefined ? { alt: metadata.alt } : {}),
    };

    const fileKey = await deriveMediaEncryptionKey(
      this.state,
      this.ciphersuite,
      skeleton,
    );

    return encryptMediaFile(plaintext, fileKey, skeleton);
  }

  /**
   * Decrypts a MIP-04 v2 media attachment downloaded from Blossom.
   *
   * On the first call for a given file the plaintext bytes are derived via
   * key-derivation + ChaCha20-Poly1305 decryption and stored in
   * {`@link` media}. Subsequent calls for the same `attachment.sha256`
   * are served directly from the cache, skipping key-derivation entirely.
   */
  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
  ): Promise<StoredMedia> {
    if (!attachment.sha256) {
      throw new Error("decryptMedia: attachment.sha256 is required");
    }

    const cached = await this.media?.getMedia(attachment.sha256);
    if (cached) return cached;

    const inFlight = this.#decryptingMedia.get(attachment.sha256);
    if (inFlight) return inFlight;

    const decryptPromise = (async () => {
      const fileKey = await deriveMediaEncryptionKey(
        this.state,
        this.ciphersuite,
        attachment,
      );
      const plaintext = decryptMediaFile(encrypted, fileKey, attachment);

      await this.media?.addMedia(attachment.sha256, {
        data: plaintext,
        attachment,
      });

      return { data: plaintext, attachment };
    })();

    this.#decryptingMedia.set(attachment.sha256, decryptPromise);

    try {
      return await decryptPromise;
    } finally {
      this.#decryptingMedia.delete(attachment.sha256);
    }
  }

  /** Destroys the group and purges the group history */
  async destroy() {
    this.log("destroying group");

    this.log("clearing group history");
    if (this.history) await this.history.purgeMessages();

    this.log("clearing group media");
    if (this.media) await this.media.clearMedia();

    this.log("removing group from store");
    await this.store.removeItem(bytesToHex(this.id));

    this.emit("destroyed", this);
  }
}
