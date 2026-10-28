import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MarmotClient } from "../marmot-client.js";
import type { StoredKeyPackage } from "../key-package-manager.js";
import type { SerializedClientState } from "../../core/client-state.js";
import type { UnreadInvite } from "../invite-manager.js";
import { GroupRumorHistory } from "../group/group-rumor-history.js";
import { GroupMediaStore } from "../group/group-media-store.js";

function fixture() {
  const store = new InMemoryKeyValueStore<StoredKeyPackage>();
  const client = new MarmotClient({
    groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
    keyPackageStore: store,
    signer: PrivateKeyAccount.generateNew().signer,
    network: new MockNetwork(),
  });
  const backend = {
    queryRumors: async () => [],
    addRumor: async () => {},
    removeRumor: async () => {},
    clear: async () => {},
  };
  const history = new GroupRumorHistory(backend);
  const media = new GroupMediaStore();
  return [
    {
      name: "key packages",
      watch: (signal?: AbortSignal) =>
        client.keyPackages.watchKeyPackages({ signal }),
      count: () => client.keyPackages.listenerCount("updated"),
      changed: () => client.keyPackages.emit("updated", {} as StoredKeyPackage),
      block: () => vi.spyOn(store, "keys"),
    },
    {
      name: "unread invites",
      watch: (signal?: AbortSignal) => client.invites.watchUnread({ signal }),
      count: () => client.invites.listenerCount("read"),
      changed: () => client.invites.emit("read", "id"),
      block: () => vi.spyOn(client.invites, "getUnread"),
    },
    {
      name: "received invites",
      watch: (signal?: AbortSignal) => client.invites.watchReceived({ signal }),
      count: () => client.invites.listenerCount("processed"),
      changed: () => client.invites.emit("processed", "id"),
      block: () => vi.spyOn(client.invites, "getReceived"),
    },
    {
      name: "annotated invites",
      watch: (signal?: AbortSignal) => client.watchInvites({ signal }),
      count: () => client.invites.listenerCount("read"),
      changed: () => client.invites.emit("read", "id"),
      block: () => vi.spyOn(client.invites, "getUnread"),
    },
    {
      name: "history",
      watch: (signal?: AbortSignal) => history.subscribe(undefined, { signal }),
      count: () => history.listenerCount("cleared"),
      changed: () => history.emit("cleared"),
      block: () => vi.spyOn(backend, "queryRumors"),
    },
    {
      name: "media",
      watch: (signal?: AbortSignal) => media.subscribe({ signal }),
      count: () => media.listenerCount("cleared"),
      changed: () => media.emit("cleared"),
      block: () => vi.spyOn(media, "listMedia"),
    },
  ];
}

describe("public watcher cancellation", () => {
  for (let index = 0; index < fixture().length; index++) {
    const name = fixture()[index]!.name;
    for (const end of ["return", "abort"] as const) {
      it(`${name}: ${end} closes idle pulls and leaves other watchers working`, async () => {
        const f = fixture()[index]!;
        const baseline = f.count();
        const controller = new AbortController();
        const watcher = f.watch(controller.signal);
        const other = f.watch();
        await watcher.next();
        await other.next();
        const pending = watcher.next();
        const closing =
          end === "return" ? watcher.return(undefined) : controller.abort();
        expect(f.count()).toBe(baseline + 1);
        await expect(pending).resolves.toMatchObject({ done: true });
        await closing;
        f.changed();
        expect((await other.next()).done).toBe(false);
        await other.return(undefined);
        expect(f.count()).toBe(baseline);
      });

      it(`${name}: ${end} abandons a blocked read and handles late rejection`, async () => {
        const f = fixture()[index]!;
        let reject!: (error: Error) => void;
        const blocked = new Promise<never>((_, no) => {
          reject = no;
        });
        f.block().mockImplementation(() => blocked);
        const controller = new AbortController();
        const baseline = f.count();
        const watcher = f.watch(controller.signal);
        const pending = watcher.next();
        const closing =
          end === "return" ? watcher.return(undefined) : controller.abort();
        expect(f.count()).toBe(baseline);
        await expect(pending).resolves.toMatchObject({ done: true });
        await closing;
        reject(new Error("abandoned storage failure"));
        expect((await watcher.next()).done).toBe(true);
      });
    }
    for (const end of ["throw", "dispose"] as const) {
      it(`${name}: ${end} interrupts idle iteration`, async () => {
        const f = fixture()[index]!;
        const baseline = f.count();
        const watcher = f.watch();
        await watcher.next();
        const pending = watcher.next();
        const error = new Error("closed by consumer");
        const closing =
          end === "throw"
            ? expect(watcher.throw(error)).rejects.toBe(error)
            : watcher[Symbol.asyncDispose]();
        expect(f.count()).toBe(baseline);
        expect((await pending).done).toBe(true);
        await closing;
      });
    }

    it(`${name}: changes between pulls survive repeated open/close cycles`, async () => {
      const f = fixture()[index]!;
      const baseline = f.count();
      for (let cycle = 0; cycle < 3; cycle++) {
        const watcher = f.watch();
        await watcher.next();
        f.changed();
        f.changed();
        expect((await watcher.next()).done).toBe(false);
        await watcher.return(undefined);
        expect(f.count()).toBe(baseline);
      }
    });

    it(`${name}: changes during hydration remain pending`, async () => {
      const f = fixture()[index]!;
      let resolve!: (value: never[]) => void;
      const blocked = new Promise<never[]>((yes) => {
        resolve = yes;
      });
      f.block().mockImplementationOnce(() => blocked);
      const watcher = f.watch();
      const first = watcher.next();
      f.changed();
      resolve([]);
      expect((await first).done).toBe(false);
      // History and media discard overtaken queries; the other watchers emit another
      // current snapshot on the next pull.
      if (index < 4) expect((await watcher.next()).done).toBe(false);
      await watcher.return(undefined);
    });

    it(`${name}: live read failures reject and release listeners`, async () => {
      const f = fixture()[index]!;
      const error = new Error("storage unavailable");
      f.block().mockRejectedValueOnce(error);
      const baseline = f.count();
      await expect(f.watch().next()).rejects.toBe(error);
      expect(f.count()).toBe(baseline);
    });

    it(`${name}: pre-aborted and unstarted iterators leave no listeners`, async () => {
      const f = fixture()[index]!;
      const warmup = f.watch();
      await warmup.next();
      await warmup.return(undefined);
      const read = f.block();
      const baseline = f.count();
      const controller = new AbortController();
      controller.abort();
      expect((await f.watch(controller.signal).next()).done).toBe(true);
      const unstarted = f.watch();
      await unstarted.return(undefined);
      expect((await unstarted.next()).done).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(f.count()).toBe(baseline);
    });
  }

  it("annotated invitations refresh joinability on key package changes", async () => {
    const client = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: PrivateKeyAccount.generateNew().signer,
      network: new MockNetwork(),
    });
    vi.spyOn(client.invites, "getUnread").mockResolvedValue([
      {} as UnreadInvite,
    ]);
    const canJoin = vi
      .spyOn(client, "canJoinInvite")
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const watcher = client.watchInvites();
    expect((await watcher.next()).value?.[0]?.joinable).toBe(false);
    client.keyPackages.emit("added", {} as StoredKeyPackage);
    expect((await watcher.next()).value?.[0]?.joinable).toBe(true);
    expect(canJoin).toHaveBeenCalledTimes(2);
    await watcher.return(undefined);
    expect(client.keyPackages.listenerCount("added")).toBe(0);
  });

  it("annotated invitations cancel during validation", async () => {
    const client = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: PrivateKeyAccount.generateNew().signer,
      network: new MockNetwork(),
    });
    vi.spyOn(client.invites, "getUnread").mockResolvedValue([
      {} as UnreadInvite,
    ]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reject!: (error: Error) => void;
    vi.spyOn(client, "canJoinInvite").mockImplementation(() => {
      entered();
      return new Promise((_, no) => {
        reject = no;
      });
    });
    const watcher = client.watchInvites();
    const pending = watcher.next();
    await started;
    await watcher.return(undefined);
    expect((await pending).done).toBe(true);
    expect(client.invites.listenerCount("read")).toBe(0);
    reject(new Error("late validation failure"));
  });
});
