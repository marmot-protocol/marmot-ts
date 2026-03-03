import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import { bytesToHex, type NostrEvent } from "applesauce-core/helpers/event";
import { Debugger } from "debug";
import { EventEmitter } from "eventemitter3";
import { getEventHash } from "nostr-tools";
import {
  CiphersuiteImpl,
  ClientState,
  contentTypes,
  createApplicationMessage,
  createCommit,
  CreateCommitOptions,
  createProposal,
  CryptoProvider,
  defaultProposalTypes,
  defaultCryptoProvider,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  Proposal,
  wireformats,
} from "ts-mls";
import {
  acceptAll,
  type IncomingMessageCallback,
} from "ts-mls/incomingMessageAction.js";
import { getCredentialFromLeafIndex } from "ts-mls/ratchetTree.js";
import { type LeafIndex, toLeafIndex } from "ts-mls/treemath.js";

import { marmotAuthService } from "../../core/auth-service.js";
import {
  getMarmotGroupData,
  serializeClientState,
} from "../../core/client-state.js";
import { getCredentialPubkey } from "../../core/credential.js";
import {
  createGroupEvent,
  GroupMessagePair,
  decryptGroupMessages,
  serializeApplicationRumor,
  sortGroupCommits,
} from "../../core/group-message.js";
import { getKeyPackage } from "../../core/key-package-event.js";
import { isPrivateMessage } from "../../core/message.js";
import { MarmotGroupData } from "../../core/protocol.js";
import { createWelcomeRumor } from "../../core/welcome.js";
import { GroupStateStore } from "../../store/group-state-store.js";
import { logger } from "../../utils/debug.js";
import { createGiftWrap, hasAck } from "../../utils/index.js";
import { unixNow } from "../../utils/nostr.js";
import { NoGroupRelaysError, NoMarmotGroupDataError } from "../errors.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { proposeInviteUser } from "./proposals/invite-user.js";

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
   */
  reason: "past-epoch" | "wrong-wireformat";
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
 * The minimum interface for a group to store them MLS messages
 * Implementations should extend this with methods for querying and loading stored messages
 */
export interface BaseGroupHistory {
  /** Saves a new application message to the group history */
  saveMessage(message: Uint8Array): Promise<void>;
  /** Purge the group history, called when group is destroyed */
  purgeMessages(): Promise<void>;
}

/** A factory function that creates a {@link BaseGroupHistory} instance for a group id */
export type GroupHistoryFactory<
  THistory extends BaseGroupHistory | undefined = undefined,
> = (groupId: Uint8Array) => THistory;

export type ProposalContext = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  groupData: MarmotGroupData;
};

/** A function that builds an MLS Proposal from group context */
export type ProposalAction<T extends Proposal | Proposal[]> = (
  context: ProposalContext,
) => Promise<T>;

/** A method that creates a {@link ProposalAction} from a set of arguments */
export type ProposalBuilder<
  Args extends unknown[],
  T extends Proposal | Proposal[],
> = (...args: Args) => ProposalAction<T>;

export type MarmotGroupOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
> = {
  /** The state store to store and load group state from */
  stateStore: GroupStateStore;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The ciphersuite implementation to use for the group */
  ciphersuite: CiphersuiteImpl;
  /** The nostr relay pool to use for the group. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
  /** The storage interface for the groups application message history (optional) */
  history?: THistory | GroupHistoryFactory<THistory>;
};

/** Information about a welcome recipient */
export type WelcomeRecipient = {
  /** The recipient's Nostr public key */
  pubkey: string;
  /** The ID of KeyPackage event (kind 443) used for add operation */
  keyPackageEventId: string;
  /** The KeyPackage event (kind 443) used for add operation */
  keyPackageEvent: NostrEvent;
};

/**
 * Build an incoming-message callback that enforces MIP-03 "admin-only commits".
 *
 * Kept as a pure helper for test ergonomics and clearer policy control.
 */
export function createAdminCommitPolicyCallback(args: {
  ratchetTree: ClientState["ratchetTree"];
  adminPubkeys: string[];
  onUnverifiableCommit?: "reject" | "retry";
}): IncomingMessageCallback {
  const { ratchetTree, adminPubkeys, onUnverifiableCommit = "retry" } = args;

  return (incoming) => {
    if (incoming.kind === "proposal") return "accept";

    // Commit must be attributable to a concrete member leaf.
    const senderLeafIndexUnknown = incoming.senderLeafIndex;
    if (senderLeafIndexUnknown === undefined) return "reject";

    const senderLeafIndex: LeafIndex =
      typeof senderLeafIndexUnknown === "number"
        ? toLeafIndex(senderLeafIndexUnknown)
        : senderLeafIndexUnknown;

    try {
      const senderCredential = getCredentialFromLeafIndex(
        ratchetTree,
        senderLeafIndex,
      );
      const senderPubkey = getCredentialPubkey(senderCredential);

      // Admins may commit any proposal set.
      if (adminPubkeys.includes(senderPubkey)) return "accept";

      // Non-admin compatibility path:
      // - accept no-proposal commits (current ts-mls self-update shape), OR
      // - accept commits whose proposals are ONLY update proposals authored by sender.
      if (incoming.proposals.length === 0) return "accept";

      const isSelfUpdateOnly = incoming.proposals.every(
        (p) =>
          p.proposal.proposalType === defaultProposalTypes.update &&
          p.senderLeafIndex !== undefined &&
          Number(p.senderLeafIndex) === Number(senderLeafIndex),
      );

      return isSelfUpdateOnly ? "accept" : "reject";
    } catch {
      // "retry" here means we don't want to permanently reject the commit;
      // MarmotGroup.ingest() will treat processing errors as unreadable/retryable.
      if (onUnverifiableCommit === "retry") {
        throw new Error("unverifiable commit sender");
      }
      return "reject";
    }
  };
}

/** Map of events that can be emitted by a MarmotGroup */
type MarmotGroupEvents<THistory extends BaseGroupHistory | undefined = any> = {
  /** Emitted when the group state is updated */
  stateChanged: (state: ClientState) => void;
  /** Emitted when a new application message is received */
  applicationMessage: (message: Uint8Array) => void;
  /** Emitted when the group state is saved */
  stateSaved: (group: MarmotGroup<THistory>) => void;
  /** Emitted when the group is destroyed */
  destroyed: (group: MarmotGroup<THistory>) => void;
  /** Emitted when history persistence fails (best-effort, non-blocking) */
  historyError: (error: Error) => void;
};

/**
 * The main class for interacting with a MLS group
 * @template THistory - The type of the history store to use for the group, must implement the {@link BaseGroupHistory} interface. (Default is no history store)
 */
export class MarmotGroup<
  THistory extends BaseGroupHistory | undefined = undefined,
> extends EventEmitter<MarmotGroupEvents<THistory>> {
  /** The state store to store and load group state from */
  readonly stateStore: GroupStateStore;

  /** The signer used for the clients identity */
  readonly signer: EventSigner;

  /** The ciphersuite implementation to use for the group */
  readonly ciphersuite: CiphersuiteImpl;

  /** The nostr relay pool to use for the group */
  readonly network: NostrNetworkInterface;

  /** The storage interface for the groups application message history */
  readonly history: THistory;

  /** Whether group state has been modified */
  dirty = false;

  /** Internal ClientState */
  #state: ClientState;
  #groupData: MarmotGroupData | null = null;

  get id() {
    return this.state.groupContext.groupId;
  }

  /** The group id as a hex string */
  idStr: string;

  /** Read the current group state */
  get state() {
    return this.#state;
  }
  get groupData() {
    // If not cached, extract the group data from the state
    if (!this.#groupData) this.#groupData = getMarmotGroupData(this.state);
    return this.#groupData;
  }
  get unappliedProposals() {
    return this.state.unappliedProposals;
  }

  /**
   * Overrides the current group state
   * @warning It is not recommended to use this
   */
  set state(newState: ClientState) {
    // Read new group data from the state
    this.#groupData = getMarmotGroupData(newState);

    // Set new state and mark as dirty
    this.#state = newState;
    this.dirty = true;
    this.emit("stateChanged", newState);
  }

  // Common accessors for marmot group data
  get relays() {
    return this.groupData?.relays;
  }

  private log: Debugger;

  constructor(state: ClientState, options: MarmotGroupOptions<THistory>) {
    super();
    this.#state = state;
    this.stateStore = options.stateStore;
    this.signer = options.signer;
    this.ciphersuite = options.ciphersuite;
    this.network = options.network;

    // Create the history store (optional)
    if (options.history) {
      if (typeof options.history === "function") {
        this.history = options.history(this.id);
      } else {
        this.history = options.history;
      }
    } else {
      this.history = undefined as THistory;
    }

    // Set useful fields
    this.idStr = bytesToHex(this.id);

    this.log = logger.extend(`group:${this.idStr.slice(0, 8)}`);
  }

  /** Creates a new {@link MarmotGroup} instance from a {@link ClientState} object */
  static async fromClientState<
    THistory extends BaseGroupHistory | undefined = undefined,
  >(
    state: ClientState,
    options: Omit<MarmotGroupOptions<THistory>, "ciphersuite"> & {
      cryptoProvider?: CryptoProvider;
    },
  ): Promise<MarmotGroup<THistory>> {
    // Get the group's ciphersuite implementation
    // In v2, getCiphersuiteImpl is available on the cryptoProvider and takes a CiphersuiteName directly
    const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const cipherSuite = await cryptoProvider.getCiphersuiteImpl(
      state.groupContext.cipherSuite,
    );

    return new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
  }

  /** Persists any pending changes to the group state in the store */
  async save() {
    if (!this.dirty) return;

    // Import serializeClientState dynamically to avoid circular dependencies
    const stateBytes = serializeClientState(this.state);
    await this.stateStore.set(this.id, stateBytes);
    this.dirty = false;
    this.emit("stateSaved", this);
  }

  /** Publish an event to the group relays */
  async publish(event: NostrEvent): Promise<Record<string, PublishResponse>> {
    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();
    return await this.network.publish(relays, event);
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

    // Create a commit with explicitly empty proposals. In ts-mls, this results in
    // a self-update commit that includes an UpdatePath (rotating leaf secrets).
    const { commit, newState } = await createCommit({
      context: {
        cipherSuite: this.ciphersuite,
        authService: marmotAuthService,
      },
      state: this.state,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const commitEvent = await createGroupEvent({
      message: commit,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    const response = await this.network.publish(relays, commitEvent);
    if (!hasAck(response)) {
      throw new Error("Failed to publish commit event: no relay acknowledged");
    }

    // Advance local state after publish.
    this.state = newState;
    await this.save();

    return response;
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

    // Handle both single proposals and arrays of proposals
    const proposalArray = Array.isArray(proposals) ? proposals : [proposals];

    // Send all proposals and collect responses
    const responses: Record<string, PublishResponse> = {};
    for (const proposal of proposalArray) {
      const response = await this.sendProposal(proposal as Proposal);
      // Merge responses (later responses override earlier ones for the same relay)
      Object.assign(responses, response);
    }

    return responses;
  }

  /** Sends a proposal to the group relays */
  async sendProposal(
    proposal: Proposal,
  ): Promise<Record<string, PublishResponse>> {
    // NOTE: We don't update state here because:
    // 1. The proposal will be received back from relays and processed via ingest()
    // 2. When processed via ingest(), it will be added to state.unappliedProposals
    // 3. If you need to commit immediately with this proposal, pass it explicitly to commit()
    // In v2, createProposal takes a single params object with context
    const { message } = await createProposal({
      context: {
        cipherSuite: this.ciphersuite,
        authService: marmotAuthService,
        externalPsks: {},
      },
      state: this.state,
      proposal,
      wireAsPublicMessage: false,
    });

    // Wrap the message in a group event
    const proposalEvent = await createGroupEvent({
      message,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    // Publish to the group's relays
    return await this.publish(proposalEvent);
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
    // Serialize the Nostr event (rumor) to application data according to the Marmot spec
    const applicationData = serializeApplicationRumor(rumor);

    // Create the application message using ts-mls
    // In v2, createApplicationMessage takes a single params object with context
    const { newState, message } = await createApplicationMessage({
      context: {
        cipherSuite: this.ciphersuite,
        authService: marmotAuthService,
        externalPsks: {},
      },
      state: this.state,
      message: applicationData,
    });

    // The message returned is the MLS message (not privateMessage directly)
    const mlsMessage = message;

    // Wrap the message in a group event
    // Use this.state (not newState) to get the exporter_secret for the current epoch
    const applicationEvent = await createGroupEvent({
      message: mlsMessage,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    // Publish to the group's relays
    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();
    const response = await this.network.publish(relays, applicationEvent);
    if (!hasAck(response)) {
      const errors = Object.values(response)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(
        `Failed to publish application message: ${errors || "no relay acknowledged"}`,
      );
    }

    // Update the group state after successful publish
    // Application messages update state for forward secrecy (key schedule rotation)
    this.state = newState;

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
   *
   * @example
   * ```ts
   * await group.sendChatMessage("Hello, group!");
   * await group.sendChatMessage("Reply", [["e", replyToId]]);
   * ```
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
   * You can provide proposals in two ways:
   * 1. Pass extraProposals to include new proposals inline
   * 2. Pass proposalRefs to select specific proposals from unappliedProposals
   * 3. Pass both to combine new proposals with selected ones
   *
   * If no extraProposals or proposalRefs are provided, createCommit will use ALL proposals
   * from state.unappliedProposals automatically.
   *
   * @param options - Options for creating the commit
   * @param options.extraProposals - New proposals to include in the commit (inline)
   * @param options.proposalRefs - Proposal references (hex strings) to select from unappliedProposals
   * @param options.welcomeRecipients - Explicit list of users to send Welcome messages to (for Add operations)
   */
  async commit(options?: {
    extraProposals?: (
      | Proposal
      | ProposalAction<Proposal>
      | (Proposal | ProposalAction<Proposal>)[]
    )[];
    proposalRefs?: string[];
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
    if (!groupData.adminPubkeys.includes(actorPubkey)) {
      throw new Error("Not a group admin. Cannot commit proposals.");
    }

    const context: ProposalContext = {
      state: this.state,
      ciphersuite: this.ciphersuite,
      groupData: this.groupData,
    };

    // Build new proposals from extraProposals
    const newProposals: Proposal[] = [];
    if (options?.extraProposals && options.extraProposals.length > 0) {
      for (const item of options.extraProposals.flat()) {
        if (typeof item === "function") {
          newProposals.push(await item(context));
        } else {
          newProposals.push(item);
        }
      }
    }

    // Extract proposals from unappliedProposals using the provided references
    const selectedProposals: Proposal[] = [];
    if (options?.proposalRefs) {
      for (const ref of options.proposalRefs) {
        const proposalWithSender = this.state.unappliedProposals[ref];
        if (!proposalWithSender) {
          throw new Error(
            `Proposal reference not found in unappliedProposals: ${ref}`,
          );
        }
        selectedProposals.push(proposalWithSender.proposal);
      }
    }

    // Combine new proposals with selected proposals from unappliedProposals
    const allProposals = [...newProposals, ...selectedProposals];

    // Build options for createCommit
    const commitOptions: CreateCommitOptions = {
      // All messages should be private
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
    };

    // If the caller explicitly provided extraProposals or proposalRefs, use
    // exactly those (even if empty — that means "self-update, no proposals").
    // Only fall through to the "commit all unapplied" default when neither is set.
    if (options?.extraProposals || options?.proposalRefs) {
      commitOptions.extraProposals = allProposals;
    }

    // Create the commit
    // In v2, createCommit takes a single params object with context
    const { commit, newState, welcome } = await createCommit({
      context: {
        cipherSuite: this.ciphersuite,
        authService: marmotAuthService,
      },
      state: this.state,
      ...commitOptions,
    });

    // Wrap the commit in a group event
    // Use this.state (not newState) to get the exporter_secret for the current epoch
    // This ensures all members at the current epoch can decrypt the commit
    const commitEvent = await createGroupEvent({
      message: commit,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    // Publish to the group's relays.
    // MIP-02 REQUIRES: Commit MUST be published and acknowledged by relays BEFORE sending Welcome messages.
    // This ordering is critical for protocol correctness - new members must be able to fetch the commit
    // that added them before processing their Welcome.
    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();
    const response = await this.network.publish(relays, commitEvent);
    if (!hasAck(response)) {
      const errors = Object.values(response)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(
        `Failed to publish commit: ${errors || "no relay acknowledged"}`,
      );
    }

    // Update the group state after successful publish
    this.state = newState;

    // Persist local-authoritative epoch transition immediately.
    await this.save();

    // If new users were added, send welcome events
    // The commit has been published and acked, so it's safe to send Welcomes now (MIP-02 compliance)
    if (
      welcome &&
      options?.welcomeRecipients &&
      options.welcomeRecipients.length > 0
    ) {
      this.log(
        "Sending Welcome messages to %d recipient(s)",
        options.welcomeRecipients.length,
      );

      // Send all welcome events in parallel
      // In v2, welcome is wrapped in MlsWelcomeMessage, need to access welcome.welcome
      const innerWelcome = welcome?.welcome;
      if (!innerWelcome) return response;

      const welcomeResults = await Promise.allSettled(
        options.welcomeRecipients.map(async (recipient) => {
          const welcomeRumor = createWelcomeRumor({
            welcome: innerWelcome,
            author: actorPubkey,
            groupRelays: groupData.relays,
            keyPackageEventId: recipient.keyPackageEventId,
            keyPackageEvent: recipient.keyPackageEvent,
          });

          // Gift wrap the welcome event to the newly added user
          const giftWrapEvent = await createGiftWrap({
            rumor: welcomeRumor,
            recipient: recipient.pubkey,
            signer: this.signer,
          });

          // Get the newly added user's inbox relays using the GroupNostrInterface
          // Fallback to group relays if inbox relays are not available
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
            // Fallback to group relays
            inboxRelays = groupData.relays || [];
          }

          if (inboxRelays.length === 0) {
            throw new Error(
              `No relays available to send Welcome to recipient ${recipient.pubkey.slice(0, 16)}...`,
            );
          }

          // Welcome is the most critical delivery — new members can't join without it.
          const publishResult = await this.network.publish(
            inboxRelays,
            giftWrapEvent,
          );

          this.log("Gift wrap publish result: %O", publishResult);

          return publishResult;
        }),
      );

      // Surface welcome delivery failures so callers can detect and retry
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
          `Failed to deliver ${failureDetails.length}/${options.welcomeRecipients.length} Welcome message(s): ${failureDetails.join("; ")}`,
        );
      }
    }

    return response;
  }

  /**
   * Invites a user to the group using their KeyPackage event (kind 443).
   *
   * This method:
   * 1. Validates the KeyPackage event (kind 443)
   * 2. Validates that the credential identity matches the event pubkey
   * 3. Builds an Add proposal using the KeyPackage
   * 4. Commits the proposal
   * 5. After commit ack, sends a Welcome message to the invitee via NIP-59 gift wrap
   *
   * @param keyPackageEvent - The KeyPackage event (kind 443) for the user to invite
   * @returns Promise resolving to the publish response from the relays
   * @throws Error if the event is not kind 443 or if the credential identity doesn't match
   */
  async inviteByKeyPackageEvent(
    keyPackageEvent: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    // Validate the event is a KeyPackage event (kind 443)
    if (keyPackageEvent.kind !== 443) {
      throw new Error(
        `inviteByKeyPackageEvent: Expected KeyPackage event kind 443, got ${keyPackageEvent.kind}`,
      );
    }

    // Validate that the credential identity matches the event pubkey
    const keyPackage = getKeyPackage(keyPackageEvent);
    const credentialIdentity = getCredentialPubkey(
      keyPackage.leafNode.credential,
    );
    if (credentialIdentity !== keyPackageEvent.pubkey) {
      throw new Error(
        `inviteByKeyPackageEvent: Credential identity ${credentialIdentity} does not match event pubkey ${keyPackageEvent.pubkey}`,
      );
    }

    // Build the Add proposal using the existing proposeInviteUser function
    const proposalAction = proposeInviteUser(keyPackageEvent);

    // Commit with the proposal and explicit welcome recipient
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
   * Creates an incoming message callback that enforces admin-only commits.
   *
   * Per MIP-03, only admins can send commits. This callback:
   * - Accepts all proposals (they don't require admin privileges)
   * - For commits, verifies that the sender is in the group's admin list
   * - Rejects commits from non-admin senders
   *
   * @returns An IncomingMessageCallback that enforces admin verification
   */
  private createAdminVerificationCallback(): IncomingMessageCallback {
    const groupData = this.groupData;
    if (!groupData) {
      // If no group data, we can't verify - accept all (shouldn't happen in normal flow)
      return acceptAll;
    }

    return createAdminCommitPolicyCallback({
      ratchetTree: this.state.ratchetTree,
      adminPubkeys: groupData.adminPubkeys,
      onUnverifiableCommit: "retry",
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
   * @param options - Options for controlling retry behavior
   * @param options.retryCount - Current retry attempt count (internal use)
   * @param options.maxRetries - Maximum number of retry attempts (default: 5)
   * @yields IngestResult - The result of processing the event
   */
  async *ingest(
    events: NostrEvent[],
    options?: {
      retryCount?: number;
      maxRetries?: number;
      /**
       * @internal Flat list of `{ eventId, error }` entries accumulated across
       * all retry rounds.  Passed by reference so every recursive call appends
       * to the same array, giving the final unreadable yield the full history.
       */
      _errors?: Array<{ eventId: string; error: unknown }>;
    },
  ): AsyncGenerator<IngestResult> {
    // Each ingest call gets its own sub-namespace so concurrent or sequential
    // batches can be distinguished at a glance in debug output.
    const log = this.log.extend(`ingest:${Date.now().toString(36).slice(-5)}`);

    // Set default retry options
    const retryCount = options?.retryCount ?? 0;
    const maxRetries = options?.maxRetries ?? 5;
    const errorList: Array<{ eventId: string; error: unknown }> =
      options?._errors ?? [];

    if (retryCount === 0) {
      log("start – %d event(s), maxRetries=%d", events.length, maxRetries);
    } else {
      log(
        "retry %d/%d – %d event(s) remaining",
        retryCount,
        maxRetries,
        events.length,
      );
    }

    // Check if we've exceeded the maximum retry attempts.
    //
    // IMPORTANT: ingest() processes untrusted network input. If we throw here,
    // a single permanently-unreadable message (e.g. encrypted under an epoch we
    // can never decrypt, malformed ciphertext, spam) can DoS consumers.
    // Instead, stop retrying and yield the remaining events as unreadable.
    if (retryCount > maxRetries) {
      log(
        "max retries exceeded – yielding %d event(s) as unreadable",
        events.length,
      );
      for (const event of events) {
        yield {
          kind: "unreadable",
          event,
          errors: errorList
            .filter((e) => e.eventId === event.id)
            .map((e) => e.error),
        };
      }
      return;
    }
    // Early return if no events to process
    if (events.length === 0) return;

    // ============================================================================
    // STEP 1: Decrypt NIP-44 layer to get MLSMessages
    // ============================================================================
    // Each Nostr event contains an MLSMessage encrypted with NIP-44 using the
    // group's exporter_secret. We decrypt this first layer to get the actual
    // MLS message structure.

    const { read, unreadable: decryptFailed } = await decryptGroupMessages(
      events,
      this.state,
      this.ciphersuite,
    );

    log(
      "decryption: %d/%d readable, %d failed",
      read.length,
      events.length,
      decryptFailed.length,
    );

    // Record a decryption error for each event that failed the NIP-44 layer.
    for (const event of decryptFailed) {
      log("decrypt failed event:%s", event.id.slice(0, 8));
      errorList.push({
        eventId: event.id,
        error: new Error("Failed to decrypt group message"),
      });
    }

    // If nothing was readable the exporter_secret cannot change this round, so
    // retrying would always fail the same way.  Yield decrypt failures now.
    if (read.length === 0) {
      log(
        "nothing readable – yielding %d decrypt failure(s) as unreadable",
        decryptFailed.length,
      );
      for (const event of decryptFailed) {
        yield {
          kind: "unreadable",
          event,
          errors: errorList
            .filter((e) => e.eventId === event.id)
            .map((e) => e.error),
        };
      }
      return;
    }

    // Collect events that need a retry after state advances (e.g. after a commit
    // rotates the exporter_secret so we can decrypt previously opaque events).
    const unreadable: NostrEvent[] = [...decryptFailed];

    // ============================================================================
    // STEP 2: Separate commits from non-commit messages
    // ============================================================================
    // We process non-commit messages first (proposals, application messages),
    // then process commits. This ensures proposals are in unappliedProposals
    // before commits try to reference them.

    let commits: Array<GroupMessagePair> = [];
    const nonCommits: Array<GroupMessagePair> = [];

    for (const pair of read) {
      if (
        isPrivateMessage(pair.message) &&
        pair.message.privateMessage.contentType === contentTypes.commit
      ) {
        commits.push(pair);
      } else {
        nonCommits.push(pair);
      }
    }

    log(
      "split: %d commit(s), %d non-commit(s)",
      commits.length,
      nonCommits.length,
    );

    // ============================================================================
    // STEP 3: Process all non-commit messages
    // ============================================================================
    // Process all proposals and application messages. If a message fails to process
    // (wrong epoch, invalid, etc.), add it to unreadable for retry later.
    //
    // Proposals are added to state.unappliedProposals when processed, making them
    // available for commits to reference via ProposalRef.

    for (const { event, message } of nonCommits) {
      try {
        // Yield unexpected wireformats as skipped rather than silently ignoring them.
        if (
          message.wireformat !== wireformats.mls_private_message &&
          message.wireformat !== wireformats.mls_public_message
        ) {
          log("skip event:%s reason:wrong-wireformat", event.id.slice(0, 8));
          yield { kind: "skipped", event, message, reason: "wrong-wireformat" };
          continue;
        }

        // processMessage handles:
        // - Proposals: Adds them to state.unappliedProposals (keyed by proposal reference)
        // - Application messages: Decrypts content and returns it
        // - Both update state as needed (for forward secrecy)
        // In v2, processMessage takes a single params object with context
        const result = await processMessage({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          message,
          callback: acceptAll, // Accept all proposals (adds them to unappliedProposals)
        });

        // Update state if message changed it
        if (result.kind === "newState") {
          log(
            "proposal accepted event:%s epoch:%d",
            event.id.slice(0, 8),
            this.state.groupContext.epoch,
          );
          this.state = result.newState;
          yield { kind: "processed", result, event, message };
        } else if (result.kind === "applicationMessage") {
          log("application message event:%s", event.id.slice(0, 8));
          // Application messages also update state (for forward secrecy)
          this.state = result.newState;

          // Save application message to history (best-effort)
          if (this.history) {
            try {
              await this.history.saveMessage(result.message);
            } catch (err) {
              this.emit("historyError", err as Error);
            }
          }

          yield { kind: "processed", result, event, message };
          this.emit("applicationMessage", result.message);
        }
      } catch (error) {
        // Message processing failed - might be invalid or from wrong epoch
        // Add to unreadable for retry later (might become readable after state updates)
        log(
          "non-commit failed event:%s – queued for retry: %O",
          event.id.slice(0, 8),
          error,
        );
        errorList.push({ eventId: event.id, error });
        unreadable.push(event);
      }
    }

    // ============================================================================
    // STEP 4: Sort commits to handle race conditions (MIP-03)
    // ============================================================================
    commits = sortGroupCommits(commits);

    // ============================================================================
    // STEP 5: Process commits sequentially
    // ============================================================================
    // Commits advance the epoch and update the group state. We process them in
    // sorted order. Each commit changes the epoch and rotates keys, so later
    // commits depend on earlier ones.

    // Create admin verification callback for commit processing
    const adminCallback = this.createAdminVerificationCallback();

    for (const { event, message } of commits) {
      if (!isPrivateMessage(message)) {
        log(
          "skip commit event:%s reason:wrong-wireformat",
          event.id.slice(0, 8),
        );
        yield { kind: "skipped", event, message, reason: "wrong-wireformat" };
        continue;
      }

      const commitEpoch =
        typeof message.privateMessage.epoch === "bigint"
          ? message.privateMessage.epoch
          : BigInt(message.privateMessage.epoch);
      const currentEpoch = this.state.groupContext.epoch;

      // Commits from past epochs were already applied — skip and report them.
      if (commitEpoch < currentEpoch) {
        log(
          "skip commit event:%s reason:past-epoch (commit=%d current=%d)",
          event.id.slice(0, 8),
          commitEpoch,
          currentEpoch,
        );
        yield { kind: "skipped", event, message, reason: "past-epoch" };
        continue;
      }

      // Commits too far in the future can't be applied yet.
      // Add to unreadable so they are retried after state advances.
      if (commitEpoch > currentEpoch + 1n) {
        log(
          "defer commit event:%s epoch:%d too far ahead (current=%d)",
          event.id.slice(0, 8),
          commitEpoch,
          currentEpoch,
        );
        errorList.push({
          eventId: event.id,
          error: new Error(
            `Commit epoch ${commitEpoch} is too far ahead of current epoch ${currentEpoch}`,
          ),
        });
        unreadable.push(event);
        continue;
      }

      log(
        "processing commit event:%s epoch:%d->%d",
        event.id.slice(0, 8),
        currentEpoch,
        commitEpoch,
      );

      try {
        // processMessage handles:
        // - Decrypts the private message using group secrets from the current state
        // - Verifies message authenticity and sender
        // - Resolves proposal references from state.unappliedProposals (if needed)
        // - Applies the commit (updates ratchet tree, advances epoch, rotates keys)
        // In v2, processMessage takes a single params object with context
        const result = await processMessage({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          message,
          callback: adminCallback, // Use admin verification callback for commits
        });

        if (result.kind === "newState") {
          // If the commit was rejected by the callback (admin verification),
          // do not advance state and do not retry — yield it so callers can observe it.
          if (result.actionTaken === "reject") {
            log(
              "commit event:%s rejected by admin policy",
              event.id.slice(0, 8),
            );
            yield { kind: "rejected", result, event, message };
            continue;
          }

          // Successfully processed the commit - update our state
          // After each commit, the epoch advances and keys rotate
          this.state = result.newState;
          log(
            "commit event:%s applied – new epoch:%d",
            event.id.slice(0, 8),
            this.state.groupContext.epoch,
          );
          yield { kind: "processed", result, event, message };
        }
      } catch (error) {
        // Commit processing failed - add to unreadable for retry
        // It might become valid after processing more proposals or state updates
        log(
          "commit failed event:%s – queued for retry: %O",
          event.id.slice(0, 8),
          error,
        );
        errorList.push({ eventId: event.id, error });
        unreadable.push(event);
      }
    }

    // Save the group state after processing all messages
    await this.save();
    log("state saved – epoch:%d", this.state.groupContext.epoch);

    // ============================================================================
    // STEP 6: Recursively retry unreadable events
    // ============================================================================
    // After processing commits and updating the state, some events that were
    // unreadable might now be readable. For example:
    // - An event from epoch N+1 might have been unreadable when we were at epoch N
    // - After processing a commit that advances us to epoch N+1, we can now read it
    //
    // We recursively call ingest on unreadable events to retry them.
    // This continues until no more events can be read.

    if (unreadable.length > 0) {
      log("scheduling retry for %d unreadable event(s)", unreadable.length);
      yield* this.ingest(unreadable, {
        retryCount: retryCount + 1,
        maxRetries: maxRetries,
        _errors: errorList,
      });
    } else {
      log("done – no unreadable events remain");
    }
  }

  /** Destroys the group and purges the group history */
  async destroy() {
    this.log("destroying group");
    if (this.history) await this.history.purgeMessages();

    // Remove the group from the store
    await this.stateStore.remove(this.id);

    // Emit the destroyed event
    this.emit("destroyed", this);
  }
}
