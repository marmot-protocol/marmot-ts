import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import { decodeRecord, encodeRecord } from "./record-codec.js";
import type { GroupBatch } from "./database/group-batch.js";
import type { MarmotGroupDatabase, WrapperRow } from "./database/types.js";
import { groupKeys } from "./storage-keys.js";

export type TerminalWrapperOutcome = "accepted" | "stale" | "invalidated";

const safeEpoch = (epoch: unknown): epoch is number =>
  Number.isSafeInteger(epoch) && (epoch as number) >= 0;
const outcomeValid = (outcome: unknown): outcome is TerminalWrapperOutcome =>
  outcome === "accepted" || outcome === "stale" || outcome === "invalidated";
const HEX_ID = /^[a-f0-9]{64}$/;

/**
 * Durable, group-scoped record of verified transport wrappers handled
 * terminally. Records are staged into the same atomic transaction as the state
 * they produced, so a durable record always means the wrapper's effect is
 * durable.
 */
export class TerminalWrapperLedger {
  constructor(readonly db: MarmotGroupDatabase) {}

  #decode(bytes: Uint8Array): TerminalWrapperOutcome | undefined {
    try {
      const outcome = decodeRecord<unknown>(bytes);
      if (outcomeValid(outcome)) return outcome;
    } catch {
      // Corrupt evidence is ignored; the verified wrapper remains processable.
    }
    return undefined;
  }

  async get(eventId: string): Promise<TerminalWrapperOutcome | undefined> {
    const row = await this.db.wrappers.get(eventId);
    return row && safeEpoch(row.epoch) ? this.#decode(row.value) : undefined;
  }

  #row(
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): WrapperRow {
    if (!outcomeValid(outcome) || !safeEpoch(epoch))
      throw new Error("Invalid wrapper record");
    return { id: eventId, epoch, value: encodeRecord(outcome) };
  }

  /** Stages a terminal record into a caller-owned atomic batch. */
  stage(
    batch: GroupBatch,
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): void {
    batch.putWrapper(this.#row(eventId, outcome, epoch));
  }

  /** Records a terminal outcome that changes no other state (e.g. self-echo). */
  async record(
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): Promise<void> {
    const row = this.#row(eventId, outcome, epoch);
    await this.db.transaction((tx) => tx.wrappers.put(row));
  }

  /** Stages deletion of records strictly below the retention floor. */
  stageCompaction(
    batch: GroupBatch,
    floorEpoch: number,
    pinnedIds: ReadonlySet<string> = new Set(),
  ): void {
    if (!safeEpoch(floorEpoch))
      throw new Error("Invalid wrapper retention epoch");
    batch.deleteWrappersBelow(floorEpoch, [...pinnedIds]);
  }

  /** Removes every record (terminal group cleanup). */
  async clear(): Promise<void> {
    await this.db.transaction((tx) =>
      tx.wrappers.deleteBelow(Number.MAX_SAFE_INTEGER),
    );
  }
}

type StoredEffect = {
  state: "pending" | "observed";
  direction: "withdrawal" | "adoption";
  forkEpoch?: number;
  producingEpoch?: number;
  notifications: Array<
    Omit<StateNotification, "commitDigest"> & { commitDigest: string }
  >;
};

export type PendingConvergenceEffect =
  | {
      kind: "stateInvalidated";
      commitDigest: Uint8Array;
      forkEpoch: number;
      withdrawn: StateNotification[];
    }
  | {
      kind: "stateRevalidated";
      commitDigest: Uint8Array;
      effectId: Uint8Array;
      notifications: StateNotification[];
    };

type EffectMap = Record<string, unknown>;

function validEffect(value: unknown): value is StoredEffect {
  const effect = value as StoredEffect;
  return (
    !!effect &&
    typeof effect === "object" &&
    (effect.state === "pending" || effect.state === "observed") &&
    (effect.direction === "withdrawal" || effect.direction === "adoption") &&
    Array.isArray(effect.notifications) &&
    (effect.forkEpoch === undefined || safeEpoch(effect.forkEpoch)) &&
    (effect.direction !== "withdrawal" || safeEpoch(effect.forkEpoch)) &&
    (effect.producingEpoch === undefined || safeEpoch(effect.producingEpoch)) &&
    effect.notifications.every((notification) =>
      HEX_ID.test(notification.commitDigest),
    )
  );
}

/**
 * Durable observation verdicts for branch-selection withdrawal/re-adoption,
 * kept as one `effects` map keyed by commit digest. Every change is a
 * read-modify-write inside one group transaction.
 */
export class ConvergenceEffectLedger {
  constructor(readonly db: MarmotGroupDatabase) {}

  /** Decodes the map; `undefined` when the record itself is corrupt. */
  static #decode(bytes: Uint8Array | undefined): EffectMap | undefined {
    if (!bytes) return {};
    try {
      const value = decodeRecord<unknown>(bytes);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as EffectMap;
    } catch {
      // Corrupt local evidence cannot establish an observation boundary.
    }
    return undefined;
  }

  async #read(): Promise<EffectMap | undefined> {
    return ConvergenceEffectLedger.#decode(
      await this.db.meta.get(groupKeys.effects),
    );
  }

  /** Atomically updates one digest's entry. */
  async #update(
    digest: Uint8Array,
    change: (existing: StoredEffect | undefined) => StoredEffect | undefined,
  ): Promise<void> {
    const hex = bytesToHex(digest);
    await this.db.transaction(async (tx) => {
      const map = ConvergenceEffectLedger.#decode(
        await tx.meta.get(groupKeys.effects),
      );
      if (!map) throw new Error("Corrupt convergence effect ledger");
      const existing = validEffect(map[hex]) ? map[hex] : undefined;
      const next = change(existing);
      if (!next) return;
      await tx.meta.set(
        groupKeys.effects,
        encodeRecord({ ...map, [hex]: next }),
      );
    });
  }

  async #get(digest: Uint8Array): Promise<StoredEffect | undefined> {
    const entry = (await this.#read())?.[bytesToHex(digest)];
    return validEffect(entry) ? entry : undefined;
  }

  #encodeNotifications(notifications: readonly StateNotification[]) {
    return notifications.map((notification) => ({
      ...notification,
      commitDigest: bytesToHex(notification.commitDigest),
    }));
  }

  async prepareWithdrawal(
    digest: Uint8Array,
    forkEpoch: number,
    notifications: readonly StateNotification[],
  ): Promise<boolean> {
    const existing = await this.#get(digest);
    if (existing?.direction === "withdrawal")
      return existing.state === "pending";
    const producing = notifications.find(
      (notification) =>
        notification.kind === "epochAdvanced" &&
        bytesToHex(notification.commitDigest) === bytesToHex(digest),
    ) as Extract<StateNotification, { kind: "epochAdvanced" }> | undefined;
    await this.#update(digest, () => ({
      producingEpoch: producing?.to,
      state: "pending",
      direction: "withdrawal",
      forkEpoch,
      notifications: this.#encodeNotifications(notifications),
    }));
    return true;
  }

  async prepareAdoption(
    digest: Uint8Array,
    notifications: readonly StateNotification[],
  ): Promise<boolean> {
    const existing = await this.#get(digest);
    if (!existing) return false;
    if (existing.direction === "adoption") return existing.state === "pending";
    if (existing.state !== "observed") return false;
    await this.#update(digest, () => ({
      producingEpoch: existing.producingEpoch,
      state: "pending",
      direction: "adoption",
      notifications: this.#encodeNotifications(notifications),
    }));
    return true;
  }

  async acknowledge(
    digest: Uint8Array,
    direction: StoredEffect["direction"],
  ): Promise<void> {
    await this.#update(digest, (existing) =>
      existing &&
      existing.direction === direction &&
      existing.state === "pending"
        ? { ...existing, state: "observed" }
        : undefined,
    );
  }

  async pending(): Promise<PendingConvergenceEffect[]> {
    const pending: PendingConvergenceEffect[] = [];
    for (const [hex, value] of Object.entries((await this.#read()) ?? {})) {
      if (!HEX_ID.test(hex) || !validEffect(value) || value.state !== "pending")
        continue;
      const digest = hexToBytes(hex);
      const notifications = value.notifications.map((notification) => ({
        ...notification,
        commitDigest: hexToBytes(notification.commitDigest),
      })) as StateNotification[];
      pending.push(
        value.direction === "withdrawal"
          ? {
              kind: "stateInvalidated",
              commitDigest: digest,
              forkEpoch: value.forkEpoch!,
              withdrawn: notifications,
            }
          : {
              kind: "stateRevalidated",
              commitDigest: digest,
              effectId: digest,
              notifications,
            },
      );
    }
    return pending;
  }

  /** Stages retirement of observed effects no retained member names. */
  stageCompaction(batch: GroupBatch, digests: ReadonlySet<string>): void {
    batch.then(async (tx) => {
      const map = ConvergenceEffectLedger.#decode(
        await tx.meta.get(groupKeys.effects),
      );
      if (!map) return;
      const kept = Object.fromEntries(
        Object.entries(map).filter(
          ([hex, value]) =>
            !HEX_ID.test(hex) ||
            !validEffect(value) ||
            value.state === "pending" ||
            digests.has(hex),
        ),
      );
      if (Object.keys(kept).length !== Object.keys(map).length)
        await tx.meta.set(groupKeys.effects, encodeRecord(kept));
    });
  }

  /** A corrupt record blocks provenance release. */
  async hasOpaqueDependency(): Promise<boolean> {
    const map = await this.#read();
    if (!map) return true;
    return Object.entries(map).some(
      ([hex, value]) => HEX_ID.test(hex) && !validEffect(value),
    );
  }
}
