import type { EventSigner } from "applesauce-core/event-factory";
import { describe, expect, it } from "vitest";

import { GroupsManager } from "../client/groups-manager.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import type { SerializedClientState } from "../core/client-state.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { MockNetwork } from "./helpers/mock-network.js";

const ADMIN = "a".repeat(64);

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

describe("GroupsManager session/runtime helpers", () => {
  function makeManager(network: NostrNetworkInterface) {
    const signer = { getPublicKey: async () => ADMIN } as EventSigner;
    return new GroupsManager({
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer,
      network,
    });
  }

  it("exposes the same session and runtime as the cached group", async () => {
    const manager = makeManager(new MockNetwork(["wss://relay.test"]));
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    expect(await manager.session(group.id)).toBe(group.session);
    expect(await manager.runtime(group.id)).toBe(group.runtime);
  });

  it("drives a send intent through session and runtime to the network", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    const payload = new TextEncoder().encode("hello");
    const results = await manager.send(group.id, {
      kind: "applicationMessage",
      payload,
    });

    expect(results).toHaveLength(1);
    expect(results[0].work.kind).toBe("applicationMessage");
    // The application message envelope reached the mock relay.
    expect(network.events).toHaveLength(1);
    expect(network.events[0].kind).toBe(445);
  });

  it("commits through the manager and advances the group epoch", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    const epochBefore = group.state.groupContext.epoch;
    const response = await manager.commit(group.id, { extraProposals: [] });

    expect(Object.values(response).every((r) => r.ok)).toBe(true);
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(epochBefore + 1n);
  });

  it("ingests transport events through the group session (self-echo)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("echo"),
    });
    const envelope = network.events[0];

    const results = [];
    for await (const result of manager.ingest(group.id, [envelope]))
      results.push(result);

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    if (results[0].kind !== "skipped") throw new Error("expected skipped");
    expect(results[0].reason).toBe("self-echo");
  });
});
