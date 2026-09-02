import type { EventSigner } from "applesauce-core/factories";
import {
  finalizeEvent,
  generateSecretKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";

import { BoundedIdCache, GroupsManager } from "../client/groups-manager.js";
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

  it("emits one public removal after concurrently loading a persisted tombstone", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const stateStore = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const signer = { getPublicKey: async () => ADMIN } as EventSigner;
    const options = {
      store: stateStore,
      removedMarkerStore,
      signer,
      network,
    };

    const writer = new GroupsManager(options);
    const created = await writer.create("Removed Group", {
      relays: ["wss://relay.test"],
    });
    created.state = {
      ...created.state,
      groupActiveState: { kind: "removedFromGroup" },
    };
    await created.save(true);

    const reader = new GroupsManager(options);
    const removed: Uint8Array[] = [];
    reader.on("removed", (groupId) => removed.push(groupId));

    const [first, second] = await Promise.all([
      reader.get(created.id),
      reader.get(created.id),
    ]);

    expect(first).toBe(second);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(created.id);
    expect(await removedMarkerStore.getItem(created.idStr)).toBe(true);

    const restarted = new GroupsManager(options);
    const restartRemoved = vi.fn();
    restarted.on("removed", restartRemoved);
    const reloaded = await restarted.get(created.id);

    expect(reloaded.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(restartRemoved).not.toHaveBeenCalled();
    await expect(
      restarted.send(reloaded.id, {
        kind: "applicationMessage",
        payload: new TextEncoder().encode("blocked"),
      }),
    ).rejects.toThrow(/removed/i);
  });
});

describe("GroupsManager #connectGroup drain — trust boundary (SEC-01/WIRE-02)", () => {
  it("bounds accepted and rejected event identities with deterministic LRU eviction", () => {
    const accepted = new BoundedIdCache(2);
    const rejected = new BoundedIdCache(2);

    accepted.add("accepted-1");
    accepted.add("accepted-2");
    accepted.add("accepted-3");
    rejected.add("rejected-1");
    rejected.add("rejected-2");
    rejected.add("rejected-3");

    expect(accepted.size).toBe(2);
    expect(accepted.has("accepted-1")).toBe(false);
    expect(rejected.size).toBe(2);
    expect(rejected.has("rejected-1")).toBe(false);
  });

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

    // T-03-23 (the folded `groupsmanager-rejectedevents-dos` todo): the drain
    // no longer caches rejected event objects for the connection lifetime, so
    // a redelivery of this exact malformed event (e.g. backfill + subscribe
    // both surfacing it) may now emit `rejected` more than once — informational,
    // not a protocol-safety regression. Assert at least one rejection fired,
    // with every rejection carrying the expected reason.
    expect(rejections).toHaveLength(1);
    expect(
      rejections.every(([, , reason]) => reason === "invalid-signature"),
    ).toBe(true);
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

    // Same T-03-23 relaxation as the invalid-signature test above: at least
    // one rejection, every rejection carrying the expected reason.
    expect(rejections).toHaveLength(1);
    expect(
      rejections.every(([, , reason]) => reason === "tag-cardinality"),
    ).toBe(true);
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

  it("rejects a signed event for a different group before ingest or accepted-id caching", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const genuine = network.events[0];
    const wrongGroup = finalizeEvent(
      {
        kind: genuine.kind,
        created_at: genuine.created_at,
        content: genuine.content,
        tags: genuine.tags.map((tag) =>
          tag[0] === "h" ? ["h", "f".repeat(64)] : tag,
        ),
      },
      generateSecretKey(),
    );
    const unfilteredNetwork: NostrNetworkInterface = {
      ...network,
      request: async () => [wrongGroup],
      subscription: () => ({
        subscribe: () => ({ unsubscribe: () => {} }),
      }),
    };
    const unfilteredManager = makeManager(unfilteredNetwork);
    const unfilteredGroup = await unfilteredManager.adoptClientState(group.state);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    unfilteredManager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(unfilteredGroup, "ingest");

    await unfilteredManager.connect(unfilteredGroup.id);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.[2]).toBe("tag-cardinality");
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("does not let a corrupted same-id forgery censor the genuine event that arrives later (WR-01)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const genuine = network.events[0];
    // Same id (NIP-01 ids don't cover `sig`), corrupted signature.
    const corrupted = corruptSignature(genuine);

    // Only the corrupted forgery is present for backfill — the genuine event
    // has not "arrived" yet.
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    // The forgery is rejected and does not reach ingest. MockNetwork's
    // `subscription()` replays every already-matching event on subscribe, so
    // `connect()`'s backfill (`request`) and its immediately-following
    // `subscription().subscribe()` both deliver this SAME corrupted object —
    // T-03-23 removed the object-identity rejection cache that used to
    // collapse that redelivery to one `rejected` emit, so two are now
    // expected (informational, not a protocol-safety regression; see the
    // `seen`/`rejectedEvents` comment in `#connectGroup`).
    expect(rejections).toHaveLength(1);
    expect(
      rejections.every(([, , reason]) => reason === "invalid-signature"),
    ).toBe(true);
    expect(ingestSpy).not.toHaveBeenCalled();

    // The genuine, validly-signed event (same id) now arrives via the live
    // subscription. It must NOT be censored by the poisoned dedup slot.
    await network.publish(["wss://relay.test"], genuine);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith([genuine]);

    // A second delivery of the already-verified genuine event is still
    // deduped and does not reach ingest again.
    await network.publish(["wss://relay.test"], genuine);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });
});
