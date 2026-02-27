import { bytesToHex } from "@noble/hashes/utils.js";
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import {
  Capabilities,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  joinGroup,
  KeyPackage,
  PrivateKeyPackage,
} from "ts-mls";
import { CiphersuiteName, ciphersuites } from "ts-mls/crypto/ciphersuite.js";
import { marmotAuthService } from "../core/auth-service.js";
import { createCredential } from "../core/credential.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { createSimpleGroup, SimpleGroupOptions } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE } from "../core/protocol.js";
import {
  createKeyPackageEvent,
  createDeleteKeyPackageEvent,
} from "../core/key-package-event.js";
import { getWelcome } from "../core/welcome.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../core/client-state.js";
import {
  GroupStateStore,
  GroupStateStoreBackend,
} from "../store/group-state-store.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import {
  BaseGroupHistory,
  GroupHistoryFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import type { GroupTransport } from "./transports/group-transport.js";
import type { InviteTransport } from "./transports/invite-transport.js";
import type { EventTemplate } from "nostr-tools";

/**
 * Factory function called once per group instance to create its {@link GroupTransport}.
 *
 * @param groupId - The MLS group ID bytes
 * @param stateAccessor - Returns the current {@link ClientState} for the group.
 *   Call this each time the transport needs the latest exporter secret (e.g.
 *   after a commit advances the epoch).
 */
export type GroupTransportFactory = (
  groupId: Uint8Array,
  stateAccessor: () => ClientState,
) => GroupTransport;

export type MarmotClientOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
> = {
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /** The backend to store and load the groups from */
  groupStateBackend: GroupStateStoreBackend;
  /** The backend to store and load the key packages from */
  keyPackageStore: KeyPackageStore;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /**
   * Factory that creates a {@link GroupTransport} for each group instance.
   * Called once when a group is created, loaded, or imported.
   */
  groupTransportFactory: GroupTransportFactory;
  /**
   * Transport used for delivering MLS Welcome messages to new members.
   * A single instance is shared across all groups managed by this client.
   */
  inviteTransport: InviteTransport;
} & (THistory extends undefined
  ? {}
  : {
      /** The group history interface to be passed to group instaces */
      historyFactory: GroupHistoryFactory<THistory>;
    });

/** Given a MarmotClient type, returns the MarmotGroup class type with the same THistory. */
export type InferGroupType<TClient extends MarmotClient<any>> =
  TClient extends MarmotClient<infer THistory> ? MarmotGroup<THistory> : never;

type MarmotClientEvents<THistory extends BaseGroupHistory | undefined = any> = {
  /** Emitted when the groups array is updated */
  groupsUpdated: (groups: MarmotGroup<THistory>[]) => void;
  /** Emitted when a group is loaded from the store */
  groupLoaded: (group: MarmotGroup<THistory>) => void;
  /** Emitted when a new group is created */
  groupCreated: (group: MarmotGroup<THistory>) => void;
  /** Emitted when a group is imported from a ClientState object */
  groupImported: (group: MarmotGroup<THistory>) => void;
  /** Emitted when a group is joined */
  groupJoined: (group: MarmotGroup<THistory>) => void;
  /** Emitted when a key package should be deleted from relays after successful join (MIP-00). */
  keyPackageRelayDeleteRequested: (args: { keyPackageEventId: string }) => void;
  /** Emitted when a group is unloaded */
  groupUnloaded: (groupId: Uint8Array) => void;
  /** Emitted when a group is destroyed */
  groupDestroyed: (groupId: Uint8Array) => void;
};

export class MarmotClient<
  THistory extends BaseGroupHistory | undefined = any,
> extends EventEmitter<MarmotClientEvents<THistory>> {
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The capabilities to use for the client */
  readonly capabilities: Capabilities;
  /** The store for group state (bytes-only) */
  readonly groupStateStore: GroupStateStore;
  /** The backend to store and load the key packages from */
  readonly keyPackageStore: KeyPackageStore;
  /** Factory for creating a GroupTransport per group */
  readonly groupTransportFactory: GroupTransportFactory;
  /** Transport for sending Welcome messages to new members */
  readonly inviteTransport: InviteTransport;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  /** An array of all loaded groups */
  get groups() {
    return Array.from(this.#groups.values());
  }

  /** Group history interface to be passed to group instaces */
  private historyFactory: GroupHistoryFactory<THistory>;

  constructor(options: MarmotClientOptions<THistory>) {
    super();
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.groupStateStore = new GroupStateStore(options.groupStateBackend);
    this.keyPackageStore = options.keyPackageStore;
    this.groupTransportFactory = options.groupTransportFactory;
    this.inviteTransport = options.inviteTransport;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;

    // Set the history factory if its set in the options
    this.historyFactory = (
      "historyFactory" in options ? options.historyFactory : undefined
    ) as GroupHistoryFactory<THistory>;
  }

  /** Get a ciphersuite implementation from a name */
  private async getCiphersuiteImpl(name?: CiphersuiteName) {
    const ciphersuiteName =
      name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
    const id = ciphersuites[ciphersuiteName];
    return await this.cryptoProvider.getCiphersuiteImpl(id);
  }

  /** Hydrates a SerializedClientState into a ClientState using this client's config */
  private hydrateState(serialized: SerializedClientState): ClientState {
    return deserializeClientState(serialized);
  }

  /** Serializes a ClientState into bytes */
  private serializeState(state: ClientState): SerializedClientState {
    return serializeClientState(state);
  }

  /** Internal store for loaded group classes */
  #groups = new Map<string, MarmotGroup<THistory>>();

  /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
  #groupLoadPromises = new Map<string, Promise<MarmotGroup<THistory>>>();

  /** Sets a group instance in the cache */
  private setGroupInstance(group: MarmotGroup<THistory>) {
    this.#groups.set(bytesToHex(group.id), group);
    this.emit("groupsUpdated", this.groups);
  }
  private clearGroupInstance(groupId: Uint8Array | string) {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);

    if (this.#groups.has(id)) {
      this.#groups.delete(id);
      this.emit("groupsUpdated", this.groups);
    }
  }

  /**
   * Creates a GroupTransport for the given ClientState.
   * The stateAccessor always reads the live group state from the group map
   * (or falls back to the initial state until the group is cached).
   */
  private makeGroupTransport(
    groupId: Uint8Array,
    initialState: ClientState,
  ): GroupTransport {
    const idHex = bytesToHex(groupId);
    const stateAccessor = (): ClientState => {
      const cached = this.#groups.get(idHex);
      return cached ? cached.state : initialState;
    };
    return this.groupTransportFactory(groupId, stateAccessor);
  }

  /** Loads a new group from the store */
  private async loadGroup(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory>> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    const stateBytes = await this.groupStateStore.get(id);

    if (!stateBytes) {
      throw new Error(`Group ${bytesToHex(id)} not found`);
    }

    const state = this.hydrateState(stateBytes);
    const groupTransport = this.makeGroupTransport(id, state);

    return await MarmotGroup.fromClientState<THistory>(state, {
      stateStore: this.groupStateStore,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      groupTransport,
      inviteTransport: this.inviteTransport,
      history: this.historyFactory,
    });
  }

  /** Gets a group from cache or loads it from store */
  async getGroup(groupId: Uint8Array | string): Promise<MarmotGroup<THistory>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    let group = this.#groups.get(id);

    if (!group) {
      const existingLoad = this.#groupLoadPromises.get(id);
      if (existingLoad) {
        group = await existingLoad;
      } else {
        const loadPromise = this.loadGroup(groupId)
          .then((loaded) => {
            // Save group to cache
            this.setGroupInstance(loaded);
            this.emit("groupLoaded", loaded);
            return loaded;
          })
          .finally(() => {
            this.#groupLoadPromises.delete(id);
          });

        this.#groupLoadPromises.set(id, loadPromise);
        group = await loadPromise;
      }
    }

    return group;
  }

  /** Loads all groups from the store and returns them */
  async loadAllGroups(): Promise<MarmotGroup<THistory>[]> {
    const groupIds = await this.groupStateStore.list();

    return await Promise.all(groupIds.map((groupId) => this.getGroup(groupId)));
  }

  /** Imports a new group from a ClientState object */
  async importGroupFromClientState(
    state: ClientState,
  ): Promise<MarmotGroup<THistory>> {
    const id = bytesToHex(state.groupContext.groupId);
    if (await this.groupStateStore.has(state.groupContext.groupId)) {
      throw new Error(`Group ${id} already exists`);
    }

    // Serialize and store the state
    const stateBytes = this.serializeState(state);
    await this.groupStateStore.set(state.groupContext.groupId, stateBytes);

    const groupTransport = this.makeGroupTransport(
      state.groupContext.groupId,
      state,
    );

    // Create a new MarmotGroup instance from the ClientState
    const group = await MarmotGroup.fromClientState<THistory>(state, {
      stateStore: this.groupStateStore,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      groupTransport,
      inviteTransport: this.inviteTransport,
      history: this.historyFactory,
    });

    // Add group to cache
    this.setGroupInstance(group);
    this.emit("groupImported", group);

    return group;
  }

  /** Unloads a group from the client but does not remove it from the store */
  async unloadGroup(groupId: Uint8Array | string): Promise<void> {
    const hex = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.clearGroupInstance(hex);
    this.emit("groupUnloaded", hex);
  }

  /** Destroys a group and purges the group history */
  async destroyGroup(groupId: Uint8Array | string): Promise<void> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);

    // Get the existing instance or load a new one
    const group = this.#groups.get(id) || (await this.loadGroup(groupId));

    // Use the instance to destroy the group.
    // NOTE: MarmotGroup.destroy() is the single owner of removing group state from storage.
    await group.destroy();

    const hexId = typeof groupId === "string" ? hexToBytes(groupId) : groupId;

    // Remove the group from the cache
    this.#groups.delete(id);

    // Emit events
    this.emit("groupDestroyed", hexId);
    this.emit("groupsUpdated", this.groups);
  }

  /** Creates a new simple group */
  async createGroup(
    name: string,
    options?: SimpleGroupOptions & {
      ciphersuite?: CiphersuiteName;
    },
  ): Promise<MarmotGroup<THistory>> {
    const ciphersuiteImpl = await this.getCiphersuiteImpl(options?.ciphersuite);

    // generate a new key package
    const pubkey = await this.signer.getPublicKey();
    const credential = await createCredential(pubkey);
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const { clientState } = await createSimpleGroup(
      keyPackage,
      ciphersuiteImpl,
      name,
      // Always include the creator as an admin
      { ...options, adminPubkeys: [pubkey, ...(options?.adminPubkeys || [])] },
    );

    // Save the group to the store
    const stateBytes = this.serializeState(clientState);
    await this.groupStateStore.set(
      clientState.groupContext.groupId,
      stateBytes,
    );

    const groupTransport = this.makeGroupTransport(
      clientState.groupContext.groupId,
      clientState,
    );

    // Create and cache the MarmotGroup instance
    const group = new MarmotGroup<THistory>(clientState, {
      ciphersuite: ciphersuiteImpl,
      stateStore: this.groupStateStore,
      signer: this.signer,
      groupTransport,
      inviteTransport: this.inviteTransport,
      history: this.historyFactory,
    });

    // Save the group to the cache
    this.setGroupInstance(group);
    this.emit("groupCreated", group);

    return group;
  }

  /**
   * Joins a group from a Welcome message received via NIP-59 gift wrap.
   *
   * This method:
   * 1. Decodes the Welcome message from the kind 444 event
   * 2. Finds the matching local KeyPackage private material from the store
   * 3. Calls ts-mls joinGroup() to create a new ClientState
   * 4. Persists the resulting ClientState
   * 5. Returns a MarmotGroup instance ready to ingest group events
   *
   * @param options - Options for joining from a Welcome message
   * @param options.welcomeRumor - The unwrapped kind 444 rumor event containing the Welcome message
   * @param options.keyPackageEventId - Optional ID of the KeyPackage event used for the add (for finding the right key package)
   * @returns Promise resolving to a MarmotGroup instance
   * @throws Error if no matching KeyPackage is found or if joining fails
   */
  async joinGroupFromWelcome(options: {
    welcomeRumor: Rumor;
    keyPackageEventId?: string;
  }): Promise<MarmotGroup<THistory>> {
    const { welcomeRumor, keyPackageEventId: explicitKeyPackageEventId } =
      options;

    // Decode the Welcome message from the kind 444 event
    const mlsWelcome = getWelcome(welcomeRumor);
    const welcome = mlsWelcome;

    // Extract keyPackageEventId from welcome rumor tags if not explicitly provided
    // The keyPackageEventId is stored as an "e" tag in the welcome message per MIP-00
    const keyPackageEventId =
      explicitKeyPackageEventId ??
      welcomeRumor.tags.find((tag) => tag[0] === "e")?.[1];

    // Get the ciphersuite implementation for the Welcome
    const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
      welcome.cipherSuite,
    );
    // Find all local KeyPackage candidates with matching cipherSuite
    const allKeyPackages = await this.keyPackageStore.list();
    const candidatePackages: Array<{
      publicPackage: KeyPackage;
      privatePackage: PrivateKeyPackage;
      keyPackageRef: Uint8Array;
      hasMatchingSecret: boolean;
    }> = [];

    // Collect all key packages with matching cipher suite and compute their KeyPackageRef
    for (const keyPackage of allKeyPackages) {
      if (keyPackage.publicPackage.cipherSuite !== welcome.cipherSuite) {
        continue;
      }

      const privatekeyPackage = await this.keyPackageStore.getPrivateKey(
        keyPackage.keyPackageRef,
      );
      if (!privatekeyPackage) continue;

      const hasMatchingSecret = welcome.secrets.some((secret: any) =>
        secret.newMember.length === keyPackage.keyPackageRef.length
          ? secret.newMember.every(
              (val: number, idx: number) =>
                val === keyPackage.keyPackageRef[idx],
            )
          : false,
      );

      candidatePackages.push({
        publicPackage: keyPackage.publicPackage,
        privatePackage: privatekeyPackage,
        keyPackageRef: keyPackage.keyPackageRef,
        hasMatchingSecret,
      });
    }

    if (candidatePackages.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    if (keyPackageEventId) {
      console.log(
        `Welcome message references key package event: ${keyPackageEventId}`,
      );
    }

    // Prioritize packages that have matching secrets in the welcome
    const prioritizedKeyPackages = [
      ...candidatePackages.filter((p) => p.hasMatchingSecret),
      ...candidatePackages.filter((p) => !p.hasMatchingSecret),
    ];

    // Try each key package in priority order until one successfully decrypts the Welcome message
    let clientState: ClientState | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;
    let consumedKeyPackage: KeyPackage | null = null;

    for (const keyPackage of prioritizedKeyPackages) {
      try {
        clientState = await joinGroup({
          context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            externalPsks: {},
          },
          welcome,
          keyPackage: keyPackage.publicPackage,
          privateKeys: keyPackage.privatePackage,
        });
        consumedKeyPackageRef = keyPackage.keyPackageRef;
        consumedKeyPackage = keyPackage.publicPackage;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (!clientState) {
      const errorMessage = lastError
        ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
        : "Failed to join group with any matching key package";
      throw new Error(errorMessage);
    }

    // MIP-00: After successfully processing a Welcome, clients SHOULD delete
    // the consumed KeyPackage from local storage to minimize reuse/exposure.
    if (consumedKeyPackageRef) {
      const isLastResort = !!consumedKeyPackage?.extensions?.some(
        (ext) =>
          typeof ext === "object" &&
          ext !== null &&
          "extensionType" in ext &&
          (ext as { extensionType: number }).extensionType ===
            LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
      );

      if (isLastResort) {
        console.warn(
          "[MarmotClient.joinGroupFromWelcome] Consumed KeyPackage had last_resort extension; retaining local private material per MIP-00",
        );
      } else {
        await this.keyPackageStore.remove(consumedKeyPackageRef);
      }
    }

    // Save the group state to the store
    const stateBytes = this.serializeState(clientState);
    await this.groupStateStore.set(
      clientState.groupContext.groupId,
      stateBytes,
    );

    const groupTransport = this.makeGroupTransport(
      clientState.groupContext.groupId,
      clientState,
    );

    // Create and cache the MarmotGroup instance
    const group = new MarmotGroup<THistory>(clientState, {
      ciphersuite: ciphersuiteImpl,
      stateStore: this.groupStateStore,
      signer: this.signer,
      groupTransport,
      inviteTransport: this.inviteTransport,
      history: this.historyFactory,
    });

    // Add the group to the cache
    this.setGroupInstance(group);
    this.emit("groupJoined", group);

    // MIP-00: best-effort request to delete the relay-published KeyPackage event.
    if (keyPackageEventId) {
      this.emit("keyPackageRelayDeleteRequested", { keyPackageEventId });
    }

    // MIP-02 SHOULD: post-join self-update to rotate leaf key material for forward secrecy.
    try {
      await group.selfUpdate();
      console.log(
        `[MarmotClient.joinGroupFromWelcome] Post-join self-update commit sent`,
      );
    } catch (err) {
      console.warn(
        `[MarmotClient.joinGroupFromWelcome] Post-join self-update failed:`,
        err,
      );
    }

    return group;
  }

  /**
   * Watches for changes to the groups in the store.
   * Returns an async generator that yields the current list of groups
   * whenever the store changes.
   */
  async *watchGroups(): AsyncGenerator<MarmotGroup<THistory>[]> {
    let resolveNext: (() => void) | null = null;

    const handleChange = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.groupStateStore.on("groupStateAdded", handleChange);
    this.groupStateStore.on("groupStateUpdated", handleChange);
    this.groupStateStore.on("groupStateRemoved", handleChange);

    try {
      yield await this.loadAllGroups();

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        yield await this.loadAllGroups();
      }
    } finally {
      this.groupStateStore.off("groupStateAdded", handleChange);
      this.groupStateStore.off("groupStateUpdated", handleChange);
      this.groupStateStore.off("groupStateRemoved", handleChange);
    }
  }

  /**
   * Watches for key package changes.
   * Returns an async generator that yields the current list of key packages
   * whenever the store changes.
   */
  async *watchKeyPackages(): AsyncGenerator<
    Awaited<ReturnType<KeyPackageStore["list"]>>
  > {
    let resolveNext: (() => void) | null = null;

    const handleChange = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.keyPackageStore.on("keyPackageAdded", handleChange);
    this.keyPackageStore.on("keyPackageRemoved", handleChange);

    try {
      yield await this.keyPackageStore.list();

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        yield await this.keyPackageStore.list();
      }
    } finally {
      this.keyPackageStore.off("keyPackageAdded", handleChange);
      this.keyPackageStore.off("keyPackageRemoved", handleChange);
    }
  }

  /**
   * Rotates key packages by generating a fresh one and retiring old ones.
   *
   * @param options - Options for key package rotation
   * @returns The new key package event template and optional delete event template
   */
  async rotateKeyPackage(options?: {
    relays?: string[];
    client?: string;
    oldEventIds?: string[];
    ciphersuite?: CiphersuiteName;
    isLastResort?: boolean;
    protected?: boolean;
  }): Promise<{
    keyPackageEvent: EventTemplate;
    deleteEvent?: EventTemplate;
  }> {
    const ciphersuiteImpl = await this.getCiphersuiteImpl(options?.ciphersuite);

    const pubkey = await this.signer.getPublicKey();
    const credential = createCredential(pubkey);
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      isLastResort: options?.isLastResort,
    });

    await this.keyPackageStore.add(keyPackage);

    const keyPackageEvent = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      relays: options?.relays,
      client: options?.client,
      protected: options?.protected,
    });

    let deleteEvent: EventTemplate | undefined;
    if (options?.oldEventIds && options.oldEventIds.length > 0) {
      deleteEvent = createDeleteKeyPackageEvent({
        events: options.oldEventIds,
      });
    }

    return { keyPackageEvent, deleteEvent };
  }
}
