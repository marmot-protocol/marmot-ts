import { EventEmitter } from "eventemitter3";
import { SerializedClientState } from "../core/client-state.js";

/** A generic interface for a bytes-only group state store backend */
export interface GroupStateStoreBackend {
  /** Get state bytes from the store by group ID */
  get(groupId: Uint8Array): Promise<SerializedClientState | null>;
  /** Set state bytes in the store by group ID */
  set(groupId: Uint8Array, stateBytes: SerializedClientState): Promise<void>;
  /** Remove state bytes from the store by group ID */
  remove(groupId: Uint8Array): Promise<void>;
  /** List all group IDs in the store */
  list(): Promise<Uint8Array[]>;
}

/** Events emitted by the GroupStateStore */
type GroupStateStoreEvents = {
  /** Emitted when a group state is added */
  groupStateAdded: (
    groupId: Uint8Array,
    stateBytes: SerializedClientState,
  ) => void;
  /** Emitted when a group state is updated */
  groupStateUpdated: (
    groupId: Uint8Array,
    stateBytes: SerializedClientState,
  ) => void;
  /** Emitted when a group state is removed */
  groupStateRemoved: (groupId: Uint8Array) => void;
};

/**
 * A bytes-only store for MLS group state.
 *
 * This class manages the persistence of MLS group state as raw bytes.
 * It does NOT handle serialization/deserialization - that is the responsibility
 * of the MarmotClient which owns the ClientConfig needed for hydration.
 *
 * This design ensures:
 * 1. Storage layer has no dependency on ClientConfig (policy concern)
 * 2. Storage is backend-neutral and portable
 * 3. Namespacing is handled by the backend instance, not the store
 */
export class GroupStateStore extends EventEmitter<GroupStateStoreEvents> {
  constructor(private backend: GroupStateStoreBackend) {
    super();
  }

  /**
   * Retrieves the serialized state bytes from storage.
   *
   * @param groupId - The group ID
   * @returns A promise that resolves to the serialized state bytes, or null if not found
   */
  async get(groupId: Uint8Array): Promise<SerializedClientState | null> {
    return this.backend.get(groupId);
  }

  /**
   * Stores serialized state bytes.
   *
   * This is effectively an upsert: if a group with the same ID already
   * exists, it will be overwritten; otherwise, it will be created.
   *
   * @param groupId - The group ID
   * @param stateBytes - The serialized state bytes to store
   */
  async set(
    groupId: Uint8Array,
    stateBytes: SerializedClientState,
  ): Promise<void> {
    const exists = await this.backend.get(groupId);
    await this.backend.set(groupId, stateBytes);

    if (exists) {
      this.emit("groupStateUpdated", groupId, stateBytes);
    } else {
      this.emit("groupStateAdded", groupId, stateBytes);
    }
  }

  /**
   * Removes a group from the store.
   * @param groupId - The group ID
   */
  async remove(groupId: Uint8Array): Promise<void> {
    await this.backend.remove(groupId);
    this.emit("groupStateRemoved", groupId);
  }

  /**
   * Lists all stored group IDs.
   * @returns An array of group IDs
   */
  async list(): Promise<Uint8Array[]> {
    return this.backend.list();
  }

  /**
   * Checks if a group exists in the store.
   * @param groupId - The group ID
   */
  async has(groupId: Uint8Array): Promise<boolean> {
    const item = await this.backend.get(groupId);
    return item !== null;
  }
}
