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
  GroupInfo,
  joinGroup,
  KeyPackage,
  PrivateKeyPackage,
  Welcome,
} from "ts-mls";
import { CiphersuiteName, ciphersuites } from "ts-mls/crypto/ciphersuite.js";
import { marmotAuthService } from "../core/auth-service.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../core/client-state.js";
import { createCredential } from "../core/credential.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { createSimpleGroup, SimpleGroupOptions } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { isRumorLike } from "../core/nostr.js";
import {
  getWelcome,
  getWelcomeKeyPackageRefs,
  readWelcomeGroupInfo,
} from "../core/welcome.js";
import {
  GroupStateStore,
  GroupStateStoreBackend,
} from "../store/group-state-store.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { logger } from "../utils/debug.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import { KeyPackageManager } from "./key-package-manager.js";
import { NostrNetworkInterface } from "./nostr-interface.js";

const log = logger.extend("client");

export type MarmotClientOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /** The backend to store and load the groups from */
  groupStateBackend: GroupStateStoreBackend;
  /** The store for key package private material and publish tracking */
  keyPackageStore: KeyPackageStore;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
} & (THistory extends undefined
  ? {}
  : {
      /** The group history interface to be passed to group instance */
      historyFactory: GroupHistoryFactory<THistory>;
    }) &
  (TMedia extends undefined
    ? {}
    : {
        /** The group media interface to be passed to group instance */
        mediaFactory: GroupMediaFactory<TMedia>;
      });

type MarmotClientEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the groups array is updated */
  groupsUpdated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
  /** Emitted when a group is loaded from the store */
  groupLoaded: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a new group is created */
  groupCreated: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is imported from a ClientState object */
  groupImported: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is joined */
  groupJoined: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is unloaded */
  groupUnloaded: (groupId: Uint8Array) => void;
  /** Emitted when a group is destroyed */
  groupDestroyed: (groupId: Uint8Array) => void;
  /** Emitted when the client leaves a group via a self-remove commit */
  groupLeft: (groupId: Uint8Array) => void;
};

export class MarmotClient<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> extends EventEmitter<MarmotClientEvents<THistory, TMedia>> {
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The capabilities to use for the client */
  readonly capabilities: Capabilities;
  /** The store for group state (bytes-only) */
  readonly groupStateStore: GroupStateStore;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;
  /** Manages key package lifecycle: local storage, publishing, and rotation */
  readonly keyPackages: KeyPackageManager;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  /** An array of all loaded groups */
  get groups() {
    return Array.from(this.#groups.values());
  }

  /** Group history interface to be passed to group instaces */
  private historyFactory: GroupHistoryFactory<THistory>;

  /** Group media interface to be passed to group instance */
  private mediaFactory: GroupMediaFactory<TMedia>;

  constructor(options: MarmotClientOptions<THistory, TMedia>) {
    super();
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.groupStateStore = new GroupStateStore(options.groupStateBackend);
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.keyPackages = new KeyPackageManager({
      keyPackageStore: options.keyPackageStore,
      signer: options.signer,
      network: options.network,
    });

    // Set the history factory if its set in the options
    this.historyFactory = (
      "historyFactory" in options ? options.historyFactory : undefined
    ) as GroupHistoryFactory<THistory>;

    // Set the media factory if its set in the options
    this.mediaFactory = (
      "mediaFactory" in options ? options.mediaFactory : undefined
    ) as GroupMediaFactory<TMedia>;
  }

  /** Get a ciphersuite implementation from a name */
  private async getCiphersuiteImpl(name?: CiphersuiteName) {
    // In v2, CryptoProvider.getCiphersuiteImpl takes a numeric ciphersuite id.
    // We accept a name and map it via the exported `ciphersuites` table.
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
  #groups = new Map<string, MarmotGroup<THistory, TMedia>>();

  /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
  #groupLoadPromises = new Map<
    string,
    Promise<MarmotGroup<THistory, TMedia>>
  >();

  /** Sets a group instance in the cache */
  private setGroupInstance(group: MarmotGroup<THistory, TMedia>) {
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

  /** Loads a new group from the store */
  private async loadGroup(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    log("loading group %s from store", bytesToHex(id));
    const stateBytes = await this.groupStateStore.get(id);

    if (!stateBytes) {
      throw new Error(`Group ${bytesToHex(id)} not found`);
    }

    const state = this.hydrateState(stateBytes);

    return await MarmotGroup.fromClientState<THistory, TMedia>(state, {
      stateStore: this.groupStateStore,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });
  }

  /** Gets a group from cache or loads it from store */
  async getGroup(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
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
  async loadAllGroups(): Promise<MarmotGroup<THistory, TMedia>[]> {
    const groupIds = await this.groupStateStore.list();

    return await Promise.all(groupIds.map((groupId) => this.getGroup(groupId)));
  }

  /** Imports a new group from a ClientState object */
  async importGroupFromClientState(
    state: ClientState,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = bytesToHex(state.groupContext.groupId);
    log("importing group %s from ClientState", id);
    if (await this.groupStateStore.has(state.groupContext.groupId)) {
      throw new Error(`Group ${id} already exists`);
    }

    // Serialize and store the state
    const stateBytes = this.serializeState(state);
    await this.groupStateStore.set(state.groupContext.groupId, stateBytes);

    // Create a new MarmotGroup instance from the ClientState
    const group = await MarmotGroup.fromClientState(state, {
      stateStore: this.groupStateStore,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
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
    log("destroying group %s", id);

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
  async leaveGroup(
    groupId: Uint8Array | string,
  ): Promise<Record<string, import("./nostr-interface.js").PublishResponse>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("leaving group %s", id);

    // Get the existing instance or load a new one.
    const group = this.#groups.get(id) || (await this.loadGroup(groupId));

    const groupIdBytes =
      typeof groupId === "string" ? hexToBytes(groupId) : groupId;

    // Publish the self-remove commit and destroy local state.
    const response = await group.leave();

    // Evict from the in-memory cache (destroy() already removed from store).
    this.#groups.delete(id);

    // Emit events.
    this.emit("groupLeft", groupIdBytes);
    this.emit("groupsUpdated", this.groups);

    return response;
  }

  /** Creates a new simple group */
  async createGroup(
    name: string,
    options?: SimpleGroupOptions & {
      ciphersuite?: CiphersuiteName;
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    log("creating group %o", name);
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
      {
        ...options,
        adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
      },
    );

    // Save the group to the store
    const stateBytes = this.serializeState(clientState);
    await this.groupStateStore.set(
      clientState.groupContext.groupId,
      stateBytes,
    );

    // Create and cache the MarmotGroup instance
    const group = new MarmotGroup(clientState, {
      ciphersuite: ciphersuiteImpl,
      stateStore: this.groupStateStore,
      signer: this.signer,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });

    // Save the group to the cache
    this.setGroupInstance(group);
    this.emit("groupCreated", group);
    log("created group %s", group.idStr);

    return group;
  }

  /**
   * Reads the {@link GroupInfo} from a Welcome rumor without joining the group.
   *
   * Finds the local key package that matches one of the welcome's recipient slots,
   * then decrypts the group info using that key package. Useful for previewing
   * group metadata (name, relays, admins) before deciding to join.
   *
   * @param welcomeRumor - The decrypted kind 444 welcome rumor
   * @returns The decrypted GroupInfo, or null if no matching key package is found or decryption fails
   */
  async readInviteGroupInfo(
    welcomeRumor: Rumor | Welcome,
  ): Promise<GroupInfo | null> {
    const welcome = isRumorLike(welcomeRumor)
      ? getWelcome(welcomeRumor)
      : welcomeRumor;
    const refs = getWelcomeKeyPackageRefs(welcome);

    for (const ref of refs) {
      const stored = await this.keyPackages.get(ref);
      if (!stored?.privatePackage) continue;

      try {
        const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
          stored.publicPackage.cipherSuite,
        );
        return await readWelcomeGroupInfo({
          welcome,
          keyPackage: stored,
          ciphersuiteImpl,
        });
      } catch {
        // Ignore error, try other key packages
      }
    }

    return null;
  }

  /**
   * Joins a group from a Welcome message received via NIP-59 gift wrap.
   *
   * This method:
   * 1. Decodes the Welcome message from the kind 444 event
   * 2. Finds the matching local KeyPackage private material from the store
   * 3. Calls ts-mls joinGroup() to create a new ClientState
   * 4. Persists the resulting ClientState
   * 5. Marks the consumed key package as used via `client.keyPackages.markUsed()`
   * 6. Returns a MarmotGroup instance
   *
   * After joining, callers can list used key packages with
   * `(await client.keyPackages.list()).filter(p => p.used)` and rotate them
   * via `client.keyPackages.rotate(ref)` to publish fresh ones to relays.
   *
   * @param options - Options for joining from a Welcome message
   * @param options.welcomeRumor - The unwrapped kind 444 rumor event containing the Welcome message
   * @returns Promise resolving to the joined group
   * @throws Error if no matching KeyPackage is found or if joining fails
   */
  async joinGroupFromWelcome(options: { welcomeRumor: Rumor }): Promise<{
    group: MarmotGroup<THistory, TMedia>;
  }> {
    const { welcomeRumor } = options;
    log("joining group from welcome rumor %s", welcomeRumor.id);

    // Decode the Welcome message from the kind 444 event
    const welcome = getWelcome(welcomeRumor);

    // Get the ciphersuite implementation for the Welcome
    // ts-mls v2: welcome.cipherSuite is a numeric CiphersuiteId
    const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
      welcome.cipherSuite,
    );

    // Find all local KeyPackage candidates with matching cipherSuite
    const allKeyPackages = await this.keyPackages.list();
    const candidatePackages: Array<{
      publicPackage: KeyPackage;
      privatePackage: PrivateKeyPackage;
      keyPackageRef: Uint8Array;
      hasMatchingSecret: boolean;
    }> = [];

    // Collect all key packages with matching cipher suite and compute their KeyPackageRef
    // KeyPackageRef is used to identify which encrypted secret in the welcome is ours (RFC 9420)
    for (const keyPackage of allKeyPackages) {
      // KeyPackage uses numeric ciphersuite ids; compare directly
      if (keyPackage.publicPackage.cipherSuite !== welcome.cipherSuite) {
        continue;
      }

      const privateKeyPackage = await this.keyPackages.getPrivateKey(
        keyPackage.keyPackageRef,
      );
      if (!privateKeyPackage) continue;

      // Check if this key package's ref matches any secret in the welcome
      // This is the RFC 9420 KeyPackageRef matching semantics
      const hasMatchingSecret = welcome.secrets.some((secret) =>
        secret.newMember.length === keyPackage.keyPackageRef.length
          ? secret.newMember.every(
              (val, idx) => val === keyPackage.keyPackageRef[idx],
            )
          : false,
      );

      candidatePackages.push({
        publicPackage: keyPackage.publicPackage,
        privatePackage: privateKeyPackage,
        keyPackageRef: keyPackage.keyPackageRef,
        hasMatchingSecret,
      });
    }

    if (candidatePackages.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    // Prioritize packages that have matching secrets in the welcome
    // This ensures we try the most likely candidates first (RFC 9420 compliance)
    const prioritizedKeyPackages = [
      ...candidatePackages.filter((p) => p.hasMatchingSecret),
      ...candidatePackages.filter((p) => !p.hasMatchingSecret),
    ];

    // Try each key package in priority order until one successfully decrypts the Welcome message
    let clientState: ClientState | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;

    for (const keyPackage of prioritizedKeyPackages) {
      try {
        // Attempt to join the group with this key package
        // In v2, joinGroup takes a single params object with context
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
        // If successful, break out of the loop
        break;
      } catch (error) {
        // Store the error and continue to the next candidate
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue trying with the next key package
      }
    }

    if (!clientState) {
      // All key packages failed, throw the last error encountered
      const errorMessage = lastError
        ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
        : "Failed to join group with any matching key package";
      throw new Error(errorMessage);
    }

    // Mark the consumed key package as used. Callers can later list used packages
    // with (await client.keyPackages.list()).filter(p => p.used) and rotate them
    // via client.keyPackages.rotate(ref) to publish fresh ones to relays.
    if (consumedKeyPackageRef) {
      await this.keyPackages.markUsed(consumedKeyPackageRef);
    }

    // Save the group state to the store
    const stateBytes = this.serializeState(clientState);
    await this.groupStateStore.set(
      clientState.groupContext.groupId,
      stateBytes,
    );

    // Create and cache the MarmotGroup instance
    const group = new MarmotGroup(clientState, {
      ciphersuite: ciphersuiteImpl,
      stateStore: this.groupStateStore,
      signer: this.signer,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });

    // Add the group to the cache
    this.setGroupInstance(group);
    this.emit("groupJoined", group);
    log("joined group %s", group.idStr);

    // MIP-02 SHOULD: callers are responsible for calling group.selfUpdate() after
    // joining to rotate leaf key material for forward secrecy. Doing it automatically
    // here caused the joining member to fork off to a new epoch before other members
    // could ingest the commit.

    return { group };
  }

  /**
   * Watches for changes to the groups in the store.
   * Returns an async generator that yields the current list of groups
   * whenever the store changes.
   *
   * @example
   * ```ts
   * for await (const groups of client.watchGroups()) {
   *   console.log(`Groups updated: ${groups.length} groups`);
   * }
   * ```
   */
  async *watchGroups(): AsyncGenerator<MarmotGroup<THistory, TMedia>[]> {
    // Set up event listeners
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
      // Yield initial state after listeners are installed to avoid missing updates
      // that occur between snapshot and subscription.
      yield await this.loadAllGroups();

      while (true) {
        // Wait for next change
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        // Yield updated groups
        yield await this.loadAllGroups();
      }
    } finally {
      // Cleanup
      this.groupStateStore.off("groupStateAdded", handleChange);
      this.groupStateStore.off("groupStateUpdated", handleChange);
      this.groupStateStore.off("groupStateRemoved", handleChange);
    }
  }
}
