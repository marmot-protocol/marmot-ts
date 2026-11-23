import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { fetchGroupBackfill } from "../group-backfill.js";
import { GroupsManager } from "../groups-manager.js";
import type {
  BackfillResult,
  NostrNetworkInterface,
} from "../nostr-interface.js";
import { fakeVerifyEvent } from "../verify.js";
import {
  readBackfillCursor,
  updateBackfillRecord,
} from "../storage/backfill-cursor.js";

const A = "wss://a.test";
const B = "wss://b.test";
const event = (id: number, time = 100): NostrEvent => ({
  id: id.toString(16).padStart(64, "0"),
  pubkey: "0".repeat(64),
  sig: "0".repeat(128),
  kind: 445,
  tags: [["h", "aa"]],
  content: "",
  created_at: time,
});
const bounds = { pageSize: 2, maxPages: 2 };
const complete = (relay: string, events: NostrEvent[]): BackfillResult => ({
  events,
  relays: [{ relay, status: "complete", eventIds: events.map((e) => e.id) }],
});

describe("transport backfill", () => {
  it("uses per-relay ranges and keeps valid copies across relay failures", async () => {
    const good = event(1);
    const bad = { ...good, content: "forged" };
    const network: NostrNetworkInterface = new MockNetwork();
    const request = vi.spyOn(network, "request");
    network.backfill = vi.fn(async ([relay]): Promise<BackfillResult> =>
      relay === A ? complete(A, [bad]) : complete(B, [good]),
    );
    const result = await fetchGroupBackfill(
      network,
      [A, B],
      { kinds: [445] },
      {
        ...bounds,
        since: new Map([
          [A, 10],
          [B, 20],
        ]),
        accept: (e) => e.content !== "forged",
      },
    );
    expect(network.backfill).toHaveBeenCalledWith(
      [A],
      { kinds: [445], since: 10 },
      { signal: undefined },
    );
    expect(network.backfill).toHaveBeenCalledWith(
      [B],
      { kinds: [445], since: 20 },
      { signal: undefined },
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.events).toEqual([good]);
    expect(result.relayEvents.get(A)).toEqual([]);
    expect(result.relayEvents.get(B)).toEqual([good]);
  });

  it("preserves successful history when another relay throws", async () => {
    const network: NostrNetworkInterface = new MockNetwork();
    network.backfill = async ([relay]) => {
      if (relay === B) throw new Error("offline");
      return complete(A, [event(1)]);
    };
    const result = await fetchGroupBackfill(network, [A, B], {}, bounds);
    expect(result.events).toEqual([event(1)]);
    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([
      { relay: A, status: "complete" },
      { relay: B, status: "failed" },
    ]);
  });

  it.each(["incomplete", "failed", "skipped"] as const)(
    "does not promote %s to complete",
    async (status) => {
      const network: NostrNetworkInterface = new MockNetwork();
      network.backfill = async () => ({
        events: [event(1)],
        relays: [{ relay: A, status, eventIds: [event(1).id] }],
      });
      const result = await fetchGroupBackfill(network, [A], {}, bounds);
      expect(result.complete).toBe(false);
      expect(result.events).toHaveLength(1);
    },
  );

  it.each(["missing", "out-of-range", "unknown-id"])(
    "does not advance on %s provenance",
    async (problem) => {
      const network: NostrNetworkInterface = new MockNetwork();
      network.backfill = async () => {
        const result = complete(A, [event(1)]);
        if (problem === "missing") result.relays = [];
        if (problem === "unknown-id")
          result.relays[0]!.eventIds.push(event(2).id);
        return result;
      };
      const result = await fetchGroupBackfill(
        network,
        [A],
        {
          since: problem === "out-of-range" ? 200 : 0,
        },
        bounds,
      );
      expect(result.complete).toBe(false);
      expect(result.relays[0]!.status).toBe("failed");
    },
  );

  it("honors cancellation before dispatch and after an adapter finishes", async () => {
    const abort = new AbortController();
    const network: NostrNetworkInterface = new MockNetwork();
    network.backfill = vi.fn(async () => {
      abort.abort(new Error("cancelled"));
      return complete(A, [event(1)]);
    });
    await expect(
      fetchGroupBackfill(network, [A], {}, { ...bounds, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    await expect(
      fetchGroupBackfill(network, [A], {}, { ...bounds, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    expect(network.backfill).toHaveBeenCalledTimes(1);
  });

  it("retains pagination for adapters without backfill", async () => {
    const network = new MockNetwork();
    const request = vi
      .spyOn(network, "request")
      .mockResolvedValueOnce([event(1)])
      .mockResolvedValue([]);
    const result = await fetchGroupBackfill(network, [A], {}, bounds);
    expect(request).toHaveBeenCalledWith([A], { limit: 2 });
    expect(result.events).toEqual([event(1)]);
    expect(result.complete).toBe(true);
  });

  it("ingests before persisting cursors and preserves failed relay cursors across restart", async () => {
    const network: NostrNetworkInterface = new MockNetwork([A, B]);
    const database = memoryDatabase();
    const options = {
      network,
      database,
      signer: testAccount(0).signer,
      verifyEvent: fakeVerifyEvent,
    };
    const manager = new GroupsManager(options);
    const group = await manager.create("Transport backfill", {
      relays: [A, B],
    });
    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const events = await network.request([A], { kinds: [445] });
    const newest = events[0]!.created_at;
    await updateBackfillRecord(group.session.database, B, {
      cursor: newest - 50,
    });
    network.backfill = vi.fn(async ([relay]): Promise<BackfillResult> =>
      relay === A
        ? complete(A, events)
        : {
            events: [],
            relays: [{ relay: B, status: "failed", eventIds: [] }],
          },
    );
    const original = group.ingest.bind(group);
    const ingest = vi.spyOn(group, "ingest");
    ingest.mockImplementation(async function* (...args) {
      expect(
        await readBackfillCursor(group.session.database, A, newest),
      ).toBeUndefined();
      yield* original(...args);
    });
    (await manager.connect(group.id)).unsubscribe();
    expect(ingest).toHaveBeenCalled();
    expect(await readBackfillCursor(group.session.database, A, newest)).toBe(
      newest,
    );
    expect(await readBackfillCursor(group.session.database, B, newest)).toBe(
      newest - 50,
    );

    const restarted = new GroupsManager(options);
    await restarted.loadAll();
    (
      await restarted.connect(group.id, { backfillSlackSeconds: 10 })
    ).unsubscribe();
    expect(network.backfill).toHaveBeenCalledWith(
      [A],
      expect.objectContaining({ since: newest - 10 }),
      expect.anything(),
    );
    expect(network.backfill).toHaveBeenCalledWith(
      [B],
      expect.objectContaining({ since: newest - 60 }),
      expect.anything(),
    );
  });

  it("does not advance a complete relay when ingestion fails", async () => {
    const network: NostrNetworkInterface = new MockNetwork([A]);
    const manager = new GroupsManager({
      network,
      database: memoryDatabase(),
      signer: testAccount(0).signer,
      verifyEvent: fakeVerifyEvent,
    });
    const group = await manager.create("Failure", { relays: [A] });
    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const events = await network.request([A], { kinds: [445] });
    network.backfill = async () => complete(A, events);
    vi.spyOn(group, "ingest").mockImplementation(async function* () {
      throw new Error("storage unavailable");
    });
    (await manager.connect(group.id)).unsubscribe();
    expect(
      await readBackfillCursor(
        group.session.database,
        A,
        Math.floor(Date.now() / 1000),
      ),
    ).toBeUndefined();
  });
});
