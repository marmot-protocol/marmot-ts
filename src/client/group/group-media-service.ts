/** @module @category Client - Group Media */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CiphersuiteImpl, ClientState } from "ts-mls";

import {
  canonicalizeMimeType,
  decryptMediaFile,
  deriveMediaEncryptionKey,
  encryptMediaFile,
  type MediaAttachment,
  MIP04_VERSION,
} from "../../core/media.js";
import type { BaseGroupMedia, StoredMedia } from "./marmot-group.js";

export type EncryptMediaMetadata = {
  filename: string;
  type?: string;
  dimensions?: string;
  blurhash?: string;
  alt?: string;
  size?: number;
};

export type GroupMediaServiceOptions<
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  media: TMedia;
  getState: () => ClientState;
  getCiphersuite: () => CiphersuiteImpl;
};

/** Optional group-scoped encrypted media helper and plaintext cache adapter. */
export class GroupMediaService<
  TMedia extends BaseGroupMedia | undefined = undefined,
> {
  readonly media: TMedia;

  readonly #getState: () => ClientState;
  readonly #getCiphersuite: () => CiphersuiteImpl;
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  constructor(options: GroupMediaServiceOptions<TMedia>) {
    this.media = options.media;
    this.#getState = options.getState;
    this.#getCiphersuite = options.getCiphersuite;
  }

  async encryptMedia(
    blob: Blob,
    metadata: EncryptMediaMetadata,
  ): Promise<{ encrypted: Uint8Array; attachment: MediaAttachment }> {
    const mimeType = metadata.type ?? blob.type;
    if (!mimeType) {
      throw new Error(
        "encryptMedia: MIME type is required — pass metadata.type or ensure blob.type is set",
      );
    }

    const plaintext = new Uint8Array(await blob.arrayBuffer());
    const plaintextHash = bytesToHex(sha256(plaintext));

    const skeleton: MediaAttachment = {
      sha256: plaintextHash,
      type: canonicalizeMimeType(mimeType),
      filename: metadata.filename,
      nonce: "",
      version: MIP04_VERSION,
      size: metadata.size ?? blob.size,
      ...(metadata.dimensions !== undefined
        ? { dimensions: metadata.dimensions }
        : {}),
      ...(metadata.blurhash !== undefined
        ? { blurhash: metadata.blurhash }
        : {}),
      ...(metadata.alt !== undefined ? { alt: metadata.alt } : {}),
    };

    const fileKey = await deriveMediaEncryptionKey(
      this.#getState(),
      this.#getCiphersuite(),
      skeleton,
    );

    return encryptMediaFile(plaintext, fileKey, skeleton);
  }

  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
  ): Promise<StoredMedia> {
    if (!attachment.sha256) {
      throw new Error("decryptMedia: attachment.sha256 is required");
    }

    const cached = await this.media?.getMedia(attachment.sha256);
    if (cached) return cached;

    const inFlight = this.#decryptingMedia.get(attachment.sha256);
    if (inFlight) return inFlight;

    const decryptPromise = (async () => {
      const fileKey = await deriveMediaEncryptionKey(
        this.#getState(),
        this.#getCiphersuite(),
        attachment,
      );
      const plaintext = decryptMediaFile(encrypted, fileKey, attachment);

      await this.media?.addMedia(attachment.sha256, {
        data: plaintext,
        attachment,
      });

      return { data: plaintext, attachment };
    })();

    this.#decryptingMedia.set(attachment.sha256, decryptPromise);

    try {
      return await decryptPromise;
    } finally {
      this.#decryptingMedia.delete(attachment.sha256);
    }
  }
}
