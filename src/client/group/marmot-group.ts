import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core/event-factory";
import { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  ClientState,
  createApplicationMessage,
  createCommit,
  CreateCommitOptions,
  createProposal,
  CryptoProvider,
  emptyPskIndex,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  processMessage,
  Proposal,
  type ProcessMessageResult,
} from "ts-mls";
import {
  acceptAll,
  type IncomingMessageCallback,
} from "ts-mls/incomingMessageAction.js";
import {
  MLSMessage,
  type MlsPrivateMessage,
  type MlsPublicMessage,
} from "ts-mls/message.js";
import { getCredentialFromLeafIndex } from "ts-mls/ratchetTree.js";
import { toLeafIndex, type LeafIndex } from "ts-mls/treemath.js";
import { extractMarmotGroupData } from "../../core/client-state.js";
import { getCredentialPubkey } from "../../core/credential.js";
import {
  createGroupEvent,
  GroupMessagePair,
  readGroupMessages,
  serializeApplicationRumor,
  sortGroupCommits,
} from "../../core/group-message.js";
import { getKeyPackage } from "../../core/key-package-event.js";
import { isPrivateMessage } from "../../core/message.js";
import { MarmotGroupData } from "../../core/protocol.js";
import { createWelcomeRumor } from "../../core/welcome.js";
import { GroupStore } from "../../store/group-store.js";
import { createGiftWrap, hasAck } from "../../utils/index.js";
import {
  NoGroupRelaysError,
  NoMarmotGroupDataError,
  NoRelayReceivedEventError,
} from "../errors.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { proposeInviteUser } from "./proposals/invite-user.js";

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

export type MarmotGroupOptions = {
  /** The backend to store and load of group from */
  store: GroupStore;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The ciphersuite implementation to use for the group */
  ciphersuite: CiphersuiteImpl;
  /** The nostr relay pool to use for the group. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
};

/** Information about a welcome recipient */
export type WelcomeRecipient = {
  /** The recipient's Nostr public key */
  pubkey: string;
  /** The ID of KeyPackage event (kind 443) used for add operation */
  keyPackageEventId: string;
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

    // Commit must be attributable to an admin.
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
      return adminPubkeys.includes(senderPubkey) ? "accept" : "reject";
    } catch {
      // "retry" here means we don't want to permanently reject the commit;
      // MarmotGroup.ingest() will treat processing errors as unreadable/retryable.
      if (onUnverifiableCommit === "retry")
        throw new Error("unverifiable commit sender");
      return "reject";
    }
  };
}

export class MarmotGroup {
  /** The backend to store and load of group from */
  readonly store: GroupStore;

  /** The signer used for the clients identity */
  readonly signer: EventSigner;

  /** The ciphersuite implementation to use for the group */
  readonly ciphersuite: CiphersuiteImpl;

  /** The nostr relay pool to use for the group */
  readonly network: NostrNetworkInterface;

  /** Whether group state has been modified */
  dirty = false;

  /** Internal state */
  private _state: ClientState;
  private _groupData: MarmotGroupData | null = null;

  /** Read the current group state */
  get state() {
    return this._state;
  }
  get groupData() {
    // If not cached, extract the group data from the state
    if (!this._groupData) this._groupData = extractMarmotGroupData(this.state);
    return this._groupData;
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
    this._groupData = extractMarmotGroupData(newState);

    // Set new state and mark as dirty
    this._state = newState;
    this.dirty = true;
  }

  // Common accessors for marmot group data
  get relays() {
    return this.groupData?.relays;
  }

  constructor(state: ClientState, options: MarmotGroupOptions) {
    this._state = state;
    this.store = options.store;
    this.signer = options.signer;
    this.ciphersuite = options.ciphersuite;
    this.network = options.network;
  }

  /** Loads a group from the store */
  static async load(
    groupId: Uint8Array | string,
    options: Omit<MarmotGroupOptions, "ciphersuite"> & {
      cryptoProvider?: CryptoProvider;
    },
  ): Promise<MarmotGroup> {
    const state = await options.store.get(groupId);
    if (!state) throw new Error(`Group ${groupId} not found`);

    // Get the group's ciphersuite implementation
    const cipherSuite = await getCiphersuiteImpl(
      getCiphersuiteFromName(state.groupContext.cipherSuite),
      options.cryptoProvider,
    );

    return new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
  }

  /** Persists any pending changes to the group state in the store */
  async save() {
    if (!this.dirty) return;

    await this.store.update(this.state);
    this.dirty = false;
  }

  /** Publish an event to the group relays */
  async publish(event: NostrEvent): Promise<Record<string, PublishResponse>> {
    const relays = this.relays;
    if (!relays) throw new NoGroupRelaysError();
    return await this.network.publish(relays, event);
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

    if (!proposals)
      throw new Error("Proposal is undefined. This should not happen.");

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
    const { message } = await createProposal(
      this.state,
      false, // private message
      proposal,
      this.ciphersuite,
    );

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
    // Serialize the Nostr event (rumor) to application data according to the Marmot spec
    const applicationData = serializeApplicationRumor(rumor);

    // Create the application message using ts-mls
    const { newState, privateMessage } = await createApplicationMessage(
      this.state,
      applicationData,
      this.ciphersuite,
    );

    // Convert PrivateMessage to MLSMessage by wrapping it in the proper structure
    const mlsMessage: MLSMessage = {
      version: this.state.groupContext.version,
      wireformat: "mls_private_message",
      privateMessage,
    };

    // Wrap the message in a group event
    // Use this.state (not newState) to get the exporter_secret for the current epoch
    const applicationEvent = await createGroupEvent({
      message: mlsMessage,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    // Publish to the group's relays
    const response = await this.publish(applicationEvent);
    if (!hasAck(response))
      throw new NoRelayReceivedEventError(applicationEvent.id);

    // Update the group state after successful publish
    // Application messages update state for forward secrecy (key schedule rotation)
    this.state = newState;

    return response;
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
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const actorPubkey = await this.signer.getPublicKey();
    if (!groupData.adminPubkeys.includes(actorPubkey))
      throw new Error("Not a group admin. Cannot commit proposals.");

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

    // Only use extraProposals if we have proposals to include
    // Otherwise, createCommit will use ALL proposals from state.unappliedProposals
    if (allProposals.length > 0) {
      commitOptions.extraProposals = allProposals;
    }

    // Create the commit
    const { commit, newState, welcome } = await createCommit(
      { state: this.state, cipherSuite: this.ciphersuite },
      commitOptions,
    );

    // Wrap the commit in a group event
    // Use this.state (not newState) to get the exporter_secret for the current epoch
    // This ensures all members at the current epoch can decrypt the commit
    const commitEvent = await createGroupEvent({
      message: commit,
      state: this.state,
      ciphersuite: this.ciphersuite,
    });

    // Publish to the group's relays
    // MIP-02 REQUIRES: Commit MUST be published and acknowledged by relays BEFORE sending Welcome messages.
    // This ordering is critical for protocol correctness - new members must be able to fetch the commit
    // that added them before processing their Welcome.
    const response = await this.publish(commitEvent);
    if (!hasAck(response)) throw new NoRelayReceivedEventError(commitEvent.id);

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
      console.log(
        `[MarmotGroup.commit] Sending Welcome messages to ${options.welcomeRecipients.length} recipient(s)`,
      );

      // Send all welcome events in parallel
      await Promise.allSettled(
        options.welcomeRecipients.map(async (recipient) => {
          const welcomeRumor = createWelcomeRumor({
            welcome,
            author: actorPubkey,
            groupRelays: groupData.relays,
            keyPackageEventId: recipient.keyPackageEventId,
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
            console.log(
              `[MarmotGroup.commit] Retrieved inbox relays for recipient:`,
              inboxRelays,
            );
          } catch (error) {
            console.warn(
              `[MarmotGroup.commit] Failed to get inbox relays for recipient ${recipient.pubkey.slice(0, 16)}...:`,
              error,
            );
            // Fallback to group relays
            inboxRelays = groupData.relays || [];
          }

          if (inboxRelays.length === 0) {
            console.warn(
              `No relays available to send Welcome to recipient ${recipient.pubkey.slice(0, 16)}...`,
            );
            return;
          }

          const publishResult = await this.network.publish(
            inboxRelays,
            giftWrapEvent,
          );

          console.log(
            `[MarmotGroup.commit] Gift wrap publish result:`,
            publishResult,
          );

          // TODO: need to detect publish failure to attempt to send later
        }),
      );
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
   *
   * @param events - Array of Nostr events containing encrypted MLS messages
   * @param options - Options for controlling retry behavior
   * @param options.retryCount - Current retry attempt count (internal use)
   * @param options.maxRetries - Maximum number of retry attempts (default: 5)
   * @yields ProcessMessageResult - Either a new state (from commits/proposals) or an application message
   */
  async *ingest(
    events: NostrEvent[],
    options?: {
      retryCount?: number;
      maxRetries?: number;
    },
  ): AsyncGenerator<ProcessMessageResult> {
    // Set default retry options
    const retryCount = options?.retryCount ?? 0;
    const maxRetries = options?.maxRetries ?? 5;

    // Check if we've exceeded the maximum retry attempts.
    //
    // IMPORTANT: ingest() processes untrusted network input. If we throw here,
    // a single permanently-unreadable message (e.g. encrypted under an epoch we
    // can never decrypt, malformed ciphertext, spam) can DoS consumers.
    // Instead, stop retrying and drop the remaining unreadable events.
    if (retryCount > maxRetries) {
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

    const { read, unreadable } = await readGroupMessages(
      events,
      this.state,
      this.ciphersuite,
    );

    // If nothing was readable, exit
    if (read.length === 0) return;

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
        pair.message.privateMessage.contentType === "commit"
      ) {
        commits.push(pair);
      } else {
        nonCommits.push(pair);
      }
    }

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
        // Skip non-private/public messages (welcome, groupInfo, keyPackage, etc.)
        if (
          message.wireformat !== "mls_private_message" &&
          message.wireformat !== "mls_public_message"
        ) {
          continue;
        }

        // processMessage handles:
        // - Proposals: Adds them to state.unappliedProposals (keyed by proposal reference)
        // - Application messages: Decrypts content and returns it
        // - Both update state as needed (for forward secrecy)
        const result = await processMessage(
          message as MlsPrivateMessage | MlsPublicMessage,
          this.state,
          emptyPskIndex,
          acceptAll, // Accept all proposals (adds them to unappliedProposals)
          this.ciphersuite,
        );

        // Update state if message changed it
        if (result.kind === "newState") {
          this.state = result.newState;
          yield result;
        } else if (result.kind === "applicationMessage") {
          // Application messages also update state (for forward secrecy)
          this.state = result.newState;
          yield result;
        }
      } catch (error) {
        // Message processing failed - might be invalid or from wrong epoch
        // Add to unreadable for retry later (might become readable after state updates)
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
      if (!isPrivateMessage(message)) continue;

      const commitEpoch =
        typeof message.privateMessage.epoch === "bigint"
          ? message.privateMessage.epoch
          : BigInt(message.privateMessage.epoch);
      const currentEpoch = this.state.groupContext.epoch;

      // Skip commits from past epochs - we've already processed these
      if (commitEpoch < currentEpoch) {
        continue;
      }

      // Skip commits that are too far in the future
      // We can only process commits for the current epoch or the next epoch
      if (commitEpoch > currentEpoch + 1n) {
        unreadable.push(event);
        continue;
      }

      try {
        // processMessage handles:
        // - Decrypts the private message using group secrets from the current state
        // - Verifies message authenticity and sender
        // - Resolves proposal references from state.unappliedProposals (if needed)
        // - Applies the commit (updates ratchet tree, advances epoch, rotates keys)
        const result = await processMessage(
          message,
          this.state,
          emptyPskIndex,
          adminCallback, // Use admin verification callback for commits
          this.ciphersuite,
        );

        if (result.kind === "newState") {
          // If the commit was rejected by the callback (admin verification),
          // do not advance state, do not yield, and do not retry.
          if (result.actionTaken === "reject") {
            continue;
          }

          // Successfully processed the commit - update our state
          // After each commit, the epoch advances and keys rotate
          this.state = result.newState;
          yield result;
        }
      } catch (error) {
        // Commit processing failed - add to unreadable for retry
        // It might become valid after processing more proposals or state updates
        unreadable.push(event);
      }
    }

    // Save the group state after processing all messages
    await this.save();

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
      yield* this.ingest(unreadable, {
        retryCount: retryCount + 1,
        maxRetries: maxRetries,
      });
    }
  }
}
