/**
 * MIP-01 group image encryption and Blossom upload identity helpers.
 *
 * Provides ChaCha20-Poly1305 encryption/decryption for the group avatar image
 * stored on Blossom, and HKDF-based derivation of the Nostr keypair used to
 * authenticate uploads and deletions.
 *
 * No HTTP client is included. Callers are responsible for uploading encrypted
 * blobs to Blossom (or any content-addressed store).
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  expand as hkdf_expand,
  extract as hkdf_extract,
} from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import {
  finalizeEvent,
  getPublicKey,
  type NostrEvent,
} from "applesauce-core/helpers";

import { unixNow } from "../utils/nostr.js";
import type { MarmotGroupData } from "./protocol.js";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

const EMPTY_HKDF_SALT = new Uint8Array(0);

/** HKDF info label for MIP-01 v2 image encryption key derivation. */
const MIP01_IMAGE_ENCRYPTION_LABEL = enc.encode("mip01-image-encryption-v2");

/** HKDF info label for MIP-01 v2 Blossom upload keypair derivation. */
const MIP01_BLOSSOM_LABEL = enc.encode("mip01-blossom-upload-v2");

function deriveMIP01Key(seed: Uint8Array, info: Uint8Array): Uint8Array {
  const prk = hkdf_extract(sha256, seed, EMPTY_HKDF_SALT);
  return hkdf_expand(sha256, prk, info, 32);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of {@link encryptGroupImage}.
 *
 * All byte fields are ready to store in `MarmotGroupData` and/or upload to
 * a Blossom server. `imageKey` and `imageUploadKey` are secret — treat them
 * accordingly.
 */
export type EncryptGroupImageResult = {
  /** The encrypted image bytes. Upload this blob to Blossom. */
  encrypted: Uint8Array;
  /** Metadata fields ready to merge into `MarmotGroupData`. */
  metadata: GroupImageMetadataFields;
};

/**
 * Result of {@link deriveGroupImageBlossomAuthKeypair}.
 */
export type GroupImageBlossomAuthKeypair = {
  /** 32-byte secp256k1 secret key for signing Blossom upload/delete requests. */
  secretKey: Uint8Array;
  /** Hex-encoded x-only secp256k1 public key (64 characters). */
  pubkey: string;
};

/** JSON response returned by Blossom `PUT /upload` endpoints (BUD-02). */
export type BlossomBlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
};

/** The subset of {@link MarmotGroupData} updated by a successful image upload. */
export type GroupImageMetadataFields = Pick<
  MarmotGroupData,
  "imageHash" | "imageKey" | "imageNonce" | "imageUploadKey"
>;

/** Result of uploading a group image to one or more Blossom servers. */
export type UploadGroupImageResult = {
  /** The encrypted image bytes uploaded to each server. */
  encrypted: Uint8Array;
  /** The returned blob descriptor from each upload target. */
  uploads: PromiseSettledResult<{
    server: URL;
    descriptor: BlossomBlobDescriptor;
  }>[];
  /** Metadata fields ready to merge into `MarmotGroupData`. */
  metadata: GroupImageMetadataFields;
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Encrypts a group image using ChaCha20-Poly1305 (MIP-01).
 *
 * Generates cryptographically random image and upload seeds, derives the
 * ChaCha20-Poly1305 key with HKDF-SHA256, and encrypts the image. All output
 * fields should be stored in `MarmotGroupData` via an MLS proposal/commit.
 *
 * @param imageData - The raw image bytes to encrypt
 * @returns Encryption outputs ready to store in `MarmotGroupData`
 */
export function encryptGroupImage(
  imageData: Uint8Array,
): EncryptGroupImageResult {
  const imageKey = randomBytes(32);
  const imageNonce = randomBytes(12);
  const imageUploadKey = randomBytes(32);
  const encryptionKey = deriveMIP01Key(imageKey, MIP01_IMAGE_ENCRYPTION_LABEL);

  const encrypted = chacha20poly1305(encryptionKey, imageNonce).encrypt(
    imageData,
  );

  // Calculate the hash of the encrypted image
  const imageHash = sha256(encrypted);

  // Create an object all all MIP-01 metadata fields
  const metadata: GroupImageMetadataFields = {
    imageHash: imageHash,
    imageKey: imageKey,
    imageNonce: imageNonce,
    imageUploadKey: imageUploadKey,
  };

  return { encrypted, metadata };
}

/**
 * Decrypts a group image using fields from `MarmotGroupData` (MIP-01).
 *
 * @param encrypted - The encrypted blob downloaded from Blossom
 * @param imageKey - `MarmotGroupData.imageKey` (32 bytes)
 * @param imageNonce - `MarmotGroupData.imageNonce` (12 bytes)
 * @returns The decrypted image bytes
 * @throws If AEAD authentication or decryption fails
 */
export function decryptGroupImage(
  encrypted: Uint8Array,
  metadata: Pick<GroupImageMetadataFields, "imageKey" | "imageNonce">,
): Uint8Array {
  const encryptionKey = deriveMIP01Key(
    metadata.imageKey,
    MIP01_IMAGE_ENCRYPTION_LABEL,
  );
  return chacha20poly1305(encryptionKey, metadata.imageNonce).decrypt(
    encrypted,
  );
}

/**
 * Derives the Nostr keypair used to authenticate Blossom upload/delete
 * requests for a group image (MIP-01).
 *
 * Derivation:
 * ```
 * prk = HKDF-Extract-SHA256(salt="", IKM=imageUploadKey)
 * upload_secret = HKDF-Expand-SHA256(prk, "mip01-blossom-upload-v2", 32)
 * upload_keypair = secp256k1_keypair_from_secret(upload_secret)
 * ```
 *
 * The function exists so callers can derive the keypair from a previously
 * stored `imageUploadKey` — for example, to delete an old image blob from
 * Blossom after updating the group avatar.
 *
 * @param imageUploadKey - `MarmotGroupData.imageUploadKey` (32 bytes)
 * @returns The Blossom upload/delete keypair
 */
export function deriveGroupImageBlossomAuthKeypair(
  imageUploadKey: Uint8Array,
): GroupImageBlossomAuthKeypair {
  const secretKey = deriveMIP01Key(imageUploadKey, MIP01_BLOSSOM_LABEL);
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey };
}

export type UploadGroupImageOptions = {
  /** The raw image bytes to encrypt and upload. */
  imageData: Uint8Array;
  /** One or more Blossom server base URLs. */
  servers: string[];
  /** Optional fetch implementation for testing or custom runtimes. */
  fetchImplementation?: typeof fetch;
};

/**
 * Encrypts a group image, signs one BUD-11 auth event with the derived image
 * upload key, and uploads the encrypted blob to all supplied Blossom servers.
 */
export async function uploadGroupImage(
  options: UploadGroupImageOptions,
): Promise<UploadGroupImageResult> {
  const { imageData, servers, fetchImplementation = fetch } = options;

  if (servers.length === 0) {
    throw new Error("uploadGroupImage requires at least one Blossom server");
  }

  const { encrypted, metadata } = encryptGroupImage(imageData);

  const imageHashHex = bytesToHex(metadata.imageHash);
  const normalizedServers = servers.map((server) => new URL(server));
  const authEvent = createBlossomUploadAuthEvent({
    imageHashHex,
    imageUploadKey: metadata.imageUploadKey,
    servers: normalizedServers,
  });
  const authorizationHeader = `Nostr ${encodeAuthEvent(authEvent)}`;
  const uploadBody = Uint8Array.from(encrypted).buffer;

  const uploads = await Promise.allSettled(
    normalizedServers.map(async (server) => {
      const response = await fetchImplementation(new URL("/upload", server), {
        method: "PUT",
        headers: {
          Authorization: authorizationHeader,
          "X-SHA-256": imageHashHex,
        },
        body: uploadBody,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to upload group image to ${server.toString()}: ${response.status}`,
        );
      }

      const descriptor = (await response.json()) as BlossomBlobDescriptor;
      if (descriptor.sha256 !== imageHashHex) {
        throw new Error(
          `Blossom server returned mismatched sha256 for ${server.toString()}`,
        );
      }

      return { server, descriptor };
    }),
  );

  return {
    encrypted,
    uploads,
    metadata,
  };
}

function createBlossomUploadAuthEvent(args: {
  imageHashHex: string;
  imageUploadKey: Uint8Array;
  servers: URL[];
}): NostrEvent {
  const { imageHashHex, imageUploadKey } = args;
  const { secretKey } = deriveGroupImageBlossomAuthKeypair(imageUploadKey);
  const createdAt = unixNow();

  return finalizeEvent(
    {
      kind: 24242,
      created_at: createdAt,
      content: "",
      tags: [
        ["t", "upload"],
        ["expiration", String(createdAt + 300)],
        ["x", imageHashHex],
      ],
    },
    secretKey,
  );
}

function encodeAuthEvent(event: NostrEvent): string {
  const json = new TextEncoder().encode(JSON.stringify(event));
  return base64
    .encode(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
