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
  Proposal,
} from "ts-mls";
import { sha256 } from "@noble/hashes/sha2.js";

import type { ProposalAction, ProposalContext } from "../../engine/types.js";
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
import { logger } from "../../utils/debug.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { hasAck } from "../../utils/index.js";
import { unixNow } from "../../utils/nostr.js";
import { GroupRuntime } from "../runtime/group-runtime.js";
import {
  GroupSession,
  type DispositionedIngestResult,
  type GroupSessionHistory,
  type ProposalBuilder,
} from "../session/group-session.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import {
  NostrWelcomeDelivery,
  type WelcomeRecipient,
} from "../transport/nostr/welcome-delivery.js";
import { proposeInviteUser } from "./proposals/invite-user.js";
import { proposeLeaveGroup } from "./proposals/leave-group.js";

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

export type {
  DispositionedIngestResult,
  IngestResult,
  ProcessedIngestResult,
  RejectedIngestResult,
  SkippedIngestResult,
  UnreadableIngestResult,
} from "../session/group-session.js";
export { ingestResultDisposition } from "../session/group-session.js";

/**
 * The minimum interface for a group to store them MLS messages
 * Implementations should extend this with methods for querying and loading stored messages
 */
export interface BaseGroupHistory extends GroupSessionHistory {
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

  /** Protocol state owner for this group. Prefer this over convenience methods. */
  readonly session: GroupSession<THistory>;
  /** Runtime publisher for driving session effects through transport. */
  readonly runtime: GroupRuntime;

  /** In-flight media decrypts keyed by plaintext SHA-256 hex. */
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  private log: Debugger;

  get id() {
    return this.session.id;
  }

  /** The group id as a hex string */
  idStr: string;

  /** Read the current group state */
  get state() {
    return this.session.state;
  }

  /**
   * The group's lifecycle state (`group-state.md`). A new local commit may only
   * be prepared while `Stable`; the commit flow moves through `PendingPublish`
   * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
   * commit applying) and back to `Stable`.
   */
  get lifecycle() {
    return this.session.lifecycle;
  }

  get groupData() {
    return this.session.groupData;
  }

  get unappliedProposals() {
    return this.session.unappliedProposals;
  }

  get dirty() {
    return this.session.dirty;
  }

  /**
   * Overrides the current group state
   * @warning It is not recommended to use this
   */
  set state(newState: ClientState) {
    this.session.state = newState;
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

    if (options.history) {
      if (typeof options.history === "function") {
        this.history = options.history(state.groupContext.groupId);
      } else {
        this.history = options.history;
      }
    } else {
      this.history = undefined as THistory;
    }

    this.session = new GroupSession({
      state,
      ciphersuite: this.ciphersuite,
      store: this.store,
      history: this.history,
      onStateChanged: (newState) => this.emit("stateChanged", newState),
      onStateSaved: () => this.emit("stateSaved", this),
      onApplicationMessage: (message) =>
        this.emit("applicationMessage", message),
      onHistoryError: (error) => this.emit("historyError", error),
    });

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
    this.runtime = new GroupRuntime({
      welcomeDelivery: new NostrWelcomeDelivery({
        signer: this.signer,
        network: this.network,
      }),
      getNetwork: () => this.network,
      getRelays: () => this.relays,
      getGroupData: () => this.groupData,
      confirmPublished: (pending) => this.session.confirmPublished(pending),
      publishFailed: (pending) => this.session.publishFailed(pending),
      save: () => this.save(),
      log: this.log,
    });
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
    await this.session.save(force);
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

    const effects = await this.session.send({ kind: "selfUpdate" });
    const [result] = await this.runtime.publishEffects(effects);
    return result.response;
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

    const context: ProposalContext = this.session.proposalContext();

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
    const effects = await this.session.send({ kind: "proposal", proposal });
    const [result] = await this.runtime.publishEffects(effects);
    return result.response;
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

    const effects = await this.session.send({
      kind: "applicationMessage",
      payload: applicationData,
    });

    const [result] = await this.runtime.publishEffects(effects);
    return result.response;
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
    const effects = await this.session.send({
      kind: "commit",
      actorPubkey,
      extraProposals: options?.extraProposals,
      proposalRefs: options?.proposalRefs,
      welcomeRecipients: options?.welcomeRecipients,
    });

    const [result] = await this.runtime.publishEffects(effects);
    return result.response;
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
    yield* this.session.ingest(events, options);
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

    this.log("clearing group media");
    if (this.media) await this.media.clearMedia();

    this.log("removing group from store");
    await this.session.destroyLocalState();

    this.emit("destroyed", this);
  }
}
