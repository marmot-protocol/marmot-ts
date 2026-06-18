/** @module @category Core - Group Messages */
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
 * Deserializes application data bytes back into a rumor.
 *
 * @param data - The serialized application data
 * @returns The deserialized Rumor
 */
export function deserializeApplicationData(data: Uint8Array): Rumor {
  // Decode UTF-8 bytes to string
  const json = new TextDecoder().decode(data);
  // Parse JSON
  const parsed = JSON.parse(json);

  // Validate it's a rumor-like object
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid application data: not an object");
  }

  // Check required fields for a rumor
  if (!parsed.id || !parsed.pubkey || parsed.kind === undefined) {
    throw new Error("Invalid application data: missing required fields");
  }

  return parsed as Rumor;
}

/** @deprecated Kept for internal compatibility. Prefer `deserializeApplicationData`. */
export const deserializeApplicationRumor = deserializeApplicationData;
