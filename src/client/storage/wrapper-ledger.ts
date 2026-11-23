import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { GroupBatch } from "./database/group-batch.js";
import type {
  EffectRow,
  GroupTransaction,
  MarmotGroupDatabase,
  StateNotificationRecord,
  WrapperOutcome,
  WrapperRow,
} from "./database/types.js";

export type TerminalWrapperOutcome = WrapperOutcome;

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

  /** Corrupt evidence is ignored; the verified wrapper remains processable. */
  async get(eventId: string): Promise<TerminalWrapperOutcome | undefined> {
    const row = await this.db.wrappers.get(eventId);
    return row && safeEpoch(row.epoch) && outcomeValid(row.outcome)
      ? row.outcome
      : undefined;
  }

  #row(
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): WrapperRow {
    if (!outcomeValid(outcome) || !safeEpoch(epoch))
      throw new Error("Invalid wrapper record");
    return { id: eventId, epoch, outcome };
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

/** Whether a stored effect row is well-formed (and keyed by its digest). */
function validEffect(row: unknown, digest?: string): row is EffectRow {
  const effect = row as EffectRow;
  return (
    !!effect &&
    typeof effect === "object" &&
    typeof effect.digest === "string" &&
    HEX_ID.test(effect.digest) &&
    (digest === undefined || effect.digest === digest) &&
    (effect.state === "pending" || effect.state === "observed") &&
    (effect.direction === "withdrawal" || effect.direction === "adoption") &&
    Array.isArray(effect.notifications) &&
    (effect.forkEpoch === undefined || safeEpoch(effect.forkEpoch)) &&
    (effect.direction !== "withdrawal" || safeEpoch(effect.forkEpoch)) &&
    (effect.producingEpoch === undefined || safeEpoch(effect.producingEpoch)) &&
    effect.notifications.every(
      (notification) =>
        !!notification &&
        typeof notification === "object" &&
        typeof notification.commitDigest === "string" &&
        HEX_ID.test(notification.commitDigest),
    )
  );
}

function encodeNotifications(
  notifications: readonly StateNotification[],
): StateNotificationRecord[] {
  return notifications.map(
    (notification) =>
      ({
        ...notification,
        commitDigest: bytesToHex(notification.commitDigest),
      }) as StateNotificationRecord,
  );
}

function decodeNotifications(
  notifications: readonly StateNotificationRecord[],
): StateNotification[] {
  return notifications.map(
    (notification) =>
      ({
        ...notification,
        commitDigest: hexToBytes(notification.commitDigest),
      }) as StateNotification,
  );
}

/**
 * Durable observation verdicts for branch-selection withdrawal/re-adoption,
 * one `effects` row per commit digest. Every change is a read-modify-write
 * inside one group transaction.
 */
export class ConvergenceEffectLedger {
  constructor(readonly db: MarmotGroupDatabase) {}

  /** Atomically updates one digest's row. */
  async #update(
    digest: Uint8Array,
    change: (existing: EffectRow | undefined) => EffectRow | undefined,
  ): Promise<void> {
    const hex = bytesToHex(digest);
    await this.db.transaction(async (tx) => {
      const row = await tx.effects.get(hex);
      const next = change(validEffect(row, hex) ? row : undefined);
      if (!next) return;
      await tx.effects.put(next);
    });
  }

  async #get(digest: Uint8Array): Promise<EffectRow | undefined> {
    const hex = bytesToHex(digest);
    const row = await this.db.effects.get(hex);
    return validEffect(row, hex) ? row : undefined;
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
    const row: EffectRow = {
      digest: bytesToHex(digest),
      producingEpoch: producing?.to,
      state: "pending",
      direction: "withdrawal",
      forkEpoch,
      notifications: encodeNotifications(notifications),
    };
    await this.#update(digest, () => row);
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
    const row: EffectRow = {
      digest: existing.digest,
      producingEpoch: existing.producingEpoch,
      state: "pending",
      direction: "adoption",
      notifications: encodeNotifications(notifications),
    };
    await this.#update(digest, () => row);
    return true;
  }

  async acknowledge(
    digest: Uint8Array,
    direction: EffectRow["direction"],
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
    for (const row of await this.db.effects.byState("pending")) {
      if (!validEffect(row) || row.state !== "pending") continue;
      const digest = hexToBytes(row.digest);
      const notifications = decodeNotifications(row.notifications);
      pending.push(
        row.direction === "withdrawal"
          ? {
              kind: "stateInvalidated",
              commitDigest: digest,
              forkEpoch: row.forkEpoch!,
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
    batch.then(async (tx: GroupTransaction) => {
      for (const row of await tx.effects.byState("observed"))
        if (
          validEffect(row) &&
          row.state === "observed" &&
          !digests.has(row.digest)
        )
          await tx.effects.delete(row.digest);
    });
  }

  /** A corrupt row blocks provenance release. */
  async hasOpaqueDependency(): Promise<boolean> {
    const rows = [
      ...(await this.db.effects.byState("pending")),
      ...(await this.db.effects.byState("observed")),
    ];
    return rows.some((row) => !validEffect(row));
  }

  /** Removes every effect (terminal group cleanup). */
  static async clear(tx: GroupTransaction): Promise<void> {
    for (const state of ["pending", "observed"] as const)
      for (const row of await tx.effects.byState(state))
        await tx.effects.delete(row.digest);
  }
}
