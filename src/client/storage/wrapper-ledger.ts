import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import { decodeRecord, encodeRecord } from "./record-codec.js";
import type { MarmotStorage, StorageBatch } from "./storage.js";
import { groupKeys } from "./storage-keys.js";

export type TerminalWrapperOutcome = "accepted" | "stale" | "invalidated";

/** One processed transport wrapper. `epoch` drives retention compaction. */
type StoredWrapper = { outcome: TerminalWrapperOutcome; epoch: number };

const safeEpoch = (epoch: unknown): epoch is number =>
  Number.isSafeInteger(epoch) && (epoch as number) >= 0;
const outcomeValid = (outcome: unknown): outcome is TerminalWrapperOutcome =>
  outcome === "accepted" || outcome === "stale" || outcome === "invalidated";
const HEX_ID = /^[a-f0-9]{64}$/;

/**
 * Durable, group-scoped record of verified transport wrappers handled
 * terminally. Records are staged into the same atomic batch as the state they
 * produced, so a durable record always means the wrapper's effect is durable.
 */
export class TerminalWrapperLedger {
  readonly #prefix: string;

  constructor(
    readonly storage: MarmotStorage,
    readonly groupId: string,
  ) {
    this.#prefix = groupKeys.wrapperPrefix(groupId);
  }

  #decode(bytes: Uint8Array): StoredWrapper | undefined {
    try {
      const value = decodeRecord<StoredWrapper>(bytes);
      if (outcomeValid(value.outcome) && safeEpoch(value.epoch)) return value;
    } catch {
      // Corrupt evidence is ignored; the verified wrapper remains processable.
    }
    return undefined;
  }

  async get(eventId: string): Promise<TerminalWrapperOutcome | undefined> {
    const bytes = await this.storage.get(this.#prefix + eventId);
    return bytes && this.#decode(bytes)?.outcome;
  }

  #encode(outcome: TerminalWrapperOutcome, epoch: number): Uint8Array {
    if (!outcomeValid(outcome) || !safeEpoch(epoch))
      throw new Error("Invalid wrapper record");
    return encodeRecord({ outcome, epoch } satisfies StoredWrapper);
  }

  /** Stages a terminal record into a caller-owned atomic batch. */
  stage(
    batch: StorageBatch,
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): void {
    batch.set(this.#prefix + eventId, this.#encode(outcome, epoch));
  }

  /** Records a terminal outcome that changes no other state (e.g. self-echo). */
  async record(
    eventId: string,
    outcome: TerminalWrapperOutcome,
    epoch: number,
  ): Promise<void> {
    await this.storage.set(
      this.#prefix + eventId,
      this.#encode(outcome, epoch),
    );
  }

  /** Stages deletion of records strictly below the retention floor. */
  async stageCompaction(
    batch: StorageBatch,
    floorEpoch: number,
    pinnedIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!safeEpoch(floorEpoch))
      throw new Error("Invalid wrapper retention epoch");
    for (const key of await this.storage.list(this.#prefix)) {
      const id = key.slice(this.#prefix.length);
      if (!HEX_ID.test(id) || pinnedIds.has(id)) continue;
      const bytes = await this.storage.get(key);
      const value = bytes && this.#decode(bytes);
      if (value && value.epoch < floorEpoch) batch.delete(key);
    }
  }

  /** Removes every record (terminal group cleanup). */
  async clear(): Promise<void> {
    const keys = await this.storage.list(this.#prefix);
    if (keys.length)
      await this.storage.batch(keys.map((key) => ({ type: "delete", key })));
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

/** Durable observation verdicts for branch-selection withdrawal/re-adoption. */
export class ConvergenceEffectLedger {
  readonly #prefix: string;

  constructor(
    readonly storage: MarmotStorage,
    readonly groupId: string,
  ) {
    this.#prefix = groupKeys.effectPrefix(groupId);
  }

  #key(digest: Uint8Array): string {
    return this.#prefix + bytesToHex(digest);
  }

  async #readKey(key: string): Promise<StoredEffect | undefined> {
    const bytes = await this.storage.get(key);
    if (!bytes) return undefined;
    try {
      const value = decodeRecord<StoredEffect>(bytes);
      if (
        (value.state === "pending" || value.state === "observed") &&
        (value.direction === "withdrawal" || value.direction === "adoption") &&
        Array.isArray(value.notifications) &&
        (value.forkEpoch === undefined || safeEpoch(value.forkEpoch)) &&
        (value.direction !== "withdrawal" || safeEpoch(value.forkEpoch)) &&
        (value.producingEpoch === undefined ||
          safeEpoch(value.producingEpoch)) &&
        value.notifications.every((notification) =>
          HEX_ID.test(notification.commitDigest),
        )
      )
        return value;
    } catch {
      // Corrupt local evidence cannot establish an observation boundary.
    }
    return undefined;
  }

  async #write(digest: Uint8Array, value: StoredEffect) {
    await this.storage.set(this.#key(digest), encodeRecord(value));
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
    const existing = await this.#readKey(this.#key(digest));
    if (existing?.direction === "withdrawal")
      return existing.state === "pending";
    const producing = notifications.find(
      (notification) =>
        notification.kind === "epochAdvanced" &&
        bytesToHex(notification.commitDigest) === bytesToHex(digest),
    ) as Extract<StateNotification, { kind: "epochAdvanced" }> | undefined;
    await this.#write(digest, {
      producingEpoch: producing?.to,
      state: "pending",
      direction: "withdrawal",
      forkEpoch,
      notifications: this.#encodeNotifications(notifications),
    });
    return true;
  }

  async prepareAdoption(
    digest: Uint8Array,
    notifications: readonly StateNotification[],
  ): Promise<boolean> {
    const existing = await this.#readKey(this.#key(digest));
    if (!existing) return false;
    if (existing.direction === "adoption") return existing.state === "pending";
    if (existing.state !== "observed") return false;
    await this.#write(digest, {
      producingEpoch: existing.producingEpoch,
      state: "pending",
      direction: "adoption",
      notifications: this.#encodeNotifications(notifications),
    });
    return true;
  }

  async acknowledge(
    digest: Uint8Array,
    direction: StoredEffect["direction"],
  ): Promise<void> {
    const existing = await this.#readKey(this.#key(digest));
    if (
      !existing ||
      existing.direction !== direction ||
      existing.state !== "pending"
    )
      return;
    await this.#write(digest, { ...existing, state: "observed" });
  }

  async pending(): Promise<PendingConvergenceEffect[]> {
    const pending: PendingConvergenceEffect[] = [];
    for (const key of await this.storage.list(this.#prefix)) {
      const hex = key.slice(this.#prefix.length);
      if (!HEX_ID.test(hex)) continue;
      const value = await this.#readKey(key);
      if (!value || value.state !== "pending") continue;
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
  async stageCompaction(
    batch: StorageBatch,
    digests: ReadonlySet<string>,
  ): Promise<void> {
    for (const key of await this.storage.list(this.#prefix)) {
      const hex = key.slice(this.#prefix.length);
      if (!HEX_ID.test(hex)) continue;
      const value = await this.#readKey(key);
      if (!value || value.state === "pending") continue;
      if (!digests.has(hex)) batch.delete(key);
    }
  }

  /** A corrupt record blocks provenance release. */
  async hasOpaqueDependency(): Promise<boolean> {
    for (const key of await this.storage.list(this.#prefix))
      if (
        HEX_ID.test(key.slice(this.#prefix.length)) &&
        !(await this.#readKey(key))
      )
        return true;
    return false;
  }
}
