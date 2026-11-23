/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import { getEventHash } from "applesauce-core/helpers/event";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder } from "ts-mls";
import { deserializeApplicationData } from "../../core/application-rumor.js";
import type { DeliveredAppPayload } from "../../engine/delivered-payloads.js";
import type { GroupHistoryTree } from "../../engine/history-tree.js";
import { framedEpoch } from "../../engine/wire-format.js";
import { defaultVerifyEvent, safeVerifyEvent } from "../verify.js";
import type { DeliveryRow } from "./database/types.js";

/** The `deliveries` row id of a delivered payload, or `undefined` if unattributable. */
export function deliveryId(
  entry: DeliveredAppPayload<NostrEvent>,
): string | undefined {
  if (!entry.rumorId || !entry.transportId) return undefined;
  return `${entry.stateTag}:${entry.transportId}`;
}

/** Fields of a `deliveries` row that do not come from the payload itself. */
export interface DeliveryRowFields {
  /** When the delivery was recorded (unix seconds). */
  createdAt: number;
  /** Whether the row carries re-adoption evidence. */
  evidence: boolean;
}

/**
 * The `deliveries` row of an attributable delivery (see {@link deliveryId}).
 * Evidence holds no epoch secrets: only an already-delivered payload and its
 * provenance.
 */
export function toDeliveryRow(
  entry: DeliveredAppPayload<NostrEvent>,
  fields: DeliveryRowFields,
): DeliveryRow {
  const id = deliveryId(entry);
  if (!id) throw new Error("Unattributable delivery");
  return {
    id,
    rumorId: entry.rumorId!,
    stateTag: entry.stateTag,
    epoch: entry.epoch,
    transportId: entry.transportId!,
    createdAt: fields.createdAt,
    evidence: fields.evidence
      ? {
          envelope: entry.envelope,
          message: encode(mlsMessageEncoder, entry.message),
          payload: entry.payload,
          commitDigest: entry.commitDigest && bytesToHex(entry.commitDigest),
        }
      : undefined,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Decodes a row's re-adoption evidence. Rejects corrupt records rather than
 * invent identity or branch attribution.
 */
export function fromDeliveryRow(
  row: DeliveryRow,
  tree: GroupHistoryTree,
): DeliveredAppPayload<NostrEvent> {
  const evidence = row.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !(evidence.payload instanceof Uint8Array) ||
    !(evidence.message instanceof Uint8Array) ||
    (evidence.commitDigest !== undefined &&
      (typeof evidence.commitDigest !== "string" ||
        !/^(?:[a-f0-9]{2})*$/.test(evidence.commitDigest)))
  )
    throw new Error("Invalid delivered evidence version/shape");
  const node =
    typeof row.stateTag === "string" ? tree.node(row.stateTag) : undefined;
  if (
    !node ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 0 ||
    row.epoch !== node.epoch
  )
    throw new Error("Invalid delivered evidence branch");
  const payload = evidence.payload;
  const rumorId = deserializeApplicationData(payload).id.toLowerCase();
  const envelope = evidence.envelope;
  if (
    row.rumorId !== rumorId ||
    !envelope ||
    row.transportId !== envelope.id ||
    typeof row.transportId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.transportId) ||
    getEventHash(envelope) !== row.transportId ||
    envelope.kind !== 445 ||
    !safeVerifyEvent(defaultVerifyEvent, envelope)
  )
    throw new Error("Invalid delivered evidence identity");
  const digest = node.edge?.commitDigest;
  if (evidence.commitDigest !== (digest && bytesToHex(digest)))
    throw new Error("Invalid delivered evidence producing edge");
  const message = decode(mlsMessageDecoder, evidence.message);
  const sourceEpoch = message && framedEpoch(message);
  // A historical-receiver-only delivery can be attributed to a later tip
  // when no full source snapshot remains. It is valid retraction evidence,
  // but mediaSourceForRumor refuses to treat it as exact source provenance.
  if (
    !message ||
    sourceEpoch === undefined ||
    sourceEpoch < 0n ||
    sourceEpoch > BigInt(row.epoch) ||
    !sameBytes(encode(mlsMessageEncoder, message), evidence.message)
  )
    throw new Error("Invalid delivered evidence MLS message");
  return {
    epoch: row.epoch,
    stateTag: row.stateTag,
    envelope,
    transportId: row.transportId,
    rumorId,
    payload,
    message,
    commitDigest: digest,
  };
}
