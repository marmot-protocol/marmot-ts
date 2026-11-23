import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterAll, describe, expect, it } from "vitest";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "../../client/group/application-message.js";
import { MarmotClient } from "../../client/marmot-client.js";
import type { MarmotDatabase } from "../../client/storage/database/types.js";
import { getNostrGroupIdHex } from "../../core/client-state.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { indexedDBDatabase } from "../indexeddb-database.js";
import { sqliteDatabase } from "../sqlite-database.js";

const RELAY = "wss://mock-relay.test";
const dir = mkdtempSync(join(tmpdir(), "marmot-adapter-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let sqlite: typeof import("node:sqlite") | undefined;
try {
  sqlite = await import("node:sqlite");
} catch {
  // No node:sqlite in this runtime.
}

let counter = 0;
/** Each adapter: a factory that reopens the same durable storage. */
const adapters: [string, () => () => MarmotDatabase][] = [
  [
    "indexeddb",
    () => {
      const factory = new IDBFactory();
      const prefix = `client${counter++}`;
      return () =>
        indexedDBDatabase({
          indexedDB: factory,
          keyRange: IDBKeyRange,
          prefix,
        });
    },
  ],
];
if (sqlite)
  adapters.push([
    "sqlite",
    () => {
      const file = join(dir, `client${counter++}.sqlite`);
      return () => {
        const db = new sqlite!.DatabaseSync(file);
        return sqliteDatabase({
          execute(sql, params = []) {
            const statement = db.prepare(sql);
            const args = params as (string | number | null | Uint8Array)[];
            if (/^\s*(SELECT|WITH)/i.test(sql))
              return statement.all(...args) as Record<string, unknown>[];
            statement.run(...args);
            return [];
          },
        });
      };
    },
  ]);

describe.each(adapters)("MarmotClient on %s", (_name, storage) => {
  it("joins, exchanges a message and restores both after a restart", async () => {
    const network = new MockNetwork();
    const admin = PrivateKeyAccount.generateNew();
    const invitee = PrivateKeyAccount.generateNew();
    const open = storage();
    const adminClient = new MarmotClient({
      database: memoryDatabase(),
      signer: admin.signer,
      network,
    });
    const inviteeClient = new MarmotClient({
      database: open(),
      signer: invitee.signer,
      network,
      clientId: "cd".repeat(32),
    });
    const inviteePubkey = await invitee.signer.getPublicKey();

    await inviteeClient.keyPackages.create({ relays: [RELAY] });
    const adminGroup = await adminClient.groups.create("Adapter group", {
      relays: [RELAY],
    });
    const [keyPackage] = await network.request([RELAY], {
      kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
      authors: [inviteePubkey],
    });
    await adminClient.groups.invite(adminGroup.id, keyPackage!);
    const [giftWrap] = await network.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    const welcomeRumor = await unlockGiftWrap(giftWrap!, invitee.signer);
    const { group } = await inviteeClient.joinGroupFromWelcome({
      welcomeRumor,
    });

    const rumor = createChatRumor({
      pubkey: await admin.signer.getPublicKey(),
      content: "hello adapters",
    });
    await adminGroup.runtime.publishEffects(
      await adminGroup.session.send(createApplicationMessageIntent(rumor)),
    );
    const events = await network.request([RELAY], {
      kinds: [GROUP_EVENT_KIND],
      "#h": [getNostrGroupIdHex(group.state)],
    });
    for await (const result of group.ingest(events)) void result;
    expect((await group.history.queryRumors({})).map((r) => r.id)).toEqual([
      rumor.id,
    ]);

    // Restart on the same durable storage.
    const restarted = new MarmotClient({
      database: open(),
      signer: invitee.signer,
      network,
    });
    expect((await restarted.groups.listIds()).map((id) => id.join())).toEqual([
      group.id.join(),
    ]);
    const reloaded = await restarted.groups.get(group.id);
    expect(reloaded.state.groupContext.epoch).toBe(
      group.state.groupContext.epoch,
    );
    expect(reloaded.forkTree.size).toBe(group.forkTree.size);
    expect(
      (await reloaded.history.queryRumors({ kinds: [9] })).map((r) => r.id),
    ).toEqual([rumor.id]);
    // Re-delivery is deduplicated by the durable wrapper ledger.
    const replayed = [];
    for await (const result of reloaded.ingest(events))
      if (result.kind === "processed") replayed.push(result);
    expect(replayed).toEqual([]);

    await restarted.groups.destroy(group.id);
    const after = open();
    expect(await after.account.groups.all()).toEqual([]);
    const db = await after.groups.open(group.idStr);
    expect((await db.group()).state).toBeUndefined();
    expect(await db.messages.query({})).toEqual([]);
  });
});
