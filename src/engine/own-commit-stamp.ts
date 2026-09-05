/** @module @category Engine */
import { sha256 } from "@noble/hashes/sha2.js";

import { BinaryReader, BinaryWriter } from "../core/binary.js";

const OWN_COMMIT_RECORD_MAGIC = Uint8Array.of(0x4f, 0x43, 0x53, 0x54); // OCST
const OWN_COMMIT_RECORD_VERSION = 1;

export type CommitOrderingPriority = "privileged" | "ordinary";

/** Evidence captured while a locally-authored commit is still staged. */
export interface OwnCommitConvergenceStamp {
  /** Authenticated Marmot account identity of the committer. */
  committer: string;
  /** Authorization-aware ordering class decided at preparation time. */
  priority: CommitOrderingPriority;
  /** Exact proposal references consumed by the commit, sorted on storage. */
  consumedProposalRefs: Uint8Array[];
}

export type DecodedOwnCommitRecord =
  | {
      kind: "stamped";
      wireBytes: Uint8Array;
      stamp: OwnCommitConvergenceStamp;
    }
  | { kind: "legacy"; wireBytes: Uint8Array };

function startsWithMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= OWN_COMMIT_RECORD_MAGIC.length &&
    OWN_COMMIT_RECORD_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const difference = a[i] - b[i];
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Encodes a stamped own commit as a versioned, strictly-decodable record. */
export function encodeOwnCommitRecord(input: {
  wireBytes: Uint8Array;
  stamp: OwnCommitConvergenceStamp;
}): Uint8Array {
  const references = input.stamp.consumedProposalRefs
    .map((reference) => reference.slice())
    .sort(compareBytes)
    .map((reference) => new BinaryWriter().opaque(reference).build());
  const priority = input.stamp.priority === "privileged" ? 0 : 1;

  return new BinaryWriter()
    .bytes(OWN_COMMIT_RECORD_MAGIC)
    .uint8(OWN_COMMIT_RECORD_VERSION)
    .opaque(input.wireBytes)
    .opaque(new TextEncoder().encode(input.stamp.committer))
    .uint8(priority)
    .vector(references)
    .build();
}

/**
 * Decodes a stamped record, or explicitly reports an old bare-wire record.
 * Bytes carrying the stamp magic always fail closed on malformed content.
 */
export function decodeOwnCommitRecord(
  bytes: Uint8Array,
): DecodedOwnCommitRecord {
  if (!startsWithMagic(bytes))
    return { kind: "legacy", wireBytes: bytes.slice() };

  const reader = new BinaryReader(bytes);
  reader.bytes(OWN_COMMIT_RECORD_MAGIC.length);
  const version = reader.uint8();
  if (version !== OWN_COMMIT_RECORD_VERSION)
    throw new Error(`Unknown own commit record version ${version}`);
  const wireBytes = reader.opaque();
  const committer = new TextDecoder("utf-8", { fatal: true }).decode(
    reader.opaque({ min: 1 }),
  );
  const priorityValue = reader.uint8();
  if (priorityValue !== 0 && priorityValue !== 1)
    throw new Error(`Unknown commit ordering priority ${priorityValue}`);
  const consumedProposalRefs = reader.vector((item) => item.opaque());
  reader.end();

  for (let i = 1; i < consumedProposalRefs.length; i++) {
    if (compareBytes(consumedProposalRefs[i - 1], consumedProposalRefs[i]) > 0)
      throw new Error("Own commit proposal references are not sorted");
  }

  return {
    kind: "stamped",
    wireBytes,
    stamp: {
      committer,
      priority: priorityValue === 0 ? "privileged" : "ordinary",
      consumedProposalRefs,
    },
  };
}

/** Stable record identity: SHA-256 of the exact MLS wire commit, never the stamp. */
export function ownCommitRecordIdentity(
  record: DecodedOwnCommitRecord,
): Uint8Array {
  return sha256(record.wireBytes);
}
