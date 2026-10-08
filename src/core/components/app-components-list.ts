/** @module @category Core - App Components */
import { BinaryReader, BinaryWriter } from "../binary.js";
import type { AppComponentId } from "./ids.js";

/**
 * Codec for the upstream `app_components` component (`0x0001`) `data` payload:
 * the sorted, unique list of component ids a member supports (in a LeafNode) or
 * a group requires (in the GroupContext).
 *
 * Wire (Marmot binary profile):
 *   ComponentID component_ids<V>;   // QUIC-varint byte length, then be-uint16 ids
 *
 * Ids are encoded ascending and MUST be unique.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_components_list`
 */

/** Encodes a set of component ids to the `app_components` data payload. */
export function encodeComponentsList(
  ids: Iterable<AppComponentId>,
): Uint8Array {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const items = sorted.map((id) => new BinaryWriter().uint16(id).build());
  return new BinaryWriter().vector(items).build();
}

/**
 * Decodes an `app_components` data payload into a sorted, unique id list.
 *
 * Rejects duplicate ids and ids that are not in ascending order. The decoder
 * never sorts on the caller's behalf: non-canonical bytes are invalid
 * (`foundation/canonical-encoding.md`), and MDK's `decode_components_list`
 * rejects an unsorted list, so accepting one here would let the two
 * implementations disagree on the same GroupContext, LeafNode, or KeyPackage.
 */
export function decodeComponentsList(data: Uint8Array): AppComponentId[] {
  const reader = new BinaryReader(data);
  const seen = new Set<number>();
  let previous = -1;
  const ids = reader.vector((item) => {
    const id = item.uint16();
    if (seen.has(id)) {
      throw new Error(`duplicate component id ${id} in app_components list`);
    }
    if (id < previous) {
      throw new Error("app_components list is not sorted ascending");
    }
    seen.add(id);
    previous = id;
    return id;
  });
  reader.end();
  return ids;
}
