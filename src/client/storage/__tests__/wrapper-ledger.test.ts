import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeRecord } from "../record-codec.js";
import { memoryStorage, StorageBatch } from "../storage.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../wrapper-ledger.js";

const id = "ab".repeat(32);
const digest = new Uint8Array(32).fill(3);
const wrapperKey = (eventId: string) => `group/ingest/wrapper/${eventId}`;
const effectKey = `group/ingest/effect/${bytesToHex(digest)}`;

async function compact(
  ledger: TerminalWrapperLedger,
  floorEpoch: number,
  pinned?: ReadonlySet<string>,
) {
  const batch = new StorageBatch(ledger.storage);
  await ledger.stageCompaction(batch, floorEpoch, pinned);
  await batch.commit();
}

async function compactEffects(
  ledger: ConvergenceEffectLedger,
  digests: ReadonlySet<string>,
) {
  const batch = new StorageBatch(ledger.storage);
  await ledger.stageCompaction(batch, digests);
  await batch.commit();
}

describe("terminal wrapper ledger", () => {
  it("records the outcome with its epoch", async () => {
    const storage = memoryStorage();
    const ledger = new TerminalWrapperLedger(storage, "group");
    await ledger.record(id, "accepted", 1);
    expect(decodeRecord(storage.data.get(wrapperKey(id))!)).toEqual({
      outcome: "accepted",
      epoch: 1,
    });
    expect(await ledger.get(id)).toBe("accepted");
  });

  it("stages records into a caller batch that is durable only on commit", async () => {
    const storage = memoryStorage();
    const ledger = new TerminalWrapperLedger(storage, "group");
    const batch = new StorageBatch(storage);
    ledger.stage(batch, id, "stale", 2);
    expect(await ledger.get(id)).toBeUndefined();
    await batch.commit();
    expect(await ledger.get(id)).toBe("stale");
  });

  it("retains equality, pins, corrupt rows and exact-prefix neighbors", async () => {
    const storage = memoryStorage();
    const ledger = new TerminalWrapperLedger(storage, "group");
    await compact(ledger, 2);
    expect(await storage.list("")).toEqual([]);
    await ledger.record(id, "accepted", 1);
    await compact(ledger, 2, new Set([id]));
    expect(await ledger.get(id)).toBe("accepted");
    await compact(ledger, 1);
    expect(await ledger.get(id)).toBe("accepted");
    await compact(ledger, 2);
    expect(await ledger.get(id)).toBeUndefined();

    const corrupt = "cd".repeat(32);
    await storage.set(
      wrapperKey(corrupt),
      new TextEncoder().encode('{"outcome":"accepted","epoch":-1}'),
    );
    expect(await ledger.get(corrupt)).toBeUndefined();
    const neighbors = [
      `group/ingest/wrapper/${id}/application`,
      `group-extra/ingest/wrapper/${id}`,
    ];
    for (const key of neighbors) await storage.set(key, new Uint8Array([7]));
    await compact(ledger, 100);
    for (const key of neighbors)
      expect(await storage.get(key)).toEqual(new Uint8Array([7]));
    expect(await storage.get(wrapperKey(corrupt))).toBeDefined();
  });

  it("rejects invalid records and compaction floors", async () => {
    const ledger = new TerminalWrapperLedger(memoryStorage(), "group");
    await expect(
      ledger.record(id, "accepted", Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toThrow("Invalid wrapper record");
    await expect(ledger.record(id, "accepted", -1)).rejects.toThrow(
      "Invalid wrapper record",
    );
    await expect(
      ledger.stageCompaction(new StorageBatch(ledger.storage), -1),
    ).rejects.toThrow("retention epoch");
  });

  it("clears only its own group's records", async () => {
    const storage = memoryStorage();
    const ledger = new TerminalWrapperLedger(storage, "group");
    await ledger.record(id, "accepted", 1);
    await storage.set("other/ingest/wrapper/" + id, new Uint8Array([1]));
    await ledger.clear();
    expect(await storage.list("")).toEqual([`other/ingest/wrapper/${id}`]);
  });
});

describe("convergence effect ledger", () => {
  for (const forwarding of ["before", "after"] as const)
    it(`preserves honest effect acknowledgement after ${forwarding} forwarding`, async () => {
      const storage = memoryStorage();
      const ledger = new ConvergenceEffectLedger(storage, "group");
      await compactEffects(ledger, new Set());
      await ledger.prepareWithdrawal(digest, 0, [
        { kind: "epochAdvanced", commitDigest: digest, from: 0, to: 1 },
      ]);
      await compactEffects(ledger, new Set());
      expect(await ledger.pending()).toHaveLength(1);
      const set = storage.set.bind(storage);
      storage.set = async (key, value) => {
        if (forwarding === "after") await set(key, value);
        throw new Error("ack crash");
      };
      await expect(ledger.acknowledge(digest, "withdrawal")).rejects.toThrow(
        "ack crash",
      );
      storage.set = set;
      for (let restart = 0; restart < 2; restart++) {
        const restored = new ConvergenceEffectLedger(storage, "group");
        expect((await restored.pending()).length).toBe(
          forwarding === "before" ? 1 : 0,
        );
        await compactEffects(restored, new Set([bytesToHex(digest)]));
        expect(await storage.get(effectKey)).toBeDefined();
      }
      await ledger.acknowledge(digest, "withdrawal");
      await compactEffects(ledger, new Set());
      expect(await storage.list("")).toEqual([]);
    });

  it("retires observed effects by exact digest membership and preserves corrupt rows", async () => {
    const storage = memoryStorage();
    const ledger = new ConvergenceEffectLedger(storage, "group");
    await ledger.prepareWithdrawal(digest, 0, []);
    await ledger.acknowledge(digest, "withdrawal");
    await compactEffects(ledger, new Set([bytesToHex(digest.slice())]));
    expect(await storage.get(effectKey)).toBeDefined();
    await compactEffects(ledger, new Set());
    expect(await storage.get(effectKey)).toBeUndefined();
    await storage.set(effectKey, new Uint8Array([255]));
    await compactEffects(ledger, new Set());
    expect(await ledger.hasOpaqueDependency()).toBe(true);
    expect(await storage.get(effectKey)).toEqual(new Uint8Array([255]));
  });
});
