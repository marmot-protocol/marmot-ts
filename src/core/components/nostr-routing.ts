/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";
import { isValidRelayUrl } from "../../utils/relay-url.js";
import { compareBytes } from "./internal.js";

/**
 * Codec for `marmot.transport.nostr.routing.v1` (`0x8004`) — the public Nostr
 * group id and the relay set used to route the group's transport. Replaces the
 * `nostr_group_id`/`relays` fields of the legacy `marmot_group_data` monolith.
 *
 * Wire (Marmot binary profile):
 *   opaque nostr_group_id[32];     // fixed 32 bytes, no length prefix
 *   MarmotNostrRelayV1 relays<V>;  // QUIC-varint byte length over the entries
 *   // each MarmotNostrRelayV1 = opaque url<1..512>   (QUIC-varint length + UTF-8)
 *
 * Relays are sorted ascending by raw UTF-8 byte value, MUST be unique, and the
 * list MUST be non-empty. The decoder re-checks sort + uniqueness.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_nostr_routing_v1`
 * @see Marmot v2 spec: `app-components/nostr-routing-v1.md`
 */

const NOSTR_GROUP_ID_BYTES = 32;
const RELAY_URL_MAX_BYTES = 512;

export interface NostrRoutingV1 {
  nostrGroupId: Uint8Array;
  relays: string[];
}

function validateRelay(url: string): void {
  if (encodeUtf8(url).length > RELAY_URL_MAX_BYTES) {
    throw new Error("Nostr relay URL exceeds 512 bytes");
  }
  if (!isValidRelayUrl(url)) throw new Error("Invalid relay URL");
}

/** Encodes a {@link NostrRoutingV1} to its component `data` bytes. */
export function encodeNostrRoutingV1(routing: NostrRoutingV1): Uint8Array {
  if (routing.nostrGroupId.length !== NOSTR_GROUP_ID_BYTES) {
    throw new Error("nostr_group_id must be exactly 32 bytes");
  }

  // Sort by UTF-8 bytes + dedup to match the canonical Rust ordering.
  const encoded = routing.relays.map(
    (r) => [r, encodeUtf8(r)] as [string, Uint8Array],
  );
  encoded.sort((a, b) => compareBytes(a[1], b[1]));
  const relays: string[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (i > 0 && compareBytes(encoded[i - 1][1], encoded[i][1]) === 0) continue;
    relays.push(encoded[i][0]);
  }
  if (relays.length === 0) {
    throw new Error("Nostr routing must contain at least one relay");
  }
  for (const relay of relays) validateRelay(relay);

  const items = relays.map((r) =>
    new BinaryWriter()
      .opaque(encodeUtf8(r), { max: RELAY_URL_MAX_BYTES })
      .build(),
  );
  return new BinaryWriter().bytes(routing.nostrGroupId).vector(items).build();
}

/** Decodes `marmot.transport.nostr.routing.v1` component `data` bytes. */
export function decodeNostrRoutingV1(data: Uint8Array): NostrRoutingV1 {
  const reader = new BinaryReader(data);
  const nostrGroupId = reader.bytes(NOSTR_GROUP_ID_BYTES);
  const relayBytes: Uint8Array[] = [];
  const relays = reader.vector((item) => {
    const bytes = item.opaque({ max: RELAY_URL_MAX_BYTES });
    if (bytes.length === 0)
      throw new Error("Nostr relay URL must not be empty");
    relayBytes.push(bytes);
    return decodeUtf8(bytes);
  });
  reader.end();

  if (relays.length === 0) {
    throw new Error("Nostr routing must contain at least one relay");
  }
  for (let i = 1; i < relayBytes.length; i++) {
    const cmp = compareBytes(relayBytes[i - 1], relayBytes[i]);
    if (cmp === 0) throw new Error("Nostr relay URLs must be unique");
    if (cmp > 0) throw new Error("Nostr relay URLs must be sorted");
  }
  for (const relay of relays) validateRelay(relay);

  return { nostrGroupId, relays };
}
