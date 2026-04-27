import { describe, expect, it } from "vitest";

import { GroupsManager } from "../client/groups-manager.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import type { SerializedClientState } from "../core/client-state.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";

class EmptyGroupStateStore implements GenericKeyValueStore<SerializedClientState> {
  async getItem(): Promise<SerializedClientState | null> {
    return null;
  }

  async setItem(
    _key: string,
    value: SerializedClientState,
  ): Promise<SerializedClientState> {
    return value;
  }

  async removeItem(): Promise<void> {}

  async clear(): Promise<void> {}

  async keys(): Promise<string[]> {
    return [];
  }
}

describe("GroupsManager", () => {
  it("watch emits a new array instance for every update", async () => {
    const manager = new GroupsManager({
      store: new EmptyGroupStateStore(),
      signer: {} as never,
      network: {} as NostrNetworkInterface,
    });

    const watcher = manager.watch();

    const first = await watcher.next();
    const secondPromise = watcher.next();
    await Promise.resolve();

    manager.emit("updated", []);
    const second = await secondPromise;

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(second.value).not.toBe(first.value);

    await watcher.return(undefined);
  });
});
