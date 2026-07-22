import type { EventSigner } from "applesauce-core/factories";
import {
  finalizeEvent,
  generateSecretKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";

import { GroupsManager } from "../client/groups-manager.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import { fakeVerifyEvent } from "../client/verify.js";
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

describe("GroupsManager #connectGroup drain — trust boundary (SEC-01/WIRE-02)", () => {
  /**
   * `finalizeEvent` caches a `true` result under `verifiedSymbol` on the
   * event it just signed; a plain object spread copies that own enumerable
   * symbol property too, so a naive `{ ...real, sig: "bad" }` would silently
   * short-circuit `defaultVerifyEvent` back to `true`. Strip the cache so the
   * corrupted event is actually re-verified from scratch.
   */
  function corruptSignature(event: NostrEvent): NostrEvent {
    const corrupted: NostrEvent = { ...event, sig: "0".repeat(128) };
    delete (corrupted as Record<PropertyKey, unknown>)[verifiedSymbol];
    return corrupted;
  }

  function makeManager(
    network: NostrNetworkInterface,
    verifyEvent?: (event: NostrEvent) => boolean,
  ) {
    const signer = { getPublicKey: async () => ADMIN } as EventSigner;
    return new GroupsManager({
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer,
      network,
      verifyEvent: verifyEvent as any,
    });
  }

  it("rejects an inbound 445 event with an invalid signature before ingest", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];
    const corrupted = corruptSignature(real);
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    expect(rejections).toHaveLength(1);
    expect(rejections[0][2]).toBe("invalid-signature");
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("rejects a properly-signed 445 event carrying a duplicate h tag before ingest", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];

    // Re-sign a modified draft carrying a second `h` tag — a genuinely valid
    // signature (matches how 445 events are actually signed, MIP-03 ephemeral
    // keys), but the routing tag itself violates #236 singleton cardinality.
    const draft = {
      kind: real.kind,
      created_at: real.created_at,
      content: real.content,
      tags: [...real.tags, ["h", "duplicate-h-value"]],
    };
    const badEvent = finalizeEvent(draft, generateSecretKey());
    network.clear();
    network.events.push(badEvent);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    expect(rejections).toHaveLength(1);
    expect(rejections[0][2]).toBe("tag-cardinality");
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("delegates verification to an injected fakeVerifyEvent (trust-upstream)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network, fakeVerifyEvent);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];
    const corrupted = corruptSignature(real);
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );

    await manager.connect(group.id);

    // With signature verification delegated away (fakeVerifyEvent), the
    // invalid-signature rejection must never fire for this event.
    expect(
      rejections.some(([, , reason]) => reason === "invalid-signature"),
    ).toBe(false);
  });
});
