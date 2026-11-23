import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { GroupBatch } from "../database/group-batch.js";
import { memoryGroupDatabase } from "../database/memory.js";
import type { MarmotGroupDatabase } from "../database/types.js";
import { decodeRecord, encodeRecord } from "../record-codec.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../wrapper-ledger.js";

const id = "ab".repeat(32);
const digest = new Uint8Array(32).fill(3);

async function compact(
  ledger: TerminalWrapperLedger,
  floorEpoch: number,
  pinned?: ReadonlySet<string>,
) {
  const batch = new GroupBatch(ledger.db);
  ledger.stageCompaction(batch, floorEpoch, pinned);
  await batch.commit();
}

async function compactEffects(
  ledger: ConvergenceEffectLedger,
  digests: ReadonlySet<string>,
) {
  const batch = new GroupBatch(ledger.db);
  ledger.stageCompaction(batch, digests);
  await batch.commit();
}

/** A database whose transactions can be made to fail before or after commit. */
function faultable(db: MarmotGroupDatabase) {
  let fault: "before" | "after" | undefined;
  const proxy: MarmotGroupDatabase = Object.assign(Object.create(db), {
    transaction: async <T>(fn: Parameters<typeof db.transaction<T>>[0]) => {
      const mode = fault;
      if (mode === "before") throw new Error("ack crash");
      const result = await db.transaction(fn);
      if (mode === "after") throw new Error("ack crash");
      return result;
    },
  });
  return {
    db: proxy,
    set: (mode: typeof fault) => {
      fault = mode;
    },
  };
}

async function effects(db: MarmotGroupDatabase) {
  const bytes = await db.meta.get("effects");
  return bytes && decodeRecord<Record<string, unknown>>(bytes);
}

describe("terminal wrapper ledger", () => {
  it("records the outcome with its epoch", async () => {
    const db = memoryGroupDatabase();
    const ledger = new TerminalWrapperLedger(db);
    await ledger.record(id, "accepted", 1);
    const row = (await db.wrappers.get(id))!;
    expect(row.epoch).toBe(1);
    expect(decodeRecord(row.value)).toBe("accepted");
    expect(await ledger.get(id)).toBe("accepted");
  });

  it("stages records into a caller batch that is durable only on commit", async () => {
    const db = memoryGroupDatabase();
    const ledger = new TerminalWrapperLedger(db);
    const batch = new GroupBatch(db);
    ledger.stage(batch, id, "stale", 2);
    expect(await ledger.get(id)).toBeUndefined();
    await batch.commit();
    expect(await ledger.get(id)).toBe("stale");
  });

  it("compacts below the floor, retaining equality, pins and other rows", async () => {
    const db = memoryGroupDatabase();
    const ledger = new TerminalWrapperLedger(db);
    await compact(ledger, 2);
    await ledger.record(id, "accepted", 1);
    await compact(ledger, 2, new Set([id]));
    expect(await ledger.get(id)).toBe("accepted");
    await compact(ledger, 1);
    expect(await ledger.get(id)).toBe("accepted");
    await compact(ledger, 2);
    expect(await ledger.get(id)).toBeUndefined();

    // A corrupt outcome is ignored by reads but still compacted by epoch.
    const corrupt = "cd".repeat(32);
    await db.transaction((tx) =>
      tx.wrappers.put({
        id: corrupt,
        epoch: 5,
        value: encodeRecord("bogus"),
      }),
    );
    expect(await ledger.get(corrupt)).toBeUndefined();
    await compact(ledger, 5);
    expect(await db.wrappers.get(corrupt)).toBeDefined();
    await compact(ledger, 6);
    expect(await db.wrappers.get(corrupt)).toBeUndefined();
  });

  it("rejects invalid records and compaction floors", async () => {
    const ledger = new TerminalWrapperLedger(memoryGroupDatabase());
    await expect(
      ledger.record(id, "accepted", Number.MAX_SAFE_INTEGER + 1),
    ).rejects.toThrow("Invalid wrapper record");
    await expect(ledger.record(id, "accepted", -1)).rejects.toThrow(
      "Invalid wrapper record",
    );
    expect(() => ledger.stageCompaction(new GroupBatch(ledger.db), -1)).toThrow(
      "retention epoch",
    );
  });

  it("clears every record of its group database only", async () => {
    const db = memoryGroupDatabase();
    const other = memoryGroupDatabase();
    const ledger = new TerminalWrapperLedger(db);
    await ledger.record(id, "accepted", 1);
    await new TerminalWrapperLedger(other).record(id, "accepted", 1);
    await ledger.clear();
    expect(await db.wrappers.get(id)).toBeUndefined();
    expect(await other.wrappers.get(id)).toBeDefined();
  });
});

describe("convergence effect ledger", () => {
  for (const forwarding of ["before", "after"] as const)
    it(`preserves honest effect acknowledgement after ${forwarding} forwarding`, async () => {
      const base = memoryGroupDatabase();
      const fault = faultable(base);
      const ledger = new ConvergenceEffectLedger(fault.db);
      await compactEffects(ledger, new Set());
      await ledger.prepareWithdrawal(digest, 0, [
        { kind: "epochAdvanced", commitDigest: digest, from: 0, to: 1 },
      ]);
      await compactEffects(ledger, new Set());
      expect(await ledger.pending()).toHaveLength(1);
      fault.set(forwarding);
      await expect(ledger.acknowledge(digest, "withdrawal")).rejects.toThrow(
        "ack crash",
      );
      fault.set(undefined);
      for (let restart = 0; restart < 2; restart++) {
        const restored = new ConvergenceEffectLedger(base);
        expect((await restored.pending()).length).toBe(
          forwarding === "before" ? 1 : 0,
        );
        await compactEffects(restored, new Set([bytesToHex(digest)]));
        expect((await effects(base))?.[bytesToHex(digest)]).toBeDefined();
      }
      await ledger.acknowledge(digest, "withdrawal");
      await compactEffects(ledger, new Set());
      expect(await effects(base)).toEqual({});
    });

  it("retires observed effects by exact digest membership and preserves a corrupt ledger", async () => {
    const db = memoryGroupDatabase();
    const ledger = new ConvergenceEffectLedger(db);
    await ledger.prepareWithdrawal(digest, 0, []);
    await ledger.acknowledge(digest, "withdrawal");
    await compactEffects(ledger, new Set([bytesToHex(digest.slice())]));
    expect((await effects(db))?.[bytesToHex(digest)]).toBeDefined();
    await compactEffects(ledger, new Set());
    expect((await effects(db))?.[bytesToHex(digest)]).toBeUndefined();
    await db.transaction((tx) => tx.meta.set("effects", new Uint8Array([255])));
    await compactEffects(ledger, new Set());
    expect(await ledger.hasOpaqueDependency()).toBe(true);
    expect(await db.meta.get("effects")).toEqual(new Uint8Array([255]));
  });

  it("flags a malformed entry as an opaque dependency", async () => {
    const db = memoryGroupDatabase();
    const ledger = new ConvergenceEffectLedger(db);
    expect(await ledger.hasOpaqueDependency()).toBe(false);
    await db.transaction((tx) =>
      tx.meta.set(
        "effects",
        encodeRecord({ [bytesToHex(digest)]: { state: "bogus" } }),
      ),
    );
    expect(await ledger.hasOpaqueDependency()).toBe(true);
    expect(await ledger.pending()).toEqual([]);
  });
});
