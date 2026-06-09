/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";

/**
 * Codec for `marmot.group.profile.v1` (`0x8001`) — the group's display name and
 * description. Replaces the `name`/`description` fields of the legacy
 * `marmot_group_data` monolith.
 *
 * Wire (Marmot binary profile, `encode_component_vectors([name, description])`):
 *   opaque name<0..256>;          // QUIC-varint length + UTF-8 bytes
 *   opaque description<0..4096>;  // QUIC-varint length + UTF-8 bytes
 *
 * @see darkmatter `crates/cgka-engine/src/app_components.rs` `encode_group_profile`
 * @see Marmot v2 spec: `app-components/group-profile-v1.md`
 */

/** Maximum UTF-8 byte length of the group name. */
export const GROUP_NAME_MAX_BYTES = 256;
/** Maximum UTF-8 byte length of the group description. */
export const GROUP_DESCRIPTION_MAX_BYTES = 4096;

export interface GroupProfileV1 {
  name: string;
  description: string;
}

/** Encodes a {@link GroupProfileV1} to its component `data` bytes. */
export function encodeGroupProfileV1(profile: GroupProfileV1): Uint8Array {
  const name = encodeUtf8(profile.name);
  const description = encodeUtf8(profile.description);
  return new BinaryWriter()
    .opaque(name, { max: GROUP_NAME_MAX_BYTES })
    .opaque(description, { max: GROUP_DESCRIPTION_MAX_BYTES })
    .build();
}

/** Decodes `marmot.group.profile.v1` component `data` bytes. */
export function decodeGroupProfileV1(data: Uint8Array): GroupProfileV1 {
  const reader = new BinaryReader(data);
  const name = decodeUtf8(reader.opaque({ max: GROUP_NAME_MAX_BYTES }));
  const description = decodeUtf8(
    reader.opaque({ max: GROUP_DESCRIPTION_MAX_BYTES }),
  );
  reader.end();
  return { name, description };
}
