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

type StoredDisbandRequest = DisbandRequest & { version: 1 };

/** Group-database meta key of the local disband request. */
export const DISBAND_REQUEST_KEY = "disband/request";

export interface StoredDisbandConvergence {
  readonly generation: number;
  readonly baseEpoch: number;
  readonly openedAtWallMs: number;
  readonly deadlineWallMs: number;
  readonly lastRelevantInputWallMs: number;
  readonly candidates: readonly {
    readonly commitDigest: string;
    readonly actorPubkey: string;
    readonly sourceEpoch: number;
    readonly parentTag: string;
    readonly childTag: string;
    readonly commitMessage: string;
    readonly resultingState: string;
  }[];
}

/** Group-database meta key of persisted disband convergence evidence. */
export const DISBAND_CONVERGENCE_KEY = "disband/convergence";

export function encodeDisbandConvergence(
  record: StoredDisbandConvergence,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, ...record }));
}

export function decodeDisbandConvergence(
  data: Uint8Array,
): StoredDisbandConvergence {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error("Invalid disband convergence encoding");
  }
  const record = value as Partial<StoredDisbandConvergence> & {
    version?: number;
  };
  if (
    !record ||
    record.version !== 1 ||
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
      !/^[0-9a-f]{64}$/i.test(candidate.commitDigest) ||
      !/^[0-9a-f]{64}$/i.test(candidate.actorPubkey) ||
      !Number.isSafeInteger(candidate.sourceEpoch) ||
      typeof candidate.parentTag !== "string" ||
      typeof candidate.childTag !== "string" ||
      typeof candidate.commitMessage !== "string" ||
      typeof candidate.resultingState !== "string" ||
      !/^[0-9a-f]*$/i.test(candidate.commitMessage) ||
      !/^[0-9a-f]*$/i.test(candidate.resultingState)
    )
      throw new Error("Invalid disband convergence record");
  }
  return record as StoredDisbandConvergence;
}

export function encodeDisbandRequest(request: DisbandRequest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ version: 1, ...request } satisfies StoredDisbandRequest),
  );
}

export function decodeDisbandRequest(data: Uint8Array): DisbandRequest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new Error("Invalid disband request encoding");
  }
  if (!value || typeof value !== "object")
    throw new Error("Invalid disband request record");
  const record = value as Partial<StoredDisbandRequest>;
  if (
    record.version !== 1 ||
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
