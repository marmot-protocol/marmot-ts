/** @module @category Client - Group Media */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { CiphersuiteImpl, ClientState } from "ts-mls";

import {
  canonicalizeMimeType,
  decryptMediaFile,
  mediaSourceStateToken,
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
  assertOpen?: () => void;
  /**
   * The still-retained canonical states, used to decrypt
   * media from an epoch older than the current tip. Optional — when omitted,
   * decryption uses only the current epoch's key. See
   * {@link GroupMediaService.decryptMedia}.
   */
  getRetainedStates?: () => Iterable<ClientState>;
};

/**
 * Source-bound v2 encryption and verified plaintext cache writes.
 * Retained state is bounded by the existing session rollback policy.
 */
export class GroupMediaService<
  TMedia extends BaseGroupMedia | undefined = undefined,
> {
  readonly media: TMedia;

  readonly #assertOpen?: () => void;
  readonly #getState: () => ClientState;
  readonly #getCiphersuite: () => CiphersuiteImpl;
  readonly #getRetainedStates?: () => Iterable<ClientState>;
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  constructor(options: GroupMediaServiceOptions<TMedia>) {
    this.media = options.media;
    this.#assertOpen = options.assertOpen;
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
  ): Promise<{
    encrypted: Uint8Array;
    attachment: MediaAttachment;
    expectedParent: string;
  }> {
    this.#assertOpen?.();
    const sourceState = this.#getState();
    const expectedParent = mediaSourceStateToken(sourceState);
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
      sourceState,
      this.#getCiphersuite(),
      fields,
    );

    this.#assertOpen?.();
    return { ...encryptMediaFile(plaintext, fileKey, fields), expectedParent };
  }

  /**
   * Decrypt using the sourceParent supplied on the accepted application-message
   * result. Omission selects the current state only. Missing retained material
   * makes the attachment unavailable; it does not invalidate its message.
   * Cache contents never bypass cryptographic or metadata validation.
   */
  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
    sourceParent: string = mediaSourceStateToken(this.#getState()),
  ): Promise<StoredMedia> {
    this.#assertOpen?.();
    // Select the exact authenticated source, never probe unrelated epochs/forks.
    const state = [
      this.#getState(),
      ...(this.#getRetainedStates?.() ?? []),
    ].find((candidate) => mediaSourceStateToken(candidate) === sourceParent);
    if (!state) throw new Error("Media source material is no longer retained");
    // Verify supplied ciphertext and authenticated metadata even on cache hits.
    // Old hash-only cache entries are not evidence of a verified v2 reference.
    const key = attachment.ciphertextSha256;
    const identity = JSON.stringify([
      sourceParent,
      attachment.version,
      key,
      attachment.plaintextSha256,
      attachment.nonce,
      attachment.mediaType,
      attachment.filename,
      bytesToHex(sha256(encrypted)),
    ]);
    const inFlight = this.#decryptingMedia.get(identity);
    if (inFlight) return inFlight;
    const decryptPromise = (async () => {
      const fileKey = await deriveMediaEncryptionKey(
        state,
        this.#getCiphersuite(),
        attachment,
      );
      const plaintext = decryptMediaFile(encrypted, fileKey, attachment);
      this.#assertOpen?.();
      await this.media?.addMedia(key, {
        data: plaintext,
        attachment,
      });

      this.#assertOpen?.();
      return { data: plaintext, attachment };
    })();

    this.#decryptingMedia.set(identity, decryptPromise);

    try {
      return await decryptPromise;
    } finally {
      this.#decryptingMedia.delete(identity);
    }
  }
}
