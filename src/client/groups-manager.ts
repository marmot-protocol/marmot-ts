import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { hexToBytes } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteName,
  ciphersuites,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
} from "ts-mls";
import {
  deserializeClientState,
  SerializedClientState,
} from "../core/client-state.js";
import { createCredential } from "../core/credential.js";
import { createSimpleGroup, SimpleGroupOptions } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { logger } from "../utils/debug.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
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
};

/**
 * Manages the lifecycle of {@link MarmotGroup} instances — persistence,
 * in-memory caching, creation, loading, unloading, destroying, and leaving.
 */
export class GroupsManager<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> extends EventEmitter<GroupsManagerEvents<THistory, TMedia>> {
  /** The backend storing serialized group state bytes */
  readonly store: GenericKeyValueStore<SerializedClientState>;
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  /** Group history factory passed to group instances */
  private historyFactory: GroupHistoryFactory<THistory>;

  /** Group media factory passed to group instances */
  private mediaFactory: GroupMediaFactory<TMedia>;

  /** In-memory cache of loaded group instances, keyed by hex group id */
  #groups = new Map<string, MarmotGroup<THistory, TMedia>>();

  /** Per-group listener handles, so we can detach them when a group is unloaded. */
  #groupListeners = new Map<
    string,
    {
      destroyed: () => void;
    }
  >();

  /** Tracks in-flight group loads to prevent duplicate instances under concurrency */
  #groupLoadPromises = new Map<
    string,
    Promise<MarmotGroup<THistory, TMedia>>
  >();

  constructor(options: GroupsManagerOptions<THistory, TMedia>) {
    super();
    this.store = options.store;
    this.signer = options.signer;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.historyFactory =
      options.historyFactory as GroupHistoryFactory<THistory>;
    this.mediaFactory = options.mediaFactory as GroupMediaFactory<TMedia>;
  }

  /** Returns the list of currently loaded group instances */
  get loaded(): MarmotGroup<THistory, TMedia>[] {
    return Array.from(this.#groups.values());
  }

  /** Get a ciphersuite implementation from a name */
  async #getCiphersuiteImpl(name?: CiphersuiteName) {
    const ciphersuiteName =
      name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
    const id = ciphersuites[ciphersuiteName];
    return await this.cryptoProvider.getCiphersuiteImpl(id);
  }

  /** Hydrates a SerializedClientState into a ClientState */
  #hydrateState(serialized: SerializedClientState): ClientState {
    return deserializeClientState(serialized);
  }

  /** Reads the serialized state bytes for a group directly from the backend */
  async #getSerializedState(
    groupId: Uint8Array,
  ): Promise<SerializedClientState | null> {
    return this.store.getItem(bytesToHex(groupId));
  }

  /** Lists all persisted group IDs, decoded from their hex storage keys. */
  async listIds(): Promise<Uint8Array[]> {
    const keys = await this.store.keys();
    return keys.map((key) => hexToBytes(key));
  }

  /** Checks if a group exists in the backend */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    const item = await this.store.getItem(key);
    return item !== null;
  }

  /** Sets a group instance in the cache and subscribes to its state events */
  #setGroupInstance(group: MarmotGroup<THistory, TMedia>) {
    const id = bytesToHex(group.id);
    this.#groups.set(id, group);

    // If a group self-destroys, drop it from the cache so `loaded` stays accurate.
    const destroyed = () => this.#clearGroupInstance(id);
    group.on("destroyed", destroyed);
    this.#groupListeners.set(id, { destroyed });

    this.emit("updated", this.loaded);
  }

  #clearGroupInstance(groupId: Uint8Array | string) {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);

    const existing = this.#groups.get(id);
    if (!existing) return;

    const listeners = this.#groupListeners.get(id);
    if (listeners) {
      existing.off("destroyed", listeners.destroyed);
      this.#groupListeners.delete(id);
    }

    this.#groups.delete(id);
    this.emit("updated", this.loaded);
  }

  /** Loads a new group from the store */
  async #loadGroup(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    log("loading group %s from store", bytesToHex(id));
    const stateBytes = await this.#getSerializedState(id);

    if (!stateBytes) {
      throw new Error(`Group ${bytesToHex(id)} not found`);
    }

    const state = this.#hydrateState(stateBytes);

    return await MarmotGroup.fromClientState<THistory, TMedia>(state, {
      store: this.store,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });
  }

  /** Gets a group from cache or loads it from store */
  async get(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    let group = this.#groups.get(id);

    if (!group) {
      const existingLoad = this.#groupLoadPromises.get(id);
      if (existingLoad) {
        group = await existingLoad;
      } else {
        const loadPromise = this.#loadGroup(groupId)
          .then((loaded) => {
            this.#setGroupInstance(loaded);
            this.emit("loaded", loaded);
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
  async loadAll(): Promise<MarmotGroup<THistory, TMedia>[]> {
    const groupIds = await this.listIds();

    return await Promise.all(groupIds.map((groupId) => this.get(groupId)));
  }

  /**
   * Persists and caches a group built from a {@link ClientState}, emitting
   * the given lifecycle event. Used by higher-level flows (e.g. joining from
   * a welcome message) that construct ClientStates themselves.
   *
   * @param state - The ClientState to adopt
   * @param options.emit - Which lifecycle event to emit. Defaults to `"imported"`.
   * @returns The persisted and cached MarmotGroup
   * @throws Error if a group with the same id already exists
   */
  async adoptClientState(
    state: ClientState,
    options?: { emit?: "imported" | "joined" },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const eventName = options?.emit ?? "imported";
    const id = bytesToHex(state.groupContext.groupId);

    if (await this.has(state.groupContext.groupId)) {
      throw new Error(`Group ${id} already exists`);
    }

    const group = await MarmotGroup.fromClientState(state, {
      store: this.store,
      signer: this.signer,
      cryptoProvider: this.cryptoProvider,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });

    // Persist initial state via the group's own save() path.
    // MarmotGroup.save() is the single writer into the group state store.
    await group.save(true);

    this.#setGroupInstance(group);
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

  /** Unloads a group from the client but does not remove it from the store */
  async unload(groupId: Uint8Array | string): Promise<void> {
    const hex = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.#clearGroupInstance(hex);
    this.emit("unloaded", hex);
  }

  /** Destroys a group and purges the group history */
  async destroy(groupId: Uint8Array | string): Promise<void> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("destroying group %s", id);

    const group = this.#groups.get(id) || (await this.#loadGroup(groupId));

    // NOTE: MarmotGroup.destroy() is the single owner of removing group state
    // from storage. It emits `destroyed`, which our listener uses to clear the
    // in-memory cache and emit `updated`.
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

    const group = this.#groups.get(id) || (await this.#loadGroup(groupId));

    const groupIdBytes =
      typeof groupId === "string" ? hexToBytes(groupId) : groupId;

    // MarmotGroup.leave() purges local state via destroy(), which emits
    // `destroyed` — our listener clears the cache and emits `updated`.
    const response = await group.leave();

    this.emit("left", groupIdBytes);

    return response;
  }

  /** Creates a new simple group */
  async create(
    name: string,
    options?: SimpleGroupOptions & {
      ciphersuite?: CiphersuiteName;
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    log("creating group %o", name);
    const ciphersuiteImpl = await this.#getCiphersuiteImpl(
      options?.ciphersuite,
    );

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
      {
        ...options,
        adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
      },
    );

    const group = new MarmotGroup(clientState, {
      ciphersuite: ciphersuiteImpl,
      store: this.store,
      signer: this.signer,
      network: this.network,
      history: this.historyFactory,
      media: this.mediaFactory,
    });
    await group.save(true);

    this.#setGroupInstance(group);
    this.emit("created", group);
    log("created group %s", group.idStr);

    return group;
  }

  /**
   * Watches for changes to the groups in the store.
   * Returns an async generator that yields the current list of groups
   * whenever the store changes.
   *
   * @example
   * ```ts
   * for await (const groups of client.groups.watch()) {
   *   console.log(`Groups updated: ${groups.length} groups`);
   * }
   * ```
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
      yield await this.loadAll();

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        yield await this.loadAll();
      }
    } finally {
      this.off("updated", handleChange);
    }
  }
}
