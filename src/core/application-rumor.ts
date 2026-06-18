/** @module @category Core - Group Messages */
import { getEventHash } from "applesauce-core/helpers/event";
import { Rumor } from "applesauce-common/helpers/gift-wrap";

/**
 * Serializes an application rumor (unsigned Nostr event) to bytes.
 * This is the format used for application messages in Marmot groups.
 *
 * @param rumor - The unsigned Nostr event to serialize
 * @returns The serialized application data as bytes
 */
export function serializeApplicationRumor(rumor: Rumor): Uint8Array {
  // Serialize the rumor to a JSON string
  const json = JSON.stringify(rumor);
  // Encode as UTF-8 bytes
  return new TextEncoder().encode(json);
}

/**
 * The exact set of members a Marmot inner application event may carry
 * (`foundation/application-messages.md` §Encoding). A decoder MUST reject any
 * payload carrying a `sig` member or any other unknown member.
 */
const ALLOWED_RUMOR_KEYS = [
  "id",
  "pubkey",
  "created_at",
  "kind",
  "tags",
  "content",
] as const;

/**
 * Deserializes application data bytes back into a rumor, enforcing the Marmot
 * inner-event encoding rules (`foundation/application-messages.md` §Encoding).
 *
 * Strict decode: the payload MUST be a JSON object carrying exactly the six
 * members `id, pubkey, created_at, kind, tags, content` (no `sig`, no unknown
 * members), and its `id` MUST equal the canonical NIP-01 event id recomputed
 * from the other members (lowercase-hex SHA-256 of `[0, pubkey, created_at,
 * kind, tags, content]`). A mismatch or extra/missing member is rejected — this
 * is the integrity half of the authorship checks; the {@link
 * verifyApplicationRumorAuthorship} layer adds the MLS-sender binding.
 *
 * @param data - The serialized application data
 * @returns The deserialized, id-verified Rumor
 * @throws if the bytes are not a strictly-conformant, id-consistent rumor
 */
export function deserializeApplicationData(data: Uint8Array): Rumor {
  // Decode UTF-8 bytes to string
  const json = new TextDecoder().decode(data);
  // Parse JSON
  const parsed = JSON.parse(json);

  // Validate it's a rumor-like object
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid application data: not an object");
  }

  // Reject any member outside the canonical set (catches `sig` and unknown
  // members). Duplicate keys are not detectable through JSON.parse (last write
  // wins); our serializer never emits them and the id check below binds the
  // surviving values, so this is a residual non-canonical-input gap, not a
  // forgery vector.
  for (const key of Object.keys(parsed)) {
    if (!(ALLOWED_RUMOR_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Invalid application data: unexpected member "${key}"`);
    }
  }
  for (const key of ALLOWED_RUMOR_KEYS) {
    if (!(key in parsed)) {
      throw new Error(`Invalid application data: missing member "${key}"`);
    }
  }

  if (
    typeof parsed.id !== "string" ||
    typeof parsed.pubkey !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.created_at !== "number" ||
    typeof parsed.kind !== "number" ||
    !Array.isArray(parsed.tags)
  ) {
    throw new Error("Invalid application data: malformed member types");
  }

  // The `id` MUST equal the canonical NIP-01 event id computed from the other
  // members; getEventHash performs the exact `[0, pubkey, created_at, kind,
  // tags, content]` serialization + SHA-256.
  const canonicalId = getEventHash(parsed as Rumor);
  if (parsed.id.toLowerCase() !== canonicalId) {
    throw new Error(
      `Invalid application data: id ${parsed.id} does not match canonical event id ${canonicalId}`,
    );
  }

  return parsed as Rumor;
}

/**
 * Strict-decodes an application payload and binds its authorship to the MLS
 * sender: the inner `pubkey` MUST equal the authenticated sender's Marmot
 * account identity (`foundation/identity.md`, `protocol-core/group-messaging.md`
 * "Receivers validate that the inner app event `pubkey` matches the Marmot
 * account identity authenticated by MLS"). Both the inner-id check (via {@link
 * deserializeApplicationData}) and this pubkey binding are decode-layer rules;
 * a failure of either is `invalid_encoding` and the message MUST be dropped.
 *
 * @param data - The serialized application payload (decrypted MLS bytes)
 * @param senderPubkeyHex - The MLS sender leaf's credential identity (lowercase
 *   hex Nostr pubkey), NOT the MLS signature key.
 * @returns The verified Rumor authored by the authenticated sender
 * @throws if decode/id verification fails or the author does not match the sender
 */
export function verifyApplicationRumorAuthorship(
  data: Uint8Array,
  senderPubkeyHex: string,
): Rumor {
  const rumor = deserializeApplicationData(data);
  if (rumor.pubkey.toLowerCase() !== senderPubkeyHex.toLowerCase()) {
    throw new Error(
      `Application event pubkey ${rumor.pubkey} does not match authenticated MLS sender ${senderPubkeyHex}`,
    );
  }
  return rumor;
}

/** @deprecated Kept for internal compatibility. Prefer `deserializeApplicationData`. */
export const deserializeApplicationRumor = deserializeApplicationData;
