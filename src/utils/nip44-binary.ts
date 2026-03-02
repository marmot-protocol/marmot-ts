/**
 * NIP-44 v2 encryption with binary (Uint8Array) plaintext support.
 *
 * Functionally identical to NIP-44 v2 but the pad/unpad layer operates on raw
 * bytes instead of UTF-8 strings, removing the need to hex/base64-encode
 * binary payloads (e.g. TLS-serialized MLSMessages) before encryption.
 *
 * The wire format and conversation-key derivation are 100% compatible with
 * standard NIP-44 v2 – only the plaintext interpretation differs.
 */

import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  expand as hkdf_expand,
  extract as hkdf_extract,
} from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

const minPlaintextSize = 0x0001; // 1 byte
const maxPlaintextSize = 0xffff; // 64 KiB − 1

/**
 * Derives a NIP-44 v2 conversation key from a secp256k1 private key and
 * the hex-encoded x-only public key of the other party.
 */
export function getConversationKey(
  privkeyA: Uint8Array,
  pubkeyB: string,
): Uint8Array {
  const sharedX = secp256k1
    .getSharedSecret(privkeyA, hexToBytes("02" + pubkeyB))
    .subarray(1, 33);
  return hkdf_extract(sha256, sharedX, new TextEncoder().encode("nip44-v2"));
}

function getMessageKeys(
  conversationKey: Uint8Array,
  nonce: Uint8Array,
): { chacha_key: Uint8Array; chacha_nonce: Uint8Array; hmac_key: Uint8Array } {
  const keys = hkdf_expand(sha256, conversationKey, nonce, 76);
  return {
    chacha_key: keys.subarray(0, 32),
    chacha_nonce: keys.subarray(32, 44),
    hmac_key: keys.subarray(44, 76),
  };
}

function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1)
    throw new Error("expected positive integer");
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function writeU16BE(num: number): Uint8Array {
  if (
    !Number.isSafeInteger(num) ||
    num < minPlaintextSize ||
    num > maxPlaintextSize
  )
    throw new Error(
      "invalid plaintext size: must be between 1 and 65535 bytes",
    );
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, num, false);
  return arr;
}

/** Pads raw bytes using the NIP-44 v2 padding scheme. */
function padBytes(data: Uint8Array): Uint8Array {
  const unpaddedLen = data.length;
  const prefix = writeU16BE(unpaddedLen);
  const suffix = new Uint8Array(calcPaddedLen(unpaddedLen) - unpaddedLen);
  return concatBytes(prefix, data, suffix);
}

/** Removes NIP-44 v2 padding and returns the raw plaintext bytes. */
function unpadBytes(padded: Uint8Array): Uint8Array {
  const unpaddedLen = (padded[0] << 8) | padded[1];
  const unpadded = padded.subarray(2, 2 + unpaddedLen);
  if (
    unpaddedLen < minPlaintextSize ||
    unpaddedLen > maxPlaintextSize ||
    unpadded.length !== unpaddedLen ||
    padded.length !== 2 + calcPaddedLen(unpaddedLen)
  )
    throw new Error("invalid padding");
  return unpadded;
}

function hmacAad(
  key: Uint8Array,
  message: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (aad.length !== 32)
    throw new Error("AAD associated data must be 32 bytes");
  return hmac(sha256, key, concatBytes(aad, message));
}

function decodePayload(payload: string): {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  mac: Uint8Array;
} {
  if (typeof payload !== "string")
    throw new Error("payload must be a valid string");
  const plen = payload.length;
  if (plen < 132 || plen > 87472)
    throw new Error("invalid payload length: " + plen);
  if (payload[0] === "#") throw new Error("unknown encryption version");
  let data: Uint8Array;
  try {
    data = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  } catch (error) {
    throw new Error(
      "invalid base64: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const dlen = data.length;
  if (dlen < 99 || dlen > 65603)
    throw new Error("invalid data length: " + dlen);
  const vers = data[0];
  if (vers !== 2) throw new Error("unknown encryption version " + vers);
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, -32),
    mac: data.subarray(-32),
  };
}

/**
 * Encrypts a raw byte array using NIP-44 v2.
 *
 * @param plaintext - The binary data to encrypt
 * @param conversationKey - 32-byte conversation key (from {@link getConversationKey})
 * @param nonce - Optional 32-byte nonce (randomly generated if omitted)
 * @returns Base64-encoded NIP-44 v2 payload
 */
export function encryptBytes(
  plaintext: Uint8Array,
  conversationKey: Uint8Array,
  nonce: Uint8Array = randomBytes(32),
): string {
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(
    conversationKey,
    nonce,
  );
  const padded = padBytes(plaintext);
  const ciphertext = chacha20(chacha_key, chacha_nonce, padded);
  const mac = hmacAad(hmac_key, ciphertext, nonce);
  return btoa(
    String.fromCharCode(
      ...concatBytes(new Uint8Array([2]), nonce, ciphertext, mac),
    ),
  );
}

/**
 * Decrypts a NIP-44 v2 payload back to raw bytes.
 *
 * @param payload - Base64-encoded NIP-44 v2 payload
 * @param conversationKey - 32-byte conversation key (from {@link getConversationKey})
 * @returns The decrypted binary data
 */
export function decryptBytes(
  payload: string,
  conversationKey: Uint8Array,
): Uint8Array {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(
    conversationKey,
    nonce,
  );
  const calculatedMac = hmacAad(hmac_key, ciphertext, nonce);
  if (!equalBytes(calculatedMac, mac)) throw new Error("invalid MAC");
  const padded = chacha20(chacha_key, chacha_nonce, ciphertext);
  return unpadBytes(padded);
}
