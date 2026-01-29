import { bytesToHex } from "@noble/hashes/utils.js";
import { EventEmitter } from "eventemitter3";
import { ClientConfig } from "ts-mls/clientConfig.js";
import { ClientState } from "ts-mls/clientState.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../core/client-state.js";
import { KeyValueStoreBackend } from "../utils/key-value.js";

/** A generic interface for a client state store backend */
export interface GroupStoreBackend extends KeyValueStoreBackend<SerializedClientState> {}

/** Options for creating a {@link GroupStore} instance */
export type GroupStoreOptions = {
  prefix?: string;
};

type GroupStoreEvents = {
  /** Emitted when a client state is added */
  clientStateAdded: (clientState: ClientState) => any;
  /** Emitted when a client state is updated */
  clientStateUpdated: (clientState: ClientState) => any;
  /** Emitted when a client state is removed */
  clientStateRemoved: (groupId: Uint8Array) => any;
};

/**
 * Stores {@link ClientState} objects in a {@link GroupStoreBackend}.
 *
 * This class manages the persistence of MLS groups, storing the serialized
 * ClientState internally but always returning deserialized ClientState objects.
 * The ClientConfig is stored in the instance and used for all deserialization.
 */
export class GroupStore extends EventEmitter<GroupStoreEvents> {
  private backend: GroupStoreBackend;
  private readonly prefix?: string;
  private readonly config: ClientConfig;

  /**
   * Creates a new GroupStore instance.
   * @param backend - The storage backend to use (e.g., localForage)
   * @param config - The ClientConfig to use for deserialization
   * @param options - Optional configuration (prefix for namespacing)
   */
  constructor(
    backend: GroupStoreBackend,
    config: ClientConfig,
    { prefix }: GroupStoreOptions = {},
  ) {
    super();
    this.backend = backend;
    this.config = config;
    this.prefix = prefix;
  }

  /**
   * Resolves the storage key from a group ID.
   * @param groupId - The group ID (as Uint8Array or hex string)
   */
  private resolveStorageKey(groupId: Uint8Array | string): string {
    const key = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    return (this.prefix ?? "") + key;
  }

  /**
   * Adds a ClientState to the store.
   *
   * @param clientState - The ClientState to store
   * @returns A promise that resolves to the storage key used
   */
  async add(clientState: ClientState): Promise<string> {
    const key = this.resolveStorageKey(clientState.groupContext.groupId);
    const storedClientState = serializeClientState(clientState);

    await this.backend.setItem(key, storedClientState);
    this.emit("clientStateAdded", clientState);

    return key;
  }

  /**
   * Updates an existing ClientState in the store.
   *
   * This is effectively an upsert: if a group with the same ID already
   * exists, it will be overwritten; otherwise, it will be created.
   *
   * @param clientState - The updated ClientState to store
   * @returns A promise that resolves to the storage key used
   */
  async update(clientState: ClientState): Promise<string> {
    const key = this.resolveStorageKey(clientState.groupContext.groupId);
    const storedClientState = serializeClientState(clientState);

    await this.backend.setItem(key, storedClientState);
    this.emit("clientStateAdded", clientState);

    return key;
  }

  /**
   * Retrieves the ClientState from storage.
   *
   * @param groupId - The group ID (as Uint8Array or hex string)
   * @returns A promise that resolves to the ClientState, or null if not found
   */
  async get(groupId: Uint8Array | string): Promise<ClientState | null> {
    const key = this.resolveStorageKey(groupId);
    const entry = await this.backend.getItem(key);

    if (!entry) return null;

    return deserializeClientState(entry, this.config);
  }

  /**
   * Removes a group from the store.
   * @param groupId - The group ID (as Uint8Array or hex string)
   */
  async remove(groupId: Uint8Array | string): Promise<void> {
    const key = this.resolveStorageKey(groupId);
    const clientState = await this.get(groupId);
    await this.backend.removeItem(key);

    if (clientState) {
      this.emit("clientStateRemoved", clientState.groupContext.groupId);
    }
  }

  /**
   * Lists all stored ClientState objects.
   * @returns An array of ClientState objects
   */
  async list(): Promise<ClientState[]> {
    const allKeys = await this.backend.keys();

    const keys = this.prefix
      ? allKeys.filter((key) => key.startsWith(this.prefix!))
      : allKeys;

    const entries = await Promise.all(
      keys.map((key) => this.backend.getItem(key)),
    );

    const serializedEntries = entries.filter(
      (entry): entry is SerializedClientState => entry !== null,
    );

    return serializedEntries.map((entry) =>
      deserializeClientState(entry, this.config),
    );
  }

  /** Gets the count of groups stored. */
  async count(): Promise<number> {
    const groups = await this.list();
    return groups.length;
  }

  /** Clears all groups from the store (only those matching the prefix if one is set). */
  async clear(): Promise<void> {
    const groups = await this.list();

    if (this.prefix) {
      // Only clear keys with this prefix
      const allKeys = await this.backend.keys();
      const keysToRemove = allKeys.filter((key) =>
        key.startsWith(this.prefix!),
      );
      await Promise.all(
        keysToRemove.map((key) => this.backend.removeItem(key)),
      );
    } else {
      // Clear all keys
      await this.backend.clear();
    }

    for (const clientState of groups) {
      this.emit("clientStateRemoved", clientState.groupContext.groupId);
    }
  }

  /**
   * Checks if a group exists in the store.
   * @param groupId - The group ID (as Uint8Array or hex string)
   */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    const key = this.resolveStorageKey(groupId);
    const item = await this.backend.getItem(key);
    return item !== null;
  }
}
