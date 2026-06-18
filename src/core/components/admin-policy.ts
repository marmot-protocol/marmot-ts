/** @module @category Core - App Components */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { BinaryReader, BinaryWriter } from "../binary.js";
import { compareBytes } from "./bytes.js";

/**
 * Codec for `marmot.group.admin-policy.v1` (`0x8003`) — the set of group admin
 * x-only public keys. Replaces the `admin_pubkeys` field of the legacy
 * `marmot_group_data` monolith.
 *
 * Wire (Marmot binary profile):
 *   MarmotAdminKeyV1 admins<V>;   // QUIC-varint byte length over the concatenation
 *   // each MarmotAdminKeyV1 = opaque xonly_pubkey[32]  (fixed, no per-key prefix)
 *
 * Keys are sorted ascending by raw byte value, MUST be unique, and the list
 * MUST be non-empty. The decoder re-checks sort + uniqueness.
 *
 * @see darkmatter `crates/cgka-engine/src/app_components.rs` `encode_admin_policy`
 * @see Marmot v2 spec: `app-components/admin-policy-v1.md`
 */

const ADMIN_KEY_BYTES = 32;

function isHexKey(str: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(str);
}

/** Encodes a list of admin x-only pubkeys (64-char hex) to component `data`. */
export function encodeAdminPolicyV1(adminPubkeys: string[]): Uint8Array {
  for (const pk of adminPubkeys) {
    if (!isHexKey(pk)) throw new Error("Invalid admin public key format");
  }
  const sorted = adminPubkeys.map((pk) => hexToBytes(pk)).sort(compareBytes);
  // Sort + dedup to match the canonical Rust ordering (consecutive == all dups
  // after sorting).
  const keys: Uint8Array[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && compareBytes(sorted[i - 1], sorted[i]) === 0) continue;
    keys.push(sorted[i]);
  }
  if (keys.length === 0) {
    throw new Error("admin-policy must contain at least one admin");
  }

  const concat = new Uint8Array(keys.length * ADMIN_KEY_BYTES);
  keys.forEach((k, i) => concat.set(k, i * ADMIN_KEY_BYTES));
  return new BinaryWriter().opaque(concat).build();
}

/** Decodes `marmot.group.admin-policy.v1` component `data` bytes to hex keys. */
export function decodeAdminPolicyV1(data: Uint8Array): string[] {
  const reader = new BinaryReader(data);
  const concat = reader.opaque();
  reader.end();

  if (concat.length === 0) {
    throw new Error("admin-policy must contain at least one admin");
  }
  if (concat.length % ADMIN_KEY_BYTES !== 0) {
    throw new Error("admin_pubkeys length must be a multiple of 32");
  }

  const keys: Uint8Array[] = [];
  for (let i = 0; i < concat.length; i += ADMIN_KEY_BYTES) {
    keys.push(concat.slice(i, i + ADMIN_KEY_BYTES));
  }
  for (let i = 1; i < keys.length; i++) {
    const cmp = compareBytes(keys[i - 1], keys[i]);
    if (cmp === 0) throw new Error("admin_pubkeys must be unique");
    if (cmp > 0) throw new Error("admin_pubkeys must be sorted");
  }
  return keys.map((k) => bytesToHex(k));
}
