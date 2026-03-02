import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KeyPackageManager } from "../client/key-package-manager.js";
import { getKeyPackageRelays } from "../core/key-package-event.js";
import { KEY_PACKAGE_KIND } from "../core/protocol.js";
import {
  KeyPackageStore,
  StoredKeyPackage,
} from "../store/key-package-store.js";
import type { KeyValueStoreBackend } from "../utils/key-value.js";
import { MockNetwork } from "./helpers/mock-network.js";

// ---------------------------------------------------------------------------
// Minimal in-memory backend
// ---------------------------------------------------------------------------

class MemoryBackend<T> implements KeyValueStoreBackend<T> {
  private map = new Map<string, T>();

  async getItem(key: string): Promise<T | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: T): Promise<T> {
    this.map.set(key, value);
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeManager(network: MockNetwork, account: PrivateKeyAccount<any>) {
  const store = new KeyPackageStore(new MemoryBackend());
  const manager = new KeyPackageManager({
    keyPackageStore: store,
    signer: account.signer,
    network,
  });
  return { manager, store };
}

/** Returns the published NostrEvent[] for a ref, or [] if none */
async function getPublished(
  manager: KeyPackageManager,
  ref: Uint8Array | string,
) {
  return (await manager.get(ref))?.published ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeyPackageManager", () => {
  let account: PrivateKeyAccount<any>;
  let network: MockNetwork;

  beforeEach(() => {
    account = PrivateKeyAccount.generateNew();
    network = new MockNetwork(["wss://relay.test"]);
  });

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe("create()", () => {
    it("throws if no relays are provided", async () => {
      const { manager } = makeManager(network, account);
      await expect(manager.create({ relays: [] })).rejects.toThrow(
        "At least one relay URL is required",
      );
    });

    it("stores private key material locally", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      expect(await manager.count()).toBe(1);
      expect(await manager.has(pkg.keyPackageRef)).toBe(true);
    });

    it("publishes a kind 443 event to the network", async () => {
      const { manager } = makeManager(network, account);
      await manager.create({ relays: ["wss://relay.test"] });

      const published = network.events.filter(
        (e) => e.kind === KEY_PACKAGE_KIND,
      );
      expect(published).toHaveLength(1);
    });

    it("records the published event on the stored entry", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);

      const networkEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      );
      expect(events[0].id).toBe(networkEvent?.id);
    });

    it("records relay URLs on the published event", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(getKeyPackageRelays(events[0])).toEqual(["wss://relay.test/"]);
    });

    it("emits keyPackageAdded and keyPackagePublished events", async () => {
      const { manager } = makeManager(network, account);

      const added = vi.fn();
      const published = vi.fn();
      manager.on("keyPackageAdded", added);
      manager.on("keyPackagePublished", published);

      await manager.create({ relays: ["wss://relay.test"] });

      expect(added).toHaveBeenCalledOnce();
      expect(published).toHaveBeenCalledOnce();
    });

    it("accumulates multiple published events for the same ref via track()", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      // Simulate the same key package being observed again on another relay
      const originalEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;
      await manager.track({ ...originalEvent, id: "b".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // rotate()
  // -------------------------------------------------------------------------

  describe("rotate()", () => {
    it("throws if the key package ref is not found in local private store", async () => {
      const { manager } = makeManager(network, account);
      const fakeRef = new Uint8Array(32).fill(0xab);
      await expect(manager.rotate(fakeRef)).rejects.toThrow(
        "Key package not found",
      );
    });

    it("throws if no relays can be determined for the new key package", async () => {
      const { manager, store } = makeManager(network, account);

      // Add a key package to the private store without any published events
      const { generateKeyPackage } = await import("../core/key-package.js");
      const { createCredential } = await import("../core/credential.js");
      const { defaultCryptoProvider, getCiphersuiteImpl } =
        await import("ts-mls");
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
      });
      await store.add(kp);

      const listed = await manager.list();
      await expect(
        manager.rotate(listed[0].keyPackageRef, { relays: undefined }),
      ).rejects.toThrow("no relay URLs available");
    });

    it("publishes a kind 5 deletion covering all known event IDs", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      // Simulate the same key package being observed a second time
      const originalEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;
      await manager.track({ ...originalEvent, id: "b".repeat(64) });

      await manager.rotate(pkg.keyPackageRef);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);

      const eTags = deleteEvents[0].tags.filter((t) => t[0] === "e");
      expect(eTags).toHaveLength(2);
    });

    it("creates and publishes a new kind 443 event", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.rotate(pkg.keyPackageRef);

      const keyPackageEvents = network.events.filter(
        (e) => e.kind === KEY_PACKAGE_KIND,
      );
      // One from create(), one from rotate()
      expect(keyPackageEvents).toHaveLength(2);
    });

    it("removes the old private key material after rotation", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      expect(await manager.count()).toBe(1);
      await manager.rotate(pkg.keyPackageRef);

      expect(await manager.count()).toBe(1);
      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
    });

    it("removes the old published events after rotation", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.rotate(pkg.keyPackageRef);

      const remaining = await getPublished(manager, pkg.keyPackageRef);
      expect(remaining).toHaveLength(0);
    });

    it("reuses relays from the old key package if no relays option is passed", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({
        relays: ["wss://specific-relay.test"],
      });

      const newPkg = await manager.rotate(pkg.keyPackageRef);

      const events = await getPublished(manager, newPkg.keyPackageRef);
      expect(getKeyPackageRelays(events[0])).toContain(
        "wss://specific-relay.test/",
      );
    });

    it("skips relay deletion if the old key package was never published", async () => {
      const { manager, store } = makeManager(network, account);

      // Add an unpublished key package directly to the private store
      const { generateKeyPackage } = await import("../core/key-package.js");
      const { createCredential } = await import("../core/credential.js");
      const { defaultCryptoProvider, getCiphersuiteImpl } =
        await import("ts-mls");
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
      });
      await store.add(kp);

      const listed = await manager.list();
      await manager.rotate(listed[0].keyPackageRef, {
        relays: ["wss://relay.test"],
      });

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(0);
    });

    it("returns a new key package with a different ref", async () => {
      const { manager } = makeManager(network, account);
      const old = await manager.create({ relays: ["wss://relay.test"] });
      const newPkg = await manager.rotate(old.keyPackageRef);

      expect(newPkg.keyPackageRef).toBeDefined();
      expect(
        Buffer.from(newPkg.keyPackageRef).equals(
          Buffer.from(old.keyPackageRef),
        ),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // remove()
  // -------------------------------------------------------------------------

  describe("remove()", () => {
    it("removes the key package from local private storage", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.remove(pkg.keyPackageRef);

      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
      expect(await manager.count()).toBe(0);
    });

    it("does not publish anything to the network", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const countBefore = network.events.length;

      await manager.remove(pkg.keyPackageRef);

      expect(network.events.length).toBe(countBefore);
    });

    it("emits keyPackageRemoved", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const removed = vi.fn();
      manager.on("keyPackageRemoved", removed);
      await manager.remove(pkg.keyPackageRef);

      expect(removed).toHaveBeenCalledOnce();
    });

    it("removes the entry including its published events", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.remove(pkg.keyPackageRef);

      // Entry is gone — no published events retrievable
      expect(await getPublished(manager, pkg.keyPackageRef)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // purge()
  // -------------------------------------------------------------------------

  describe("purge()", () => {
    it("publishes a kind 5 deletion for a single ref", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.purge(pkg.keyPackageRef);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);
    });

    it("the deletion event references all known event IDs for the ref", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      // Simulate a second observation of the same key package event
      const originalEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;
      await manager.track({ ...originalEvent, id: "b".repeat(64) });

      await manager.purge(pkg.keyPackageRef);

      const deleteEvent = network.events.find((e) => e.kind === 5)!;
      const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
      expect(eTags).toHaveLength(2);
    });

    it("removes local private key material", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.purge(pkg.keyPackageRef);

      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
    });

    it("accepts an array of refs and publishes a single deletion covering all", async () => {
      const { manager } = makeManager(network, account);
      const pkg1 = await manager.create({ relays: ["wss://relay.test"] });
      const pkg2 = await manager.create({ relays: ["wss://relay2.test"] });

      await manager.purge([pkg1.keyPackageRef, pkg2.keyPackageRef]);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      // One deletion event covering both key packages
      expect(deleteEvents).toHaveLength(1);
      const eTags = deleteEvents[0].tags.filter((t) => t[0] === "e");
      expect(eTags).toHaveLength(2);
    });

    it("removes private keys for all refs in a bulk purge", async () => {
      const { manager } = makeManager(network, account);
      const pkg1 = await manager.create({ relays: ["wss://relay.test"] });
      const pkg2 = await manager.create({ relays: ["wss://relay2.test"] });

      await manager.purge([pkg1.keyPackageRef, pkg2.keyPackageRef]);

      expect(await manager.has(pkg1.keyPackageRef)).toBe(false);
      expect(await manager.has(pkg2.keyPackageRef)).toBe(false);
    });

    it("silently skips relay deletion for refs with no published events but still removes private key", async () => {
      const { manager, store } = makeManager(network, account);

      // Add an unpublished key package directly to the private store
      const { generateKeyPackage } = await import("../core/key-package.js");
      const { createCredential } = await import("../core/credential.js");
      const { defaultCryptoProvider, getCiphersuiteImpl } =
        await import("ts-mls");
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
      });
      await store.add(kp);
      const listed = await manager.list();
      const unpublishedRef = listed[0].keyPackageRef;

      const eventCountBefore = network.events.length;
      await manager.purge(unpublishedRef);

      expect(network.events.length).toBe(eventCountBefore);
      expect(await manager.has(unpublishedRef)).toBe(false);
    });

    it("accepts a hex string ref", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const refHex = Buffer.from(pkg.keyPackageRef).toString("hex");

      await manager.purge(refHex);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);
      expect(await manager.has(refHex)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // track()
  // -------------------------------------------------------------------------

  describe("track()", () => {
    it("returns false and ignores non-kind-443 events", async () => {
      const { manager } = makeManager(network, account);
      const result = await manager.track({
        id: "aa",
        kind: 1,
        pubkey: "bb",
        created_at: 0,
        content: "",
        tags: [],
        sig: "cc",
      });
      expect(result).toBe(false);
      expect(await manager.list()).toHaveLength(0);
    });

    it("returns false if the kind 443 event has no `i` tag", async () => {
      const { manager } = makeManager(network, account);
      const result = await manager.track({
        id: "aa",
        kind: KEY_PACKAGE_KIND,
        pubkey: "bb",
        created_at: 0,
        content: "",
        tags: [],
        sig: "cc",
      });
      expect(result).toBe(false);
      expect(await manager.list()).toHaveLength(0);
    });

    it("returns false if the event body cannot be decoded as a KeyPackage", async () => {
      const { manager } = makeManager(network, account);
      // Has a valid `i` tag but invalid (empty) content
      const result = await manager.track({
        id: "b".repeat(64),
        kind: KEY_PACKAGE_KIND,
        pubkey: "c".repeat(64),
        created_at: 1000,
        content: "",
        tags: [["i", "a".repeat(64)]],
        sig: "d".repeat(128),
      });
      expect(result).toBe(false);
    });

    it("returns true and records a real published event", async () => {
      const { manager } = makeManager(network, account);
      // Use create() to produce a real kind-443 event, then track it again
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      // Reset and track the same event as if observed on a relay
      const result = await manager.track({ ...realEvent, id: "e".repeat(64) });

      expect(result).toBe(true);
      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(2);
    });

    it("records relay URLs from the event's relays tag", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({
        relays: ["wss://relay1.test", "wss://relay2.test"],
      });
      const realEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      await manager.track({ ...realEvent, id: "e".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      // relay URLs are normalised (trailing slash added) by getKeyPackageRelays
      expect(getKeyPackageRelays(events[1])).toEqual([
        "wss://relay1.test/",
        "wss://relay2.test/",
      ]);
    });

    it("records a valid key package event from another device (no local private key)", async () => {
      const { manager } = makeManager(network, account);

      // Create a key package on a separate store to get a real event
      const otherNetwork = new MockNetwork(["wss://relay.test"]);
      const otherAccount = PrivateKeyAccount.generateNew();
      const { manager: otherManager } = makeManager(otherNetwork, otherAccount);
      await otherManager.create({ relays: ["wss://relay.test"] });

      const foreignEvent = otherNetwork.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      const result = await manager.track(foreignEvent);

      expect(result).toBe(true);
      // Not in local private store
      expect(
        await manager.has(foreignEvent.tags.find((t) => t[0] === "i")![1]),
      ).toBe(false);
      // But tracked in the store
      const refHex = foreignEvent.tags.find((t) => t[0] === "i")![1];
      const stored = await manager.get(refHex);
      expect(stored?.published).toHaveLength(1);
    });

    it("emits keyPackagePublished when a valid event is tracked", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      const publishedHandler = vi.fn();
      manager.on("keyPackagePublished", publishedHandler);

      const newId = "b".repeat(64);
      await manager.track({ ...realEvent, id: newId });

      expect(publishedHandler).toHaveBeenCalledOnce();
      expect(publishedHandler).toHaveBeenCalledWith(
        Buffer.from(pkg.keyPackageRef).toString("hex"),
        newId,
        expect.any(Array),
      );
    });

    it("accumulates multiple events for the same ref", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      await manager.track({ ...realEvent, id: "b".repeat(64) });
      await manager.track({ ...realEvent, id: "e".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      // 1 from create() + 2 from track()
      expect(events).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // markUsed()
  // -------------------------------------------------------------------------

  describe("markUsed()", () => {
    it("sets used=true on the stored key package", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.markUsed(pkg.keyPackageRef);

      const stored = await manager.get(pkg.keyPackageRef);
      expect(stored?.used).toBe(true);
    });

    it("used flag is visible in list()", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      await manager.create({ relays: ["wss://relay.test"] });

      await manager.markUsed(pkg.keyPackageRef);

      const all = await manager.list();
      expect(all.filter((p) => p.used)).toHaveLength(1);
      expect(all.filter((p) => !p.used)).toHaveLength(1);
    });

    it("emits keyPackageUpdated", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const updated: StoredKeyPackage[] = [];
      manager.on("keyPackageUpdated", (kp) => updated.push(kp));

      await manager.markUsed(pkg.keyPackageRef);

      expect(updated).toHaveLength(1);
      expect(updated[0].used).toBe(true);
    });

    it("does nothing when the ref does not exist", async () => {
      const { manager } = makeManager(network, account);
      // Should not throw for unknown ref
      await expect(manager.markUsed("a".repeat(64))).resolves.toBeUndefined();
    });

    it("accepts Uint8Array ref", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.markUsed(pkg.keyPackageRef);

      const stored = await manager.get(pkg.keyPackageRef);
      expect(stored?.used).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe("list()", () => {
    it("returns all locally stored key packages enriched with published events", async () => {
      const { manager } = makeManager(network, account);
      await manager.create({ relays: ["wss://relay.test"] });
      await manager.create({ relays: ["wss://relay.test"] });

      expect(await manager.list()).toHaveLength(2);
    });

    it("each entry includes published — filter for packages with published events", async () => {
      const { manager, store } = makeManager(network, account);

      // One published package
      await manager.create({ relays: ["wss://relay.test"] });

      // One unpublished package (added directly to private store, no publish record)
      const { generateKeyPackage } = await import("../core/key-package.js");
      const { createCredential } = await import("../core/credential.js");
      const { defaultCryptoProvider, getCiphersuiteImpl } =
        await import("ts-mls");
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
      });
      await store.add(kp);

      const all = await manager.list();
      expect(all).toHaveLength(2);
      expect(all.filter((p) => (p.published?.length ?? 0) > 0)).toHaveLength(1);
    });

    it("tracked foreign packages (no private key) do not appear in list()", async () => {
      const { manager } = makeManager(network, account);

      // Create a foreign key package from another account to get a real event
      const otherNetwork = new MockNetwork(["wss://relay.test"]);
      const otherAccount = PrivateKeyAccount.generateNew();
      const { manager: otherManager } = makeManager(otherNetwork, otherAccount);
      await otherManager.create({ relays: ["wss://relay.test"] });
      const foreignEvent = otherNetwork.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      await manager.track(foreignEvent);

      // list() only returns local (private key) entries
      expect(await manager.list()).toHaveLength(0);
      // But the tracked entry is retrievable directly
      const refHex = foreignEvent.tags.find((t) => t[0] === "i")![1];
      const stored = await manager.get(refHex);
      expect(stored?.published).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // watchKeyPackages()
  // -------------------------------------------------------------------------

  describe("watchKeyPackages()", () => {
    it("yields initial snapshot immediately", async () => {
      const { manager } = makeManager(network, account);
      await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      const { value } = await gen.next();
      await gen.return(undefined);

      expect(value).toHaveLength(1);
      expect(value[0].published).toHaveLength(1);
    });

    it("initial snapshot includes published events merged from store", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      const { value } = await gen.next();
      await gen.return(undefined);

      expect(value[0].keyPackageRef).toEqual(pkg.keyPackageRef);
      expect(value[0].published).toHaveLength(1);
      expect(getKeyPackageRelays(value[0].published![0])).toContain(
        "wss://relay.test/",
      );
    });

    it("yields updated snapshot after a key package is added", async () => {
      const { manager } = makeManager(network, account);
      const gen = manager.watchKeyPackages();

      // Consume initial empty snapshot
      const first = await gen.next();
      expect(first.value).toHaveLength(0);

      // Create a package — should trigger a new yield
      const created = manager.create({ relays: ["wss://relay.test"] });
      const second = await gen.next();
      await created; // ensure create() completes
      await gen.return(undefined);

      expect(second.value).toHaveLength(1);
    });

    it("yields updated snapshot after a publish is recorded via track()", async () => {
      const { manager } = makeManager(network, account);
      await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === KEY_PACKAGE_KIND,
      )!;

      const gen = manager.watchKeyPackages();
      // Consume initial snapshot (1 published event)
      await gen.next();

      // Track another observation of the same event — should trigger a new yield
      const tracking = manager.track({ ...realEvent, id: "b".repeat(64) });
      const { value } = await gen.next();
      await tracking;
      await gen.return(undefined);

      expect(value[0].published).toHaveLength(2);
    });

    it("yields updated snapshot after a key package is removed", async () => {
      const { manager } = makeManager(network, account);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      // Consume initial snapshot
      await gen.next();

      const removal = manager.remove(pkg.keyPackageRef);
      const { value } = await gen.next();
      await removal;
      await gen.return(undefined);

      expect(value).toHaveLength(0);
    });
  });
});
