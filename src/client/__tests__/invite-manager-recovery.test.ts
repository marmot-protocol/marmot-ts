import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { giftWrap } from "applesauce-common/operations/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { decodeRecord } from "../storage/record-codec.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import type {
  AccountTransaction,
  InviteRow,
  MarmotAccountDatabase,
  MarmotDatabase,
} from "../storage/database/types.js";
import {
  InviteManager,
  type ReceivedInviteRecord,
  type UnreadInvite,
} from "../invite-manager.js";
import { MarmotClient } from "../marmot-client.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const RECEIVED = "invite/received/";
const UNREAD = "invite/unread/";

/** Decodes a received-invite record written under `invite/received/`. */
const receivedRecord = (key: string, value: Uint8Array) =>
  key.startsWith(RECEIVED)
    ? decodeRecord<ReceivedInviteRecord>(value)
    : undefined;

/**
 * A key-addressed view of the account `invites` table: every single-row
 * invite transaction is routed through `set(key, value)` / `delete(key)`
 * (`invite/received/<id>`, `invite/unread/<id>`), so tests can fault one
 * write the way the invite manager issues it. Deleting a received record
 * leaves a seen tombstone, as the invite manager does.
 */
function inviteStore() {
  const base = memoryDatabase();
  const inner = base.account;
  const row = (state: "received" | "unread", id: string, value: Uint8Array) => {
    if (state === "received") {
      const record = decodeRecord<ReceivedInviteRecord>(value);
      return {
        id,
        state,
        rumorId: record.rumor?.id,
        receivedAt: record.giftwrap.created_at,
        value,
      } satisfies InviteRow;
    }
    const rumor = decodeRecord<UnreadInvite>(value);
    return {
      id,
      state,
      rumorId: rumor.id,
      receivedAt: rumor.created_at,
      value,
    } satisfies InviteRow;
  };
  const parse = (key: string) => {
    const state = key.startsWith(RECEIVED) ? "received" : "unread";
    return {
      state,
      id: key.slice((state === "received" ? RECEIVED : UNREAD).length),
    } as const;
  };
  const store = {
    async set(key: string, value: Uint8Array): Promise<void> {
      const { state, id } = parse(key);
      await inner.transaction((tx) => tx.invites.put(row(state, id, value)));
    },
    async delete(key: string): Promise<void> {
      const { state, id } = parse(key);
      await inner.transaction(async (tx) => {
        const existing = await tx.invites.get(id);
        if (existing?.state !== state) return;
        if (state === "unread") return tx.invites.delete(id);
        await tx.invites.put({
          id,
          state: "seen",
          receivedAt: existing.receivedAt,
          value: new Uint8Array(),
        });
      });
    },
  };
  const ROLLBACK = new Error("rollback");
  const account: MarmotAccountDatabase = {
    ...inner,
    meta: inner.meta,
    keyPackages: inner.keyPackages,
    invites: inner.invites,
    groups: inner.groups,
    intents: inner.intents,
    close: () => inner.close(),
    transaction: async <T>(fn: (tx: AccountTransaction) => Promise<T>) => {
      // Dry run: find the single invite write this transaction makes.
      const writes: InviteRow[] = [];
      const deletes: string[] = [];
      let other = false;
      try {
        await inner.transaction(async (tx) => {
          const recording = new Proxy(tx, {
            get: (target, table: keyof AccountTransaction) =>
              table === "invites"
                ? {
                    ...target.invites,
                    put: async (r: InviteRow) => {
                      writes.push(r);
                      return target.invites.put(r);
                    },
                    delete: async (id: string) => {
                      deletes.push(id);
                      return target.invites.delete(id);
                    },
                  }
                : new Proxy(target[table], {
                    get: (t, method: string) => {
                      const value = (t as Record<string, unknown>)[method];
                      if (
                        !["get", "all", "byState", "byRumor"].includes(method)
                      )
                        other = true;
                      return value;
                    },
                  }),
          });
          await fn(recording);
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      if (other || writes.length + deletes.length !== 1)
        return inner.transaction(fn);
      const [write] = writes;
      if (write?.state === "received" || write?.state === "unread")
        await store.set(
          (write.state === "received" ? RECEIVED : UNREAD) + write.id,
          write.value,
        );
      else if (write?.state === "seen") await store.delete(RECEIVED + write.id);
      else await store.delete(UNREAD + deletes[0]);
      return undefined as T;
    },
  };
  const database: MarmotDatabase = { account, groups: base.groups };
  return { store, database };
}

async function fixture() {
  const network = new MockNetwork();
  const aliceAccount = PrivateKeyAccount.generateNew();
  const bobAccount = PrivateKeyAccount.generateNew();
  // Byte storage also prevents Applesauce's same-object caches hiding prompts.
  const { store, database } = inviteStore();
  const alice = new MarmotClient({
    signer: aliceAccount.signer,
    network,
    database: memoryDatabase(),
  });
  const bob = new MarmotClient({
    signer: bobAccount.signer,
    network,
    clientId: "ab".repeat(32),
    database,
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
    new InviteManager({
      signer: bobAccount.signer,
      database: database.account,
      network,
    });
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
    const set = store.set.bind(store);
    const fault = vi.spyOn(store, "set").mockImplementation((key, value) => {
      if (key.startsWith(UNREAD)) return Promise.reject(new Error("Quota"));
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
    const set = store.set.bind(store);
    const fault = vi.spyOn(store, "set").mockImplementation((key, value) => {
      if (key.startsWith(UNREAD)) return Promise.reject(new Error("Busy"));
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
    const set = store.set.bind(store);
    const fault = vi
      .spyOn(store, "set")
      .mockImplementation(async (key, value) => {
        const result = await set(key, value);
        if (receivedRecord(key, value)?.attempted)
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
    const set = store.set.bind(store);
    const fault = vi.spyOn(store, "set").mockImplementation((key, value) => {
      if (receivedRecord(key, value)?.rumor)
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
      .spyOn(store, "delete")
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
    const remove = store.delete.bind(store);
    const fault = vi
      .spyOn(store, "delete")
      .mockImplementation((key) =>
        key.startsWith(RECEIVED)
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
    const set = store.set.bind(store);
    // A write took effect but the caller never observed its acknowledgement.
    const fault = vi
      .spyOn(store, "set")
      .mockImplementation(async (key, value) => {
        const result = await set(key, value);
        if (key.startsWith(UNREAD)) throw new Error("Interrupted after write");
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
      const set = store.set.bind(store);
      const fault = vi
        .spyOn(store, "set")
        .mockImplementation(async (key, value) => {
          const result = await set(key, value);
          if (key.startsWith(UNREAD))
            throw new Error("Write acknowledgement lost");
          return result;
        });
      try {
        expect(await manager.decryptGiftWraps()).toEqual([]);
        fault.mockRestore();
        if (cleanupFails)
          vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("Busy"));
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
      .spyOn(store, "set")
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
        .spyOn(store, "delete")
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
