/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Whether the authenticated terminal notification still needs delivery. */
export type DisbandNotificationState = "pending" | "delivered";

/** Authenticated, read-only evidence retained after live MLS state is erased. */
export interface DisbandTombstone {
  readonly groupId: Uint8Array;
  readonly selectedEpoch: number;
  readonly commitDigest: Uint8Array;
  readonly actorPubkey: string;
  readonly notificationState: DisbandNotificationState;
}

/**
 * The persisted form of a {@link DisbandTombstone}. The group id is implicit:
 * the record lives in the group's own storage.
 */
export interface StoredDisbandTombstone {
  readonly selectedEpoch: number;
  /** Disband commit digest (hex). */
  readonly commitDigest: string;
  readonly actorPubkey: string;
  readonly notificationState: DisbandNotificationState;
}

/**
 * First durable terminal authority: the tombstone plus the non-secret repair
 * projection (a scrubbed serialized `ClientState`), persisted together.
 */
export interface DisbandTerminalIntent {
  readonly tombstone: DisbandTombstone;
  readonly registryState: Uint8Array;
}

/** The persisted form of a tombstone; throws when the tombstone is invalid. */
export function toStoredDisbandTombstone(
  tombstone: DisbandTombstone,
): StoredDisbandTombstone {
  validateTombstone(tombstone);
  return {
    selectedEpoch: tombstone.selectedEpoch,
    commitDigest: bytesToHex(tombstone.commitDigest),
    actorPubkey: tombstone.actorPubkey,
    notificationState: tombstone.notificationState,
  };
}

/** Validates a persisted tombstone of the group `groupId`; throws when malformed. */
export function fromStoredDisbandTombstone(
  value: unknown,
  groupId: Uint8Array,
): DisbandTombstone {
  if (!value || typeof value !== "object")
    throw new Error("Invalid disband tombstone record");
  const record = value as Partial<StoredDisbandTombstone>;
  if (
    typeof record.selectedEpoch !== "number" ||
    typeof record.commitDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.commitDigest) ||
    typeof record.actorPubkey !== "string" ||
    (record.notificationState !== "pending" &&
      record.notificationState !== "delivered")
  )
    throw new Error("Invalid disband tombstone record");
  const tombstone: DisbandTombstone = {
    groupId: groupId.slice(),
    selectedEpoch: record.selectedEpoch,
    commitDigest: hexToBytes(record.commitDigest),
    actorPubkey: record.actorPubkey,
    notificationState: record.notificationState,
  };
  validateTombstone(tombstone);
  return tombstone;
}

function validateTombstone(tombstone: DisbandTombstone): void {
  if (
    tombstone.groupId.length === 0 ||
    !Number.isSafeInteger(tombstone.selectedEpoch) ||
    tombstone.selectedEpoch < 0 ||
    tombstone.commitDigest.length !== 32 ||
    !/^[0-9a-f]{64}$/i.test(tombstone.actorPubkey) ||
    (tombstone.notificationState !== "pending" &&
      tombstone.notificationState !== "delivered")
  )
    throw new Error("Invalid disband tombstone record");
}
