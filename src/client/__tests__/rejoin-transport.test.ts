import { describe, expect, it, onTestFinished, vi } from "vitest";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import {
  createApplicationMessageIntent,
  createChatRumor,
  Proposals,
} from "../group/index.js";
import { MarmotClient } from "../marmot-client.js";
import { backfillRelayKey } from "../storage/backfill-cursor.js";
import type { NostrEvent } from "applesauce-core/helpers/event";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("rejoin transport incarnation ownership", () => {
  it.each(["manual", "active-all", "removed-all"] as const)(
    "retires blocked old backfill without touching the replacement (%s)",
    async (mode) => {
      const network = new MockNetwork();
      const relays = ["wss://mock-relay.test"];
      const a = new MarmotClient({
        database: memoryDatabase(),
        network,
        signer: testAccount(1).signer,
        clientId: "aa".repeat(32),
      });
      const b = new MarmotClient({
        database: memoryDatabase(),
        network,
        signer: testAccount(2).signer,
        clientId: "bb".repeat(32),
      });
      onTestFinished(() => {
        a.dispose();
        b.dispose();
      });
      const groupA = await a.groups.create("Transport rejoin", {
        relays,
        adminPubkeys: [testAccount(1).pubkey],
      });
      async function invite() {
        const start = network.events.length;
        await b.keyPackages.create({ relays });
        const key = network.events
          .slice(start)
          .find((event) => event.kind === ADDRESSABLE_KEY_PACKAGE_KIND)!;
        await a.groups.invite(groupA.id, key);
        const wrap = network.events
          .slice(start)
          .find((event) => event.kind === 1059)!;
        await b.invites.ingestEvent(wrap);
        const welcomeRumor = await b.invites.decryptGiftWrap(wrap.id);
        if (!welcomeRumor) throw new Error("Missing Welcome");
        return b.joinGroupFromWelcome({ welcomeRumor });
      }
      const { group } = await invite();
      const oldSession = group.session;
      const entered = deferred<void>();
      const blocked = deferred<NostrEvent[]>();
      let hold = true;
      const request = network.request.bind(network);
      vi.spyOn(network, "request").mockImplementation(
        async (routes, filters) => {
          const filter = Array.isArray(filters) ? filters[0] : filters;
          if (filter.kinds?.includes(GROUP_EVENT_KIND) && hold) {
            hold = false;
            entered.resolve();
            return blocked.promise;
          }
          return (await request(routes, filters))
            .filter(
              (event) =>
                (filter.since === undefined ||
                  event.created_at >= filter.since) &&
                (filter.until === undefined ||
                  event.created_at <= filter.until),
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, filter.limit);
        },
      );
      const subscriptions = vi.spyOn(network, "subscription");
      const oldConnect = b.groups.connect(group.id);
      let all: ReturnType<typeof b.groups.connectAll> | undefined;
      onTestFinished(() => all?.unsubscribe());
      await entered.promise;
      if (mode === "active-all") {
        all = b.groups.connectAll();
        await vi.waitFor(() => expect(subscriptions).toHaveBeenCalledTimes(1));
      }
      const results = vi.fn();
      b.groups.on("ingestResult", results);
      const before = network.events.length;
      await a.groups.commit(group.id, {
        extraProposals: [Proposals.proposeRemoveUser(testAccount(2).pubkey)],
      });
      if (mode === "active-all") {
        // Deliver through the connected admission queue, not a parallel
        // explicit ingest: removal retires the connection before the facade
        // emits its removing result, which must still be forwarded once.
        await vi.waitFor(() => {
          expect(group.status).toBe("removed");
          expect(
            results.mock.calls.filter(
              ([, result]) => result.kind === "removed",
            ),
          ).toHaveLength(1);
        });
      } else {
        for await (const result of b.groups.ingest(
          group.id,
          network.events
            .slice(before)
            .filter((event) => event.kind === GROUP_EVENT_KIND),
        ))
          void result;
      }
      expect(group.status).toBe("removed");
      // Starting connectAll while the retained copy is removed must not pin a
      // no-op connection that prevents the joined event from reconnecting it.
      if (mode === "removed-all") all = b.groups.connectAll();
      const { group: rejoined } = await invite();
      expect(rejoined).toBe(group);
      expect(group.session).not.toBe(oldSession);
      const manual =
        mode === "manual" ? await b.groups.connect(group.id) : undefined;
      onTestFinished(() => manual?.unsubscribe());
      const expectedSubscriptions = mode === "active-all" ? 2 : 1;
      await vi.waitFor(() =>
        expect(subscriptions).toHaveBeenCalledTimes(expectedSubscriptions),
      );

      const rumor = createChatRumor({
        pubkey: testAccount(1).pubkey,
        content: "new incarnation delivery",
      });
      const start = network.events.length;
      await a.groups.send(group.id, createApplicationMessageIntent(rumor));
      const envelopes = network.events
        .slice(start)
        .filter((event) => event.kind === GROUP_EVENT_KIND);
      await vi.waitFor(async () =>
        expect(await group.history.queryRumors({ ids: [rumor.id] })).toEqual([
          rumor,
        ]),
      );
      const record = await group.database.group();
      const cursor = await group.database.backfill.get(
        backfillRelayKey(relays[0]),
      );
      expect(cursor?.cursor).toEqual(expect.any(Number));
      blocked.resolve(envelopes);
      (await oldConnect)?.unsubscribe();
      // Let the old connectAll promise complete as well. Its cleanup must not
      // detach the new admission forwarder or replace the new cursor.
      await vi.waitFor(() =>
        expect(subscriptions).toHaveBeenCalledTimes(expectedSubscriptions),
      );
      expect(await group.database.group()).toEqual(record);
      expect(
        await group.database.backfill.get(backfillRelayKey(relays[0])),
      ).toEqual(cursor);
      const forwarded = vi.fn();
      b.groups.on("ingestResult", forwarded);
      const next = createChatRumor({
        pubkey: testAccount(1).pubkey,
        content: "old cleanup cannot detach the new connection",
      });
      await a.groups.send(group.id, createApplicationMessageIntent(next));
      await vi.waitFor(async () => {
        expect(await group.history.queryRumors({ ids: [next.id] })).toEqual([
          next,
        ]);
        expect(forwarded).toHaveBeenCalled();
      });
      if (mode === "active-all")
        expect(
          results.mock.calls.filter(([, result]) => result.kind === "removed"),
        ).toHaveLength(1);
    },
  );
});
