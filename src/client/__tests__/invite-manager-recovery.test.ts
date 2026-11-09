import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { giftWrap } from "applesauce-common/operations/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import {
  InviteManager,
  type StoredInviteEntry,
  type UnreadInvite,
} from "../invite-manager.js";
import type { StoredKeyPackage } from "../key-package-manager.js";
import { MarmotClient } from "../marmot-client.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** JSON persistence also prevents Applesauce's same-object caches hiding prompts. */
class DurableStore extends InMemoryKeyValueStore<StoredInviteEntry> {
  override async getItem(key: string): Promise<StoredInviteEntry | null> {
    return wire(await super.getItem(key));
  }
  override async setItem(
    key: string,
    value: StoredInviteEntry,
  ): Promise<StoredInviteEntry> {
    return super.setItem(key, wire(value));
  }
}

async function fixture() {
  const network = new MockNetwork();
  const aliceAccount = PrivateKeyAccount.generateNew();
  const bobAccount = PrivateKeyAccount.generateNew();
  const store = new DurableStore();
  const alice = new MarmotClient({
    signer: aliceAccount.signer,
    network,
    groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
    keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
  });
  const bob = new MarmotClient({
    signer: bobAccount.signer,
    network,
    clientId: "ab".repeat(32),
    inviteStore: store,
    groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
    keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
  });
  await bob.keyPackages.create({ relays: network.relayUrls });
  const keyPackage = network.events.find((event) => event.kind === 30443)!;
  const group = await alice.groups.create("Invite recovery", {
    relays: network.relayUrls,
    invitees: [keyPackage],
  });
  // Essential: generated gift wraps carry cached plaintext on symbol properties.
  const wrap = wire(network.events.find((event) => event.kind === 1059)!);
  group.dispose();
  const restart = () =>
    new InviteManager({ signer: bobAccount.signer, store, network });
  const manager = restart();
  await manager.ingestEvent(wrap);
  return { manager, restart, store, wrap, bobAccount, aliceAccount, network };
}

describe("InviteManager durable recovery", () => {
  it.each(["Signer disconnected", "User cancelled"])(
    "retains a real Welcome after %s, then explicitly retries after reconnect/restart",
    async (message) => {
      const { manager, restart, wrap, bobAccount } = await fixture();
      const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
      decrypt.mockRejectedValueOnce(new Error(message));
      const errors = vi.fn();
      manager.on("error", errors);
      expect(await manager.decryptGiftWraps()).toEqual([]);
      expect(errors).toHaveBeenCalledOnce();
      expect(decrypt).toHaveBeenCalledOnce();
      expect(await manager.getReceived()).toEqual([wire(wrap)]);
      expect(await manager.ingestEvent(wire(wrap))).toBe(false);

      const recovered = restart();
      expect(await recovered.decryptGiftWraps()).toHaveLength(1);
      expect(await recovered.getReceived()).toEqual([]);
      expect(await recovered.getUnread()).toHaveLength(1);
      expect(await recovered.ingestEvent(wire(wrap))).toBe(false);
    },
  );

  it("journals a Welcome across a failed unread write and restarts without another prompt", async () => {
    const { manager, restart, store, bobAccount, wrap } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const set = store.setItem.bind(store);
    const fault = vi
      .spyOn(store, "setItem")
      .mockImplementation((key, value) => {
        if (key.startsWith("unread:"))
          return Promise.reject(new Error("Quota"));
        return set(key, value);
      });
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(await manager.getUnread()).toEqual([]);
    expect(await manager.getReceived()).toEqual([wire(wrap)]);
    fault.mockRestore();

    const recovered = restart();
    const notified = vi.fn();
    recovered.on("decrypted", notified);
    expect(await recovered.decryptGiftWraps()).toHaveLength(1);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledOnce();
    expect(await recovered.decryptGiftWraps()).toEqual([]);
    expect(notified).toHaveBeenCalledOnce();
  });

  it("automatically resumes a journaled unread write on startup without another prompt", async () => {
    const { manager, restart, store, bobAccount, network } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const set = store.setItem.bind(store);
    const fault = vi
      .spyOn(store, "setItem")
      .mockImplementation((key, value) => {
        if (key.startsWith("unread:")) return Promise.reject(new Error("Busy"));
        return set(key, value);
      });
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    fault.mockRestore();
    const recovered = restart();
    const notified = vi.fn();
    recovered.on("decrypted", notified);
    const sub = await recovered.listen(network.relayUrls);
    await recovered.markAsRead("barrier");
    sub.unsubscribe();
    expect(await recovered.getUnread()).toHaveLength(1);
    expect(await recovered.getReceived()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledOnce();
  });

  it("retains a Welcome when the inner seal's signer call is declined", async () => {
    const { manager, restart, bobAccount } = await fixture();
    const original = bobAccount.signer.nip44!.decrypt.bind(
      bobAccount.signer.nip44,
    );
    const decrypt = vi
      .spyOn(bobAccount.signer.nip44!, "decrypt")
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error("Seal decryption declined"));
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(await manager.getReceived()).toHaveLength(1);
    expect(await restart().decryptGiftWraps()).toHaveLength(1);
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it("requires explicit retry after interruption at the durable attempt marker", async () => {
    const { manager, restart, store, bobAccount, network } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const set = store.setItem.bind(store);
    const fault = vi
      .spyOn(store, "setItem")
      .mockImplementation(async (key, value) => {
        const result = await set(key, value);
        if (value.type === "received" && value.attempted)
          throw new Error("Interrupted before prompting");
        return result;
      });
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
    fault.mockRestore();
    const recovered = restart();
    const sub = await recovered.listen(network.relayUrls);
    await recovered.markAsRead("barrier");
    expect(decrypt).not.toHaveBeenCalled();
    sub.unsubscribe();
    expect(await recovered.decryptGiftWraps()).toHaveLength(1);
  });

  it("retains the encrypted source when writing the transition journal fails", async () => {
    const { manager, restart, store, wrap } = await fixture();
    const set = store.setItem.bind(store);
    const fault = vi
      .spyOn(store, "setItem")
      .mockImplementation((key, value) => {
        if (value.type === "received" && value.rumor)
          return Promise.reject(new Error("Journal unavailable"));
        return set(key, value);
      });
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(await manager.getReceived()).toEqual([wire(wrap)]);
    expect(await manager.getUnread()).toEqual([]);
    fault.mockRestore();
    expect(await restart().decryptGiftWraps()).toHaveLength(1);
  });

  it("notifies durable unread despite failed source removal, then cleans up idempotently on restart", async () => {
    const { manager, restart, store, bobAccount, wrap } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const fault = vi
      .spyOn(store, "removeItem")
      .mockRejectedValueOnce(new Error("Busy"));
    const notified = vi.fn();
    manager.on("decrypted", notified);
    expect(await manager.decryptGiftWraps()).toHaveLength(1);
    expect(notified).toHaveBeenCalledOnce();
    expect(await manager.getReceived()).toEqual([wire(wrap)]);
    expect(await manager.getUnread()).toHaveLength(1);
    fault.mockRestore();

    const recovered = restart();
    recovered.on("decrypted", notified);
    expect(await recovered.decryptGiftWraps()).toEqual([]);
    expect(await recovered.getReceived()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledOnce();
    expect(await recovered.ingestEvent(wire(wrap))).toBe(false);
  });

  it("does not resurrect a read invite when an unfinished source cleanup exists", async () => {
    const { manager, restart, store, wrap } = await fixture();
    const remove = store.removeItem.bind(store);
    const fault = vi
      .spyOn(store, "removeItem")
      .mockImplementation((key) =>
        key.startsWith("received:")
          ? Promise.reject(new Error("Busy"))
          : remove(key),
      );
    await manager.decryptGiftWraps();
    const [rumor] = await manager.getUnread();
    await expect(manager.markAsRead(rumor!.id)).rejects.toThrow("Busy");
    expect(await manager.getUnread()).toHaveLength(1);
    fault.mockRestore();
    await manager.markAsRead(rumor!.id);
    expect(await restart().decryptGiftWraps()).toEqual([]);
    expect(await manager.getUnread()).toEqual([]);
    expect(await manager.ingestEvent(wire(wrap))).toBe(false);
  });

  it("resumes an interruption immediately after unread persistence without duplicate notifications", async () => {
    const { manager, restart, store, bobAccount } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const set = store.setItem.bind(store);
    // A write took effect but the caller never observed its acknowledgement.
    const fault = vi
      .spyOn(store, "setItem")
      .mockImplementation(async (key, value) => {
        const result = await set(key, value);
        if (key.startsWith("unread:"))
          throw new Error("Interrupted after write");
        return result;
      });
    expect(await manager.decryptGiftWraps()).toEqual([]);
    fault.mockRestore();
    const recovered = restart();
    const notified = vi.fn();
    recovered.on("decrypted", notified);
    expect(await recovered.getUnread()).toHaveLength(1);
    expect(await recovered.decryptGiftWraps()).toEqual([]);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(notified).not.toHaveBeenCalled();
    expect(await recovered.getReceived()).toEqual([]);
  });

  it.each([false, true])(
    "refreshes an active unread watcher after an uncertain write (cleanup fails: %s)",
    async (cleanupFails) => {
      const { manager, store, bobAccount } = await fixture();
      const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
      const notified = vi.fn();
      manager.on("decrypted", notified);
      const watcher = manager.watchUnread();
      expect((await watcher.next()).value).toEqual([]);
      const set = store.setItem.bind(store);
      const fault = vi
        .spyOn(store, "setItem")
        .mockImplementation(async (key, value) => {
          const result = await set(key, value);
          if (key.startsWith("unread:"))
            throw new Error("Write acknowledgement lost");
          return result;
        });
      try {
        expect(await manager.decryptGiftWraps()).toEqual([]);
        fault.mockRestore();
        if (cleanupFails)
          vi.spyOn(store, "removeItem").mockRejectedValueOnce(
            new Error("Busy"),
          );
        let snapshot: UnreadInvite[] | undefined;
        const next = watcher.next().then((result) => {
          if (!result.done) snapshot = result.value;
        });
        expect(await manager.decryptGiftWraps()).toEqual([]);
        await vi.waitFor(() => expect(snapshot).toHaveLength(1));
        await next;
        expect(notified).not.toHaveBeenCalled();
        expect(decrypt).toHaveBeenCalledTimes(2);
        expect(await manager.getReceived()).toHaveLength(cleanupFails ? 1 : 0);
      } finally {
        fault.mockRestore();
        await watcher.return(undefined);
      }
    },
  );

  it("serializes overlapping explicit decrypts and duplicate object replay", async () => {
    const { manager, bobAccount, wrap } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const notified = vi.fn();
    manager.on("decrypted", notified);
    const results = await Promise.all([
      manager.decryptGiftWrap(wrap.id),
      manager.decryptGiftWraps(),
      manager.decryptGiftWrap(
        wire(wrap) as Parameters<typeof manager.decryptGiftWrap>[0],
      ),
    ]);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toEqual([]);
    expect(results[2]).toBeNull();
    expect(notified).toHaveBeenCalledOnce();
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it("bounds automatic attempts across relay replay, unrelated arrivals, reconnect and restart", async () => {
    const { manager, restart, bobAccount, wrap, network } = await fixture();
    const decrypt = vi
      .spyOn(bobAccount.signer.nip44!, "decrypt")
      .mockRejectedValue(new Error("Declined"));
    const sub = await manager.listen(network.relayUrls);
    await manager.markAsRead("barrier");
    expect(decrypt).toHaveBeenCalledOnce();
    await network.publish(network.relayUrls, wire(wrap));
    await manager.markAsRead("barrier");
    expect(decrypt).toHaveBeenCalledOnce();
    sub.unsubscribe();

    const recovered = restart();
    const reconnected = await recovered.listen(network.relayUrls);
    await recovered.markAsRead("barrier");
    expect(decrypt).toHaveBeenCalledOnce();
    const other = await bobAccount.signer.signEvent({
      kind: 1059,
      created_at: wrap.created_at + 1,
      content: "malformed ciphertext",
      tags: wrap.tags,
    });
    await network.publish(network.relayUrls, other);
    await vi.waitFor(() => expect(decrypt).toHaveBeenCalledTimes(2));
    await recovered.markAsRead("barrier");
    reconnected.unsubscribe();
    decrypt.mockRestore();
    expect(await recovered.decryptGiftWrap(wrap.id)).not.toBeNull();
  });

  it("does not prompt if persisting the automatic-attempt marker fails", async () => {
    const { manager, store, bobAccount } = await fixture();
    const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
    const fault = vi
      .spyOn(store, "setItem")
      .mockRejectedValue(new Error("Offline storage"));
    expect(await manager.decryptGiftWraps()).toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await manager.getReceived()).toHaveLength(1);
    fault.mockRestore();
    expect(await manager.decryptGiftWraps()).toHaveLength(1);
  });

  it.each([1, 444])(
    "permanently retires invalid kind-%i plaintext, even if quarantine cleanup fails",
    async (kind) => {
      const { restart, store, aliceAccount, bobAccount } = await fixture();
      const invalid = wire(
        await giftWrap(
          await bobAccount.signer.getPublicKey(),
          aliceAccount.signer,
        )({
          kind,
          created_at: Math.floor(Date.now() / 1000),
          content: "not an MLS Welcome",
          tags: [],
        }),
      ) as NostrEvent;
      const manager = restart();
      // Process the real Welcome first; the invalid one below is independent.
      await manager.decryptGiftWraps();
      await manager.ingestEvent(invalid);
      const decrypt = vi.spyOn(bobAccount.signer.nip44!, "decrypt");
      const fault = vi
        .spyOn(store, "removeItem")
        .mockRejectedValueOnce(new Error("Cleanup failed"));
      const errors = vi.fn();
      const notified = vi.fn();
      manager.on("error", errors);
      manager.on("decrypted", notified);
      expect(await manager.decryptGiftWrap(invalid.id)).toBeNull();
      expect(errors).toHaveBeenCalled();
      expect(notified).not.toHaveBeenCalled();
      expect(await manager.getReceived()).toEqual([]);
      const prompts = decrypt.mock.calls.length;
      fault.mockRestore();
      const recovered = restart();
      expect(await recovered.decryptGiftWraps()).toEqual([]);
      expect(decrypt).toHaveBeenCalledTimes(prompts);
      expect(await recovered.ingestEvent(wire(invalid))).toBe(false);
    },
  );
});
