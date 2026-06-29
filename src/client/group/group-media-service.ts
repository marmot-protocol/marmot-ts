/** @module @category Client - Group Media */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CiphersuiteImpl, ClientState } from "ts-mls";

import {
  canonicalizeMimeType,
  decryptMediaFileWithKeys,
  deriveMediaEncryptionKey,
  encryptMediaFile,
  type MediaAttachment,
} from "../../core/media.js";
import type { BaseGroupMedia, StoredMedia } from "./marmot-group.js";

export type EncryptMediaMetadata = {
  filename: string;
  /** MIME type; falls back to `blob.type` when omitted. */
  type?: string;
  /** Optional `<width>x<height>` render hint. */
  dim?: string;
  /** Optional thumbhash preview value. */
  thumbhash?: string;
};

export type GroupMediaServiceOptions<
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  media: TMedia;
  getState: () => ClientState;
  getCiphersuite: () => CiphersuiteImpl;
  /**
   * The still-retained canonical states (newest epoch first), used to decrypt
   * media from an epoch older than the current tip. Optional — when omitted,
   * decryption uses only the current epoch's key. See
   * {@link GroupMediaService.decryptMedia}.
   */
  getRetainedStates?: () => Iterable<ClientState>;
};

/**
 * Optional group-scoped encrypted-media helper and plaintext cache adapter.
 *
 * On send, the media file key is derived from the group's CURRENT `ClientState`
 * — the source epoch is the current epoch. On receive, the source epoch is the
 * MLS epoch of the message that carried the attachment, which is not encoded in
 * the `imeta` tag (`features/encrypted-media.md` — Key Derivation). Rather than
 * thread that epoch through every caller, {@link decryptMedia} derives one
 * candidate key per still-retained epoch and lets the AEAD tag pick the right
 * one, so media sent before the local tip advanced still decrypts. Media from
 * an epoch already pruned past the rollback horizon cannot be decrypted.
 */
export class GroupMediaService<
  TMedia extends BaseGroupMedia | undefined = undefined,
> {
  readonly media: TMedia;

  readonly #getState: () => ClientState;
  readonly #getCiphersuite: () => CiphersuiteImpl;
  readonly #getRetainedStates?: () => Iterable<ClientState>;
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  constructor(options: GroupMediaServiceOptions<TMedia>) {
    this.media = options.media;
    this.#getState = options.getState;
    this.#getCiphersuite = options.getCiphersuite;
    this.#getRetainedStates = options.getRetainedStates;
  }

  /**
   * Encrypts a blob for sharing in a group message. The returned attachment has
   * its hashes, nonce, media type, and filename set but no locators — the
   * caller uploads `encrypted` to a blob store, adds a {@link MediaAttachment}
   * locator, then serializes it with `encodeMediaImetaTag`.
   */
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
    const fields = {
      plaintextSha256: bytesToHex(sha256(plaintext)),
      mediaType: canonicalizeMimeType(mimeType),
      filename: metadata.filename,
      ...(metadata.dim !== undefined ? { dim: metadata.dim } : {}),
      ...(metadata.thumbhash !== undefined
        ? { thumbhash: metadata.thumbhash }
        : {}),
    };

    const fileKey = await deriveMediaEncryptionKey(
      this.#getState(),
      this.#getCiphersuite(),
      fields,
    );

    return encryptMediaFile(plaintext, fileKey, fields);
  }

  /**
   * Decrypts a fetched blob for a parsed attachment, verifying its ciphertext
   * and plaintext hashes, and caches the plaintext keyed by `ciphertextSha256`.
   *
   * The media file key is bound to the message's source-epoch media exporter
   * secret, which is not carried in the `imeta` tag. This derives one candidate
   * key per still-retained epoch (current epoch first) and lets the AEAD tag
   * select the right one, so media sent before the local tip advanced still
   * decrypts. Media from an epoch already pruned past the rollback horizon
   * cannot be decrypted.
   */
  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
  ): Promise<StoredMedia> {
    const key = attachment.ciphertextSha256;
    if (!key) {
      throw new Error("decryptMedia: attachment.ciphertextSha256 is required");
    }

    const cached = await this.media?.getMedia(key);
    if (cached) return cached;

    const inFlight = this.#decryptingMedia.get(key);
    if (inFlight) return inFlight;

    const decryptPromise = (async () => {
      const ciphersuite = this.#getCiphersuite();
      const states = this.#candidateStates();
      const fileKeys = await Promise.all(
        states.map((state) =>
          deriveMediaEncryptionKey(state, ciphersuite, attachment),
        ),
      );
      const plaintext = decryptMediaFileWithKeys(
        encrypted,
        fileKeys,
        attachment,
      );

      await this.media?.addMedia(key, {
        data: plaintext,
        attachment,
      });

      return { data: plaintext, attachment };
    })();

    this.#decryptingMedia.set(key, decryptPromise);

    try {
      return await decryptPromise;
    } finally {
      this.#decryptingMedia.delete(key);
    }
  }

  /**
   * The states whose media-exporter secrets to try, current epoch first, then
   * the remaining retained epochs, deduplicated by epoch. The current state is
   * always included even if retention is unavailable.
   */
  #candidateStates(): ClientState[] {
    const current = this.#getState();
    const states = [current];
    const seen = new Set<number>([Number(current.groupContext.epoch)]);
    for (const state of this.#getRetainedStates?.() ?? []) {
      const epoch = Number(state.groupContext.epoch);
      if (seen.has(epoch)) continue;
      seen.add(epoch);
      states.push(state);
    }
    return states;
  }
}
