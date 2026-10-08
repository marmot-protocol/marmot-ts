/** @module @category Core - Group Messages */
import { getEventHash } from "applesauce-core/helpers/event";
import { Rumor } from "applesauce-common/helpers/gift-wrap";

/**
 * Serializes an application rumor (unsigned Nostr event) to bytes.
 * This is the format used for application messages in Marmot groups.
 *
 * Only the six members a Marmot app event may carry are written
 * (`foundation/application-messages.md` §Encoding), so a signed event or an
 * object with extra fields does not leak a `sig` or unknown member onto the
 * wire. The result is checked with {@link deserializeApplicationData}: a
 * payload every conformant receiver would drop (wrong `id`, non-integer
 * `created_at`, unpaired surrogate in a string, ...) throws here instead of
 * being sent.
 *
 * @param rumor - The unsigned Nostr event to serialize
 * @returns The serialized application data as bytes
 * @throws if the rumor would not decode as a valid Marmot app event
 */
export function serializeApplicationRumor(rumor: Rumor): Uint8Array {
  const json = JSON.stringify({
    id: rumor.id,
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  });
  const bytes = new TextEncoder().encode(json);
  deserializeApplicationData(bytes);
  return bytes;
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

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
/** A JSON number token that is a plain non-negative integer (no sign, fraction or exponent). */
const UNSIGNED_INTEGER_TOKEN = /^(0|[1-9][0-9]*)$/;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** JSON insignificant whitespace (RFC 8259 §2). */
function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(json: string, index: number): number {
  while (isJsonWhitespace(json[index])) index++;
  return index;
}

/** Index just past the JSON string literal starting at `index` (an opening quote). */
function endOfString(json: string, index: number): number {
  index++;
  while (json[index] !== '"') index += json[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** Index just past the JSON value starting at `index`. */
function endOfValue(json: string, index: number): number {
  const first = json[index];
  if (first === '"') return endOfString(json, index);
  if (first === "{" || first === "[") {
    let depth = 0;
    while (true) {
      const char = json[index];
      if (char === '"') {
        index = endOfString(json, index);
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
  }
  while (
    index < json.length &&
    json[index] !== "," &&
    json[index] !== "}" &&
    json[index] !== "]" &&
    !isJsonWhitespace(json[index])
  )
    index++;
  return index;
}

/**
 * Lists the members of the top-level JSON object in `json` with their key and
 * raw value text, in document order and including duplicates. `json` must
 * already have parsed successfully as an object; this only walks it.
 *
 * `JSON.parse` keeps the last of duplicate keys and turns `1.0`/`1e3` into the
 * same number as `1`, so these two rules are checked against the source text.
 */
function topLevelMembers(json: string): { key: string; raw: string }[] {
  const members: { key: string; raw: string }[] = [];
  let index = skipWhitespace(json, 0) + 1; // past "{"
  index = skipWhitespace(json, index);
  if (json[index] === "}") return members;
  while (true) {
    index = skipWhitespace(json, index);
    const keyEnd = endOfString(json, index);
    const key = JSON.parse(json.slice(index, keyEnd)) as string;
    index = skipWhitespace(json, keyEnd) + 1; // past ":"
    index = skipWhitespace(json, index);
    const valueEnd = endOfValue(json, index);
    members.push({ key, raw: json.slice(index, valueEnd) });
    index = skipWhitespace(json, valueEnd);
    if (json[index] !== ",") return members;
    index++;
  }
}

/** True when `value` has no unpaired UTF-16 surrogate (i.e. it is valid Unicode text). */
function isWellFormedString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Deserializes application data bytes back into a rumor, enforcing the Marmot
 * inner-event encoding rules (`foundation/application-messages.md` §Encoding).
 *
 * Strict decode, matching what MDK accepts (`cgka-traits` `MarmotAppEvent::decode`):
 * - the bytes are valid UTF-8 and one JSON object;
 * - the object carries exactly the six members `id, pubkey, created_at, kind,
 *   tags, content` — no `sig`, no unknown member, no duplicate key;
 * - `created_at` and `kind` are plain non-negative JSON integers;
 * - `pubkey` and `id` are 64 lowercase hex characters, `tags` is an array of
 *   string arrays, and no string carries an unpaired surrogate;
 * - `id` equals the canonical NIP-01 event id recomputed from the other
 *   members (lowercase-hex SHA-256 of `[0, pubkey, created_at, kind, tags,
 *   content]`).
 *
 * This is the integrity half of the authorship checks; the {@link
 * verifyApplicationRumorAuthorship} layer adds the MLS-sender binding.
 *
 * @param data - The serialized application data
 * @returns The deserialized, id-verified Rumor
 * @throws if the bytes are not a strictly-conformant, id-consistent rumor
 */
export function deserializeApplicationData(data: Uint8Array): Rumor {
  let json: string;
  try {
    json = utf8Decoder.decode(data);
  } catch {
    throw new Error("Invalid application data: not valid UTF-8");
  }
  const parsed = JSON.parse(json);

  // Validate it's a rumor-like object
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid application data: not an object");
  }

  const members = topLevelMembers(json);
  const seen = new Set<string>();
  for (const { key } of members) {
    // Rejects `sig` and any other member outside the canonical set.
    if (!(ALLOWED_RUMOR_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Invalid application data: unexpected member "${key}"`);
    }
    if (seen.has(key)) {
      throw new Error(`Invalid application data: duplicate member "${key}"`);
    }
    seen.add(key);
  }
  for (const key of ALLOWED_RUMOR_KEYS) {
    if (!seen.has(key)) {
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

  for (const { key, raw } of members) {
    if (key !== "created_at" && key !== "kind") continue;
    if (
      !UNSIGNED_INTEGER_TOKEN.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    ) {
      throw new Error(
        `Invalid application data: ${key} must be a non-negative integer, got ${raw}`,
      );
    }
  }

  if (!LOWER_HEX_64.test(parsed.pubkey)) {
    throw new Error(
      "Invalid application data: pubkey must be 64 lowercase hex characters",
    );
  }
  if (!LOWER_HEX_64.test(parsed.id)) {
    throw new Error(
      "Invalid application data: id must be 64 lowercase hex characters",
    );
  }

  for (const tag of parsed.tags as unknown[]) {
    if (
      !Array.isArray(tag) ||
      !tag.every(
        (value) => typeof value === "string" && isWellFormedString(value),
      )
    ) {
      throw new Error(
        "Invalid application data: tags must be arrays of strings",
      );
    }
  }
  if (!isWellFormedString(parsed.content)) {
    throw new Error(
      "Invalid application data: content contains an unpaired surrogate",
    );
  }

  // The `id` MUST equal the canonical NIP-01 event id computed from the other
  // members; getEventHash performs the exact `[0, pubkey, created_at, kind,
  // tags, content]` serialization + SHA-256.
  const canonicalId = getEventHash(parsed as Rumor);
  if (parsed.id !== canonicalId) {
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
  // The decoder already required a lowercase pubkey.
  if (rumor.pubkey !== senderPubkeyHex.toLowerCase()) {
    throw new Error(
      `Application event pubkey ${rumor.pubkey} does not match authenticated MLS sender ${senderPubkeyHex}`,
    );
  }
  return rumor;
}

/** @deprecated Kept for internal compatibility. Prefer `deserializeApplicationData`. */
export const deserializeApplicationRumor = deserializeApplicationData;
