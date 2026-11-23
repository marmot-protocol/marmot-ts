import "fake-indexeddb/auto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { deserializeClientState } from "../../core/client-state.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import { getWelcome } from "../../core/welcome.js";
import { indexedDBDatabase } from "../../extra/indexeddb-database.js";
import {
  createApplicationMessageIntent,
  createChatRumor,
  Proposals,
} from "../group/index.js";
import { MarmotClient } from "../marmot-client.js";
import type { MarmotDatabase } from "../storage/database/types.js";

const relays = ["wss://mock-relay.test"];
let databaseCounter = 0;

async function setup(database: MarmotDatabase = memoryDatabase()) {
  const network = new MockNetwork();
  const accountA = testAccount(1);
  const accountB = testAccount(2);
  const a = new MarmotClient({
    database: memoryDatabase(),
    signer: accountA.signer,
    network,
    clientId: "aa".repeat(32),
  });
  let b = makeB(database);
  function makeB(db: MarmotDatabase) {
    const client = new MarmotClient({
      database: db,
      signer: accountB.signer,
      network,
      clientId: "bb".repeat(32),
    });
    onTestFinished(() => client.dispose());
    return client;
  }
  onTestFinished(() => a.dispose());
  const groupA = await a.groups.create("Rejoin durability", {
    adminPubkeys: [accountA.pubkey],
    relays,
  });

  async function invitation(reusable = false) {
    const before = network.events.length;
    const key = await b.keyPackages.create({ relays, isLastResort: reusable });
    const event = network.events
      .slice(before)
      .find((event) => event.kind === ADDRESSABLE_KEY_PACKAGE_KIND)!;
    await a.groups.invite(groupA.id, event);
    const wrap = network.events
      .slice(before)
      .find((event) => event.kind === 1059)!;
    await b.invites.ingestEvent(wrap);
    const welcomeRumor = await b.invites.decryptGiftWrap(wrap.id);
    if (!welcomeRumor) throw new Error("Missing decrypted Welcome");
    return { welcomeRumor, ref: key.keyPackageRef };
  }

  const original = await invitation(true);
  const { group: groupB } = await b.joinGroupFromWelcome(original);

  async function remove() {
    const before = network.events.length;
    await a.groups.commit(groupA.id, {
      extraProposals: [Proposals.proposeRemoveUser(accountB.pubkey)],
    });
    const events = network.events
      .slice(before)
      .filter((event) => event.kind === GROUP_EVENT_KIND);
    for await (const result of b.groups.ingest(groupA.id, events)) void result;
    expect((await b.groups.get(groupA.id)).status).toBe("removed");
  }

  async function message(fromB: boolean, content: string) {
    const sender = fromB ? b : a;
    const receiver = fromB ? a : b;
    const rumor = createChatRumor({
      pubkey: fromB ? accountB.pubkey : accountA.pubkey,
      content,
    });
    const before = network.events.length;
    await sender.groups.send(groupA.id, createApplicationMessageIntent(rumor));
    const events = network.events
      .slice(before)
      .filter((event) => event.kind === GROUP_EVENT_KIND);
    for await (const result of receiver.groups.ingest(groupA.id, events))
      void result;
    expect(
      await (
        await receiver.groups.get(groupA.id)
      ).history.queryRumors({
        ids: [rumor.id],
      }),
    ).toEqual([rumor]);
    return rumor;
  }

  return {
    a,
    get b() {
      return b;
    },
    groupA,
    groupB,
    network,
    original,
    invitation,
    remove,
    message,
    async restart(db: MarmotDatabase = database) {
      b.dispose();
      b = makeB(db);
      return b.groups.get(groupA.id);
    },
  };
}

describe("durable in-place rejoin", { timeout: 15_000 }, () => {
  it("does not inherit a failed Welcome's adoption marker when a later import reuses its database", async () => {
    const f = await setup();
    const database = memoryDatabase();
    const client = new MarmotClient({
      database,
      signer: testAccount(2).signer,
      network: f.network,
      clientId: "dd".repeat(32),
    });
    onTestFinished(() => client.dispose());
    const key = await f.b.keyPackages.get(f.original.ref);
    if (!key?.privatePackage) throw new Error("Missing reusable test key");
    await client.keyPackages.add({
      publicPackage: key.publicPackage,
      privatePackage: key.privatePackage,
    });
    const open = database.groups.open.bind(database.groups);
    const failedOpen = vi
      .spyOn(database.groups, "open")
      .mockImplementation(async (id) => {
        const db = await open(id);
        const transaction = db.transaction.bind(db);
        db.transaction = (fn) =>
          transaction((tx) =>
            fn({
              ...tx,
              updateGroup: async (update) => {
                if (update.state) throw new Error("Initial save failed");
                await tx.updateGroup(update);
              },
            }),
          );
        return db;
      });
    const failedDrop = vi
      .spyOn(database.groups, "drop")
      .mockRejectedValue(new Error("Rollback failed"));
    onTestFinished(() => {
      failedOpen.mockRestore();
      failedDrop.mockRestore();
    });
    await expect(client.joinGroupFromWelcome(f.original)).rejects.toThrow(
      "Initial save failed",
    );
    failedOpen.mockRestore();
    failedDrop.mockRestore();
    const abandoned = await (await open(f.groupA.idStr)).group();
    expect(abandoned.state).toBeUndefined();
    expect(abandoned.adoptionIds).toHaveLength(1);
    await client.groups.import(structuredClone(f.groupB.state));
    await client.keyPackages.finalizeConsumptions();
    expect(
      (await client.keyPackages.get(f.original.ref))?.privatePackage,
    ).toBeDefined();
    expect(
      (await (await open(f.groupA.idStr)).group()).adoptionIds,
    ).toBeUndefined();
  });

  it("rejects another account's valid Welcome supplied with external key material", async () => {
    const f = await setup();
    await f.remove();
    const c = new MarmotClient({
      database: memoryDatabase(),
      signer: testAccount(3).signer,
      network: f.network,
      clientId: "cc".repeat(32),
    });
    onTestFinished(() => c.dispose());
    const before = f.network.events.length;
    await c.keyPackages.create({ relays });
    const keyEvent = f.network.events
      .slice(before)
      .find((event) => event.kind === ADDRESSABLE_KEY_PACKAGE_KIND)!;
    await f.a.groups.invite(f.groupA.id, keyEvent);
    const wrap = f.network.events
      .slice(before)
      .find((event) => event.kind === 1059)!;
    await c.invites.ingestEvent(wrap);
    const rumor = await c.invites.decryptGiftWrap(wrap.id);
    if (!rumor) throw new Error("Missing C's Welcome");
    const welcome = getWelcome(rumor);
    const candidates = await c.keyPackages.selectForWelcome(welcome);
    const record = await f.groupB.database.group();
    const beforeAdopt = vi.fn(async () => {});
    await expect(
      f.b.groups.joinFromWelcome({
        welcome,
        candidates,
        ciphersuiteImpl: await c.cryptoProvider.getCiphersuiteImpl(
          welcome.cipherSuite,
        ),
        beforeAdopt,
      }),
    ).rejects.toThrow(/identity|account/i);
    expect(beforeAdopt).not.toHaveBeenCalled();
    expect(await f.groupB.database.group()).toEqual(record);
    expect(f.groupB.status).toBe("removed");
  });

  it("keeps disbanded groups terminal when an old Welcome is accepted again", async () => {
    const f = await setup();
    const before = f.network.events.length;
    expect((await f.groupA.disband()).kind).toBe("acknowledged");
    for await (const result of f.b.groups.ingest(
      f.groupB.id,
      f.network.events
        .slice(before)
        .filter((event) => event.kind === GROUP_EVENT_KIND),
    ))
      void result;
    await vi.waitFor(() => expect(f.groupB.status).toBe("disbanded"), {
      timeout: 3000,
    });
    const record = await f.groupB.database.group();
    const key = await f.b.keyPackages.get(f.original.ref);
    await expect(f.b.joinGroupFromWelcome(f.original)).rejects.toThrow(
      "already exists",
    );
    expect(f.groupB.status).toBe("disbanded");
    expect(await f.groupB.database.group()).toEqual(record);
    expect(await f.b.keyPackages.get(f.original.ref)).toEqual(key);
  });

  it("rejects stale Welcomes and generic imports without changing removed state or keys", async () => {
    const f = await setup();
    const oldActiveState = structuredClone(f.groupB.state);
    const activeRecord = await f.groupB.database.group();
    const activeKey = await f.b.keyPackages.get(f.original.ref);
    await expect(f.b.joinGroupFromWelcome(f.original)).rejects.toThrow(
      "already exists",
    );
    expect(await f.groupB.database.group()).toEqual(activeRecord);
    expect(await f.b.keyPackages.get(f.original.ref)).toEqual(activeKey);
    await f.remove();
    const record = await f.groupB.database.group();
    const key = await f.b.keyPackages.get(f.original.ref);
    await expect(f.b.joinGroupFromWelcome(f.original)).rejects.toThrow();
    await expect(f.b.groups.import(oldActiveState)).rejects.toThrow(
      "already exists",
    );
    await expect(
      f.b.groups.adoptClientState(oldActiveState, { emit: "joined" }),
    ).rejects.toThrow("already exists");
    expect(await f.groupB.database.group()).toEqual(record);
    expect(await f.b.keyPackages.get(f.original.ref)).toEqual(key);
    expect(await f.b.groups.get(f.groupA.id)).toBe(f.groupB);
    expect(f.groupB.status).toBe("removed");
  });

  it("rolls back a failed replacement, keeps its key across restart, and retries the same invitation", async () => {
    const f = await setup();
    const earlier = await f.message(false, "saved before failed rejoin");
    await f.remove();
    const invite = await f.invitation();
    const record = await f.groupB.database.group();
    const removedEpoch = f.groupB.state.groupContext.epoch;
    const transaction = f.groupB.database.transaction.bind(f.groupB.database);
    const fault = vi
      .spyOn(f.groupB.database, "transaction")
      .mockImplementation((fn) =>
        transaction((tx) =>
          fn({
            ...tx,
            updateGroup: async (update) => {
              await tx.updateGroup(update);
              if (
                update.state &&
                deserializeClientState(update.state).groupContext.epoch >
                  removedEpoch
              )
                throw new Error("Injected rejoin write failure");
            },
          }),
        ),
      );
    onTestFinished(() => fault.mockRestore());
    await expect(f.b.joinGroupFromWelcome(invite)).rejects.toThrow(
      "Injected rejoin write failure",
    );
    fault.mockRestore();
    expect(f.groupB.status).toBe("removed");
    expect(await f.groupB.database.group()).toEqual(record);
    await f.b.keyPackages.finalizeConsumptions();
    expect(
      (await f.b.keyPackages.get(invite.ref))?.privatePackage,
    ).toBeDefined();
    const removed = await f.restart();
    await f.b.keyPackages.finalizeConsumptions();
    expect(removed.status).toBe("removed");
    expect(
      (await f.b.keyPackages.get(invite.ref))?.privatePackage,
    ).toBeDefined();
    const { group } = await f.b.joinGroupFromWelcome(invite);
    expect(group).toBe(removed);
    expect(group.status).toBe("active");
    expect(await group.history.queryRumors({ ids: [earlier.id] })).toEqual([
      earlier,
    ]);
    expect(
      (await f.b.keyPackages.get(invite.ref))?.privatePackage,
    ).toBeUndefined();
    await f.message(false, "after retry");
    await f.message(true, "reply after retry");
  });

  it("admits a concurrent invitation once and supports another removal/rejoin cycle", async () => {
    const f = await setup();
    await f.remove();
    const watching = new AbortController();
    onTestFinished(() => watching.abort());
    const groups = f.b.groups.watch({ signal: watching.signal });
    expect((await groups.next()).value).toEqual([f.groupB]);
    const invite = await f.invitation();
    const joined = vi.fn();
    f.b.groups.on("joined", joined);
    const attempts = await Promise.allSettled([
      f.b.joinGroupFromWelcome(invite),
      f.b.joinGroupFromWelcome(invite),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(joined).toHaveBeenCalledTimes(1);
    expect(await f.b.groups.get(f.groupA.id)).toBe(f.groupB);
    expect((await groups.next()).value).toEqual([f.groupB]);
    await f.message(true, "first return");
    const beforeUpdate = f.network.events.length;
    await f.groupB.selfUpdate();
    for await (const result of f.a.groups.ingest(
      f.groupA.id,
      f.network.events
        .slice(beforeUpdate)
        .filter((event) => event.kind === GROUP_EVENT_KIND),
    ))
      void result;
    expect(f.groupB.state.confirmationTag).toEqual(
      f.groupA.state.confirmationTag,
    );
    await f.remove();
    const second = await f.b.joinGroupFromWelcome(await f.invitation());
    expect(second.group).toBe(f.groupB);
    expect(joined).toHaveBeenCalledTimes(2);
    await f.message(false, "second return");
    await f.message(true, "second reply");
  });

  it("returns a committed rejoin even when application lifecycle listeners throw", async () => {
    const f = await setup();
    await f.remove();
    const invite = await f.invitation();
    f.b.groups.on("updated", () => {
      throw new Error("application updated listener");
    });
    f.b.groups.on("joined", () => {
      throw new Error("application joined listener");
    });
    const { group } = await f.b.joinGroupFromWelcome(invite);
    expect(group).toBe(f.groupB);
    expect(group.status).toBe("active");
    expect(
      (await f.b.keyPackages.get(invite.ref))?.privatePackage,
    ).toBeUndefined();
    await f.message(true, "after observer failure");
    // Cleanup emits updated too; those callbacks belong to this test only.
    f.b.groups.removeAllListeners("updated");
    f.b.groups.removeAllListeners("joined");
  });

  it("reopens IndexedDB before and after rejoining with history and fresh messaging intact", async () => {
    const prefix = `rejoin-${databaseCounter++}`;
    let database = indexedDBDatabase({ prefix });
    const f = await setup(database);
    onTestFinished(async () => {
      f.b.dispose();
      await (await database.groups.open(f.groupA.idStr)).close();
      await database.account.close();
    });
    const earlier = await f.message(false, "before IndexedDB restart");
    await f.remove();
    await f.a.groups.commit(f.groupA.id);
    const hidden = createChatRumor({
      pubkey: await f.a.signer.getPublicKey(),
      content: "excluded even after restart",
    });
    const published = await f.a.groups.send(
      f.groupA.id,
      createApplicationMessageIntent(hidden),
    );
    const banEvents = published.flatMap((result) =>
      result.work.kind === "applicationMessage" ? [result.work.envelope] : [],
    );
    await f.groupB.database.close();
    await database.account.close();
    database = indexedDBDatabase({ prefix });
    const removed = await f.restart(database);
    expect(removed.status).toBe("removed");
    const { group } = await f.b.joinGroupFromWelcome(await f.invitation());
    expect(group).toBe(removed);
    await f.message(false, "after IndexedDB rejoin");
    await f.message(true, "persisted reply");
    await group.database.close();
    await database.account.close();
    database = indexedDBDatabase({ prefix });
    const reopened = await f.restart(database);
    expect(reopened.status).toBe("active");
    expect(await reopened.history.queryRumors({ ids: [earlier.id] })).toEqual([
      earlier,
    ]);
    expect(reopened.state.confirmationTag).toEqual(
      f.groupA.state.confirmationTag,
    );
    for await (const result of f.b.groups.ingest(reopened.id, banEvents))
      void result;
    expect(await reopened.history.queryRumors({ ids: [hidden.id] })).toEqual(
      [],
    );
    await f.message(false, "after second IndexedDB restart");
    await f.message(true, "still active");
  });
});
