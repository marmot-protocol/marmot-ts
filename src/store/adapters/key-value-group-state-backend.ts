import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { SerializedClientState } from "../../core/client-state.js";
import { KeyValueStoreBackend } from "../../utils/key-value.js";
import { GroupStateStoreBackend } from "../group-state-store.js";

/**
 * Adapter to convert a KeyValueStoreBackend<string, SerializedClientState> to GroupStateStoreBackend.
 * This is useful for migrating existing backends that use string keys.
 */
export class KeyValueGroupStateBackend implements GroupStateStoreBackend {
  constructor(private backend: KeyValueStoreBackend<SerializedClientState>) {}

  async get(groupId: Uint8Array): Promise<SerializedClientState | null> {
    const key = bytesToHex(groupId);
    return this.backend.getItem(key);
  }

  async set(
    groupId: Uint8Array,
    stateBytes: SerializedClientState,
  ): Promise<void> {
    const key = bytesToHex(groupId);
    await this.backend.setItem(key, stateBytes);
  }

  async remove(groupId: Uint8Array): Promise<void> {
    const key = bytesToHex(groupId);
    await this.backend.removeItem(key);
  }

  async list(): Promise<Uint8Array[]> {
    const keys = await this.backend.keys();
    return keys.map((key) => hexToBytes(key));
  }
}
