/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { hexToBytes, type NostrEvent } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  joinGroup,
  Welcome,
} from "ts-mls";
import { SerializedClientState } from "../core/client-state.js";
import {
  type AccountIdentityProofSigner,
  verifyAllLeafAccountIdentityProofs,
} from "../core/account-identity-proof.js";
import { marmotAuthService } from "../core/auth-service.js";
import { logger } from "../utils/debug.js";
import { hasAck } from "../utils/index.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import { createInviteIntent } from "./group/invite.js";
import type { WelcomeKeyPackageCandidate } from "./key-package-store.js";
import { GroupFactory, type CreateGroupOptions } from "./group-factory.js";
import { GroupRegistry } from "./group-registry.js";
import type { GroupRuntime } from "./runtime/group-runtime.js";
import type {
  GroupPublishResult,
  GroupSessionSendIntent,
} from "./session/group-effects.js";
import type {
  DispositionedIngestResult,
  GroupSession,
} from "./session/group-session.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "./nostr-interface.js";

const log = logger.extend("GroupsManager");

/** Options for creating a new GroupsManager */
export type GroupsManagerOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The backend storing serialized group state bytes */
  store: GenericKeyValueStore<SerializedClientState>;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /**
   * Signs the account identity proof carried on the group creator's own leaf.
   * Required for the creator to be addable to spec-conformant groups, which
   * validate the proof on every leaf.
   */
  accountProofSigner?: AccountIdentityProofSigner;
  /** The nostr relay pool to use for the client */
  network: NostrNetworkInterface;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** Optional group history factory passed to each MarmotGroup instance */
  historyFactory?: GroupHistoryFactory<THistory>;
  /** Optional group media factory passed to each MarmotGroup instance */
  mediaFactory?: GroupMediaFactory<TMedia>;
};

/** Events emitted by {@link GroupsManager} */
export type GroupsManagerEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the set of loaded groups changes */
  updated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
  /** Emitted when a group is loaded from the store */
  loaded: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a new group is created */
  created: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is imported from a ClientState object */
  imported: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is joined */
  joined: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is unloaded */
  unloaded: (groupId: Uint8Array) => void;
  /** Emitted when a group is destroyed */
  destroyed: (groupId: Uint8Array) => void;
  /** Emitted when the client leaves a group via self-remove proposal events */
  left: (groupId: Uint8Array) => void;
  /**
   * Emitted when an inbound commit removed the client from a group — an admin's
   * involuntary Remove, or a peer committing the client's own self_remove. The
   * group's local state is kept as a `removedFromGroup` tombstone; the app may
   * call {@link GroupsManager.destroy} to purge it.
   */
  removed: (groupId: Uint8Array) => void;
};

/**
 * Orchestrates the lifecycle of {@link MarmotGroup} instances. Delegates
 * in-memory caching and store hydration to a {@link GroupRegistry} and group
 * construction to a {@link GroupFactory}, layering the public lifecycle events
 * (created/imported/joined/destroyed/left) and the send/ingest facade on top.
 */
export class GroupsManager<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> extends EventEmitter<GroupsManagerEvents<THistory, TMedia>> {
  /** The backend storing serialized group state bytes */
  readonly store: GenericKeyValueStore<SerializedClientState>;
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** Signs the account identity proof on the group creator's own leaf */
  readonly accountProofSigner?: AccountIdentityProofSigner;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  /** Owns the in-memory cache + store hydration. */
  readonly #registry: GroupRegistry<THistory, TMedia>;
  /** Builds new groups (the accountProofSigner/ciphersuite consumer). */
  readonly #factory: GroupFactory<THistory, TMedia>;

  constructor(options: GroupsManagerOptions<THistory, TMedia>) {
    super();
    this.store = options.store;
    this.signer = options.signer;
    this.accountProofSigner = options.accountProofSigner;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;

    this.#registry = new GroupRegistry<THistory, TMedia>({
      store: options.store,
      signer: options.signer,
      network: options.network,
      cryptoProvider: this.cryptoProvider,
      historyFactory: options.historyFactory,
      mediaFactory: options.mediaFactory,
    });

    this.#factory = new GroupFactory<THistory, TMedia>({
      store: options.store,
      signer: options.signer,
      network: options.network,
      cryptoProvider: this.cryptoProvider,
      accountProofSigner: options.accountProofSigner,
      historyFactory: options.historyFactory,
      mediaFactory: options.mediaFactory,
    });

    // Forward the registry's cache-level events as our own.
    this.#registry.on("updated", (groups) => this.emit("updated", groups));
    this.#registry.on("loaded", (group) => this.emit("loaded", group));
    this.#registry.on("removed", (group) => this.emit("removed", group.id));
  }

  /** Returns the list of currently loaded group instances */
  get loaded(): MarmotGroup<THistory, TMedia>[] {
    return this.#registry.loaded;
  }

  /** Lists all persisted group IDs, decoded from their hex storage keys. */
  async listIds(): Promise<Uint8Array[]> {
    return this.#registry.listIds();
  }

  /** Checks if a group exists in the backend */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    return this.#registry.has(groupId);
  }

  /** Gets a group from cache or loads it from store */
  async get(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    return this.#registry.get(groupId);
  }

  /** Returns the protocol session for a loaded or persisted group. */
  async session(groupId: Uint8Array | string): Promise<GroupSession<THistory>> {
    return (await this.get(groupId)).session;
  }

  /** Returns the runtime publisher for a loaded or persisted group. */
  async runtime(groupId: Uint8Array | string): Promise<GroupRuntime> {
    return (await this.get(groupId)).runtime;
  }

  /** Sends a session intent and publishes the resulting effects through the group runtime. */
  async send(
    groupId: Uint8Array | string,
    intent: GroupSessionSendIntent,
  ): Promise<GroupPublishResult[]> {
    const group = await this.get(groupId);
    const effects = await group.session.send(intent);
    return group.runtime.publishEffects(effects);
  }

  /**
   * Invites a user to a group from their KeyPackage event (kind 30443).
   *
   * Resolves the committing member from the manager's signer, builds an Add
   * commit intent via {@link createInviteIntent}, and drives it through the
   * group session/runtime. After the commit acks, the runtime delivers a
   * Welcome to the invitee via NIP-59 gift wrap.
   *
   * @returns Per-relay publish responses for the commit group event.
   * @throws Error if the event is not a KeyPackage kind or the credential
   *   identity does not match the event author.
   */
  async invite(
    groupId: Uint8Array | string,
    keyPackageEvent: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    const actorPubkey = await this.signer.getPublicKey();
    const [result] = await this.send(
      groupId,
      createInviteIntent({ keyPackageEvent, actorPubkey }),
    );
    return result.response;
  }

  /**
   * Creates a commit from proposals and publishes it to the group.
   *
   * Resolves the committing member from the manager's signer, builds a `commit`
   * intent, and drives it through the group session/runtime. See
   * {@link GroupSessionSendIntent} for how `extraProposals`, `proposalRefs`, and
   * `welcomeRecipients` are interpreted. Requires a group admin.
   *
   * @returns Per-relay publish responses for the commit group event.
   */
  async commit(
    groupId: Uint8Array | string,
    options?: Omit<
      Extract<GroupSessionSendIntent, { kind: "commit" }>,
      "kind" | "actorPubkey"
    >,
  ): Promise<Record<string, PublishResponse>> {
    const actorPubkey = await this.signer.getPublicKey();
    const [result] = await this.send(groupId, {
      kind: "commit",
      actorPubkey,
      extraProposals: options?.extraProposals,
      proposalRefs: options?.proposalRefs,
      welcomeRecipients: options?.welcomeRecipients,
    });
    return result.response;
  }

  /** Ingests group transport events through the group's protocol session. */
  async *ingest(
    groupId: Uint8Array | string,
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    const group = await this.get(groupId);
    // Route through the group facade (not the raw session) so an elected
    // self_remove auto-commit (B6) is published via the group's runtime.
    yield* group.ingest(events, options);
  }

  /** Loads all groups from the store and returns them */
  async loadAll(): Promise<MarmotGroup<THistory, TMedia>[]> {
    return this.#registry.loadAll();
  }

  /**
   * Persists and caches a group built from a {@link ClientState}, emitting
   * the given lifecycle event. Used by higher-level flows (e.g. joining from
   * a welcome message) that construct ClientStates themselves.
   *
   * @param state - The ClientState to adopt
   * @returns The persisted and cached MarmotGroup
   * @throws Error if a group with the same id already exists
   */
  async adoptClientState(
    state: ClientState,
    options?: {
      /** Which lifecycle event to emit. Defaults to `"imported"`. */
      emit?: "imported" | "joined";
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const eventName = options?.emit ?? "imported";
    const id = bytesToHex(state.groupContext.groupId);

    if (await this.#registry.has(state.groupContext.groupId)) {
      throw new Error(`Group ${id} already exists`);
    }

    const group = await this.#registry.build(state);

    // Persist initial state via the group's own save() path.
    // MarmotGroup.save() is the single writer into the group state store.
    await group.save(true);

    this.#registry.track(group);
    this.emit(eventName, group);
    log("adopted group %s (emit=%s)", id, eventName);

    return group;
  }

  /**
   * Imports a new group from a {@link ClientState} object, persisting it to
   * the store and emitting `imported`.
   */
  async import(state: ClientState): Promise<MarmotGroup<THistory, TMedia>> {
    return this.adoptClientState(state, { emit: "imported" });
  }

  /**
   * Joins a group from a decoded MLS {@link Welcome} using locally held key
   * package candidates (produced by `KeyPackageManager.selectForWelcome`).
   *
   * Mirrors the darkmatter engine `do_join_welcome`: the KeyPackageRef→private
   * bundle match and the MLS join happen here, in the group layer, not in the
   * composition root. Tries candidates in priority order, validates every leaf
   * carries a valid account identity proof, then adopts the resulting state and
   * emits `joined`.
   *
   * @returns The joined group and the KeyPackageRef that was consumed (so the
   *   caller can mark it used), or `consumedKeyPackageRef: null` if none matched.
   */
  async joinFromWelcome(options: {
    welcome: Welcome;
    candidates: WelcomeKeyPackageCandidate[];
    ciphersuiteImpl: CiphersuiteImpl;
  }): Promise<{
    group: MarmotGroup<THistory, TMedia>;
    consumedKeyPackageRef: Uint8Array | null;
  }> {
    const { welcome, candidates, ciphersuiteImpl } = options;

    if (candidates.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    let clientState: ClientState | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;

    for (const candidate of candidates) {
      try {
        clientState = await joinGroup({
          context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            externalPsks: {},
          },
          welcome,
          keyPackage: candidate.publicPackage,
          privateKeys: candidate.privatePackage,
        });
        consumedKeyPackageRef = candidate.keyPackageRef;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (!clientState) {
      throw new Error(
        lastError
          ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
          : "Failed to join group with any matching key package",
      );
    }

    // The spec requires every member leaf to carry a valid account identity
    // proof, with no legacy fallback; reject joining a group that contains any
    // proof-less or invalid leaf (foundation/account-identity-proof-v1.md).
    verifyAllLeafAccountIdentityProofs(clientState, ciphersuiteImpl.id);

    const group = await this.adoptClientState(clientState, { emit: "joined" });
    return { group, consumedKeyPackageRef };
  }

  /** Unloads a group from the client but does not remove it from the store */
  async unload(groupId: Uint8Array | string): Promise<void> {
    const hex = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.#registry.untrack(hex);
    this.emit("unloaded", hex);
  }

  /** Destroys a group and purges the group history */
  async destroy(groupId: Uint8Array | string): Promise<void> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("destroying group %s", id);

    const group = this.#registry.peek(id) ?? (await this.#registry.load(id));

    // NOTE: MarmotGroup.destroy() is the single owner of removing group state
    // from storage. It emits `destroyed`, which the registry listener uses to
    // clear the in-memory cache and emit `updated`.
    await group.destroy();

    const hexId = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.emit("destroyed", hexId);
  }

  /**
   * Leaves a group by publishing a self-remove proposal and purging all
   * local group data from storage.
   *
   * At least one relay must acknowledge the proposals before local state is
   * destroyed. If no relay acks, an error is thrown and local state is
   * preserved so the caller can retry.
   *
   * @param groupId - The group ID as a hex string or Uint8Array.
   * @returns The relay publish responses for the leave proposal event(s).
   */
  async leave(
    groupId: Uint8Array | string,
  ): Promise<Record<string, PublishResponse>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("leaving group %s", id);

    const group = this.#registry.peek(id) ?? (await this.#registry.load(id));
    const groupIdBytes =
      typeof groupId === "string" ? hexToBytes(groupId) : groupId;

    // "leave is a SendIntent": the session builds the self-remove proposals
    // (RFC 9420 §12.4 — a member cannot commit a Remove targeting their own
    // leaf, so an admin applies them later) and we publish them here.
    const ownPubkey = await this.signer.getPublicKey();
    const effects = await group.session.leave(ownPubkey);

    const response: Record<string, PublishResponse> = {};
    for (const result of await group.runtime.publishEffects(effects))
      Object.assign(response, result.response);

    // publishEffects already throws on no-ack, but guard local destruction
    // behind an explicit ack check so state is preserved on failure and the
    // caller can retry.
    if (!hasAck(response)) {
      throw new Error(
        "Failed to publish leave proposals: no relay acknowledged. Local state preserved — retry leave() to try again.",
      );
    }

    // group.destroy() purges local state and emits `destroyed`; the registry
    // listener clears the in-memory cache and emits `updated`.
    await group.destroy();

    this.emit("left", groupIdBytes);

    return response;
  }

  /** Creates a new simple group */
  async create(
    name: string,
    options?: CreateGroupOptions,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    log("creating group %o", name);
    const group = await this.#factory.create(name, options);

    this.#registry.track(group);
    this.emit("created", group);
    log("created group %s", group.idStr);

    return group;
  }

  /**
   * Watches for changes to the groups in the store.
   * Returns an async generator that yields the current list of groups
   * whenever the store changes.
   */
  async *watch(): AsyncGenerator<MarmotGroup<THistory, TMedia>[]> {
    let resolveNext: (() => void) | null = null;

    const handleChange = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    // `updated` fires whenever the set of loaded groups changes
    // (create, import, join, load, unload, destroy, leave).
    this.on("updated", handleChange);

    try {
      // Yield initial state after listeners are installed to avoid missing updates
      // that occur between snapshot and subscription.
      yield [...(await this.loadAll())];

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        yield [...(await this.loadAll())];
      }
    } finally {
      this.off("updated", handleChange);
    }
  }
}
