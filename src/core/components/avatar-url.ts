/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";
import { validateAndNormalizeHttpsUrl } from "./url.js";

/**
 * Codec for `marmot.group.avatar-url.v1` (`0x8007`) — a small group avatar
 * pointer: an `https` URL plus optional `dim`/`thumbhash` render hints. An
 * empty `url` encodes the absent/cleared avatar (all fields empty).
 *
 * Wire (Marmot binary profile):
 *   opaque url<V>;        // QUIC-varint length + UTF-8; "" means absent
 *   opaque dim<V>;        // optional render hint, "" when absent
 *   opaque thumbhash<V>;  // optional render hint, "" when absent
 *
 * The URL is validated + normalized (`https` only, no credentials/fragment, not
 * localhost or a non-routable address); the decoder re-checks that a present
 * URL is already normalized.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_group_avatar_url_v1`
 */

const GROUP_AVATAR_URL_MAX_LEN = 2048;
const GROUP_AVATAR_HINT_MAX_LEN = 256;

export interface GroupAvatarUrlV1 {
  /** Normalized `https` avatar URL, or `""` for an absent/cleared avatar. */
  url: string;
  /** Optional render dimension hint (e.g. `"128x128"`). */
  dim?: string;
  /** Optional thumbhash render hint. */
  thumbhash?: string;
}

function normalizeUrl(url: string): string {
  return validateAndNormalizeHttpsUrl(url, {
    maxLen: GROUP_AVATAR_URL_MAX_LEN,
    label: "group avatar URL",
  });
}

/** Encodes a {@link GroupAvatarUrlV1} to its component `data` bytes. */
export function encodeGroupAvatarUrlV1(avatar: GroupAvatarUrlV1): Uint8Array {
  const dim = avatar.dim ?? "";
  const thumbhash = avatar.thumbhash ?? "";
  if (avatar.url === "" && (avatar.dim != null || avatar.thumbhash != null)) {
    throw new Error("group avatar absent state must not include hints");
  }
  const url = avatar.url === "" ? "" : normalizeUrl(avatar.url);
  if (encodeUtf8(dim).length > GROUP_AVATAR_HINT_MAX_LEN) {
    throw new Error(
      `group avatar dim exceeds ${GROUP_AVATAR_HINT_MAX_LEN} bytes`,
    );
  }
  if (encodeUtf8(thumbhash).length > GROUP_AVATAR_HINT_MAX_LEN) {
    throw new Error(
      `group avatar thumbhash exceeds ${GROUP_AVATAR_HINT_MAX_LEN} bytes`,
    );
  }
  return new BinaryWriter()
    .opaque(encodeUtf8(url), { max: GROUP_AVATAR_URL_MAX_LEN })
    .opaque(encodeUtf8(dim), { max: GROUP_AVATAR_HINT_MAX_LEN })
    .opaque(encodeUtf8(thumbhash), { max: GROUP_AVATAR_HINT_MAX_LEN })
    .build();
}

/**
 * Decodes a length-bounded opaque hint field. Presence is decided by the caller
 * on the raw bytes; here a non-UTF-8 hint is interpreted as ABSENT (`undefined`)
 * rather than rejected — matching darkmatter `String::from_utf8(..).ok()` in
 * `avatar_url.rs`. Rejecting it would fork commit acceptance.
 */
function decodeHintOrUndefined(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Decodes `marmot.group.avatar-url.v1` component `data` bytes. */
export function decodeGroupAvatarUrlV1(data: Uint8Array): GroupAvatarUrlV1 {
  const reader = new BinaryReader(data);
  const url = decodeUtf8(reader.opaque({ max: GROUP_AVATAR_URL_MAX_LEN }));
  const dimBytes = reader.opaque({ max: GROUP_AVATAR_HINT_MAX_LEN });
  const thumbhashBytes = reader.opaque({ max: GROUP_AVATAR_HINT_MAX_LEN });
  reader.end();

  // Presence is decided on the raw bytes: an absent state (empty url) must carry
  // no hint bytes at all — even non-UTF-8 ones (darkmatter avatar_url.rs).
  if (url === "" && (dimBytes.length > 0 || thumbhashBytes.length > 0)) {
    throw new Error("group avatar absent state must not include hints");
  }
  if (url !== "" && normalizeUrl(url) !== url) {
    throw new Error("group avatar URL is not normalized");
  }
  return {
    url,
    dim: decodeHintOrUndefined(dimBytes),
    thumbhash: decodeHintOrUndefined(thumbhashBytes),
  };
}
