/** @module @category Engine */

export type DisbandFailureReason = "NoLongerMember" | "NoLongerAdmin";

export type DisbandRequest =
  | {
      status: "pending";
      requestedAtMs: number;
      lastPreparedEpoch: number | null;
    }
  | {
      status: "failed";
      reason: DisbandFailureReason;
      requestedAtMs: number;
      lastPreparedEpoch: null;
    };

export interface StoredDisbandConvergence {
  readonly generation: number;
  readonly baseEpoch: number;
  readonly openedAtWallMs: number;
  readonly deadlineWallMs: number;
  readonly lastRelevantInputWallMs: number;
  readonly candidates: readonly {
    /** Disband commit digest (hex). */
    readonly commitDigest: string;
    readonly actorPubkey: string;
    readonly sourceEpoch: number;
    readonly parentTag: string;
    readonly childTag: string;
    /** The disband commit (encoded MLS message). */
    readonly commitMessage: Uint8Array;
    /** The state the commit produced (serialized `ClientState`). */
    readonly resultingState: Uint8Array;
  }[];
}

/** Durable disband records the engine owns, supplied by the client layer. */
export interface DisbandRecordStore {
  load(): Promise<{
    request?: DisbandRequest;
    convergence?: StoredDisbandConvergence;
  }>;
  /** Replaces the request; `null` deletes it. */
  saveRequest(request: DisbandRequest | null): Promise<void>;
  /** Replaces the convergence evidence; `null` deletes it. */
  saveConvergence(convergence: StoredDisbandConvergence | null): Promise<void>;
}

/** Validates loaded disband convergence evidence; throws when malformed. */
export function validateDisbandConvergence(
  value: unknown,
): StoredDisbandConvergence {
  const record = value as Partial<StoredDisbandConvergence> | undefined;
  if (
    !record ||
    typeof record !== "object" ||
    !Number.isSafeInteger(record.generation) ||
    !Number.isSafeInteger(record.baseEpoch) ||
    typeof record.openedAtWallMs !== "number" ||
    typeof record.deadlineWallMs !== "number" ||
    typeof record.lastRelevantInputWallMs !== "number" ||
    !Array.isArray(record.candidates)
  )
    throw new Error("Invalid disband convergence record");
  for (const candidate of record.candidates) {
    if (
      !candidate ||
      typeof candidate.commitDigest !== "string" ||
      typeof candidate.actorPubkey !== "string" ||
      !/^[0-9a-f]{64}$/i.test(candidate.commitDigest) ||
      !/^[0-9a-f]{64}$/i.test(candidate.actorPubkey) ||
      !Number.isSafeInteger(candidate.sourceEpoch) ||
      typeof candidate.parentTag !== "string" ||
      typeof candidate.childTag !== "string" ||
      !(candidate.commitMessage instanceof Uint8Array) ||
      !(candidate.resultingState instanceof Uint8Array)
    )
      throw new Error("Invalid disband convergence record");
  }
  return record as StoredDisbandConvergence;
}

/** Validates a loaded disband request; throws when malformed. */
export function validateDisbandRequest(value: unknown): DisbandRequest {
  if (!value || typeof value !== "object")
    throw new Error("Invalid disband request record");
  const record = value as Partial<DisbandRequest> & { reason?: unknown };
  if (
    typeof record.requestedAtMs !== "number" ||
    !Number.isFinite(record.requestedAtMs) ||
    (record.lastPreparedEpoch !== null &&
      (typeof record.lastPreparedEpoch !== "number" ||
        !Number.isSafeInteger(record.lastPreparedEpoch) ||
        record.lastPreparedEpoch < 0))
  )
    throw new Error("Invalid disband request record");
  if (record.status === "pending") {
    return {
      status: "pending",
      requestedAtMs: record.requestedAtMs,
      lastPreparedEpoch: record.lastPreparedEpoch,
    };
  }
  if (
    record.status === "failed" &&
    (record.reason === "NoLongerMember" || record.reason === "NoLongerAdmin") &&
    record.lastPreparedEpoch === null
  ) {
    return {
      status: "failed",
      reason: record.reason,
      requestedAtMs: record.requestedAtMs,
      lastPreparedEpoch: null,
    };
  }
  throw new Error("Invalid disband request record");
}
