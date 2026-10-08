/** @module @category Client - Group Media */
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { EventSigner } from "applesauce-core/factories";
import type { CiphersuiteImpl, ClientState } from "ts-mls";

import {
  getAppComponents,
  getComponentData,
  getEncryptedMediaPolicy,
  getEncryptedMediaPolicyV2,
} from "../../core/components/dictionary.js";
import {
  GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
} from "../../core/components/ids.js";
import {
  BLOSSOM_LOCATOR_KIND,
  canonicalizeMimeType,
  canonicalizeMimeTypeV2,
  decryptMediaFileWithKeys,
  deriveMediaEncryptionKey,
  ENCRYPTED_MEDIA_VERSION_V1,
  ENCRYPTED_MEDIA_VERSION_V2,
  encryptMediaFile,
  type EncryptedMediaPolicy,
  type EncryptedMediaVersion,
  type MediaAttachment,
  resolveMediaFetchUrls,
} from "../../core/media.js";
import {
  fetchBlossomBlob,
  type FetchLike,
  uploadBlossomBlobWithFallback,
} from "./blossom.js";
import type { BaseGroupMedia, StoredMedia } from "./marmot-group.js";

/**
 * Selects the media format for new references in a group from its
 * GroupContext, like MDK `encrypted_media_for_group`: `encrypted-media-v2` when
 * the group carries or requires `marmot.group.encrypted-media.v2` (`0x800b`),
 * `encrypted-media-v1` when it carries or requires only the frozen `0x8008`,
 * and `encrypted-media-v2` otherwise — every group this library joins is a
 * current-profile group, and current-profile senders create only v2
 * references (`features/encrypted-media.md` — Migration).
 */
export function selectGroupMediaVersion(
  state: ClientState,
): EncryptedMediaVersion {
  const extensions = state.groupContext.extensions;
  const has = (id: number) =>
    getComponentData(extensions, id) !== undefined ||
    (getAppComponents(extensions) ?? []).includes(id);
  if (has(GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID))
    return ENCRYPTED_MEDIA_VERSION_V2;
  if (has(GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID))
    return ENCRYPTED_MEDIA_VERSION_V1;
  return ENCRYPTED_MEDIA_VERSION_V2;
}

/**
 * The group's media policy for `version` (`0x800b` for v2, `0x8008` for v1),
 * or `undefined` when the group carries no such component.
 */
export function getGroupMediaPolicy(
  state: ClientState,
  version: EncryptedMediaVersion = selectGroupMediaVersion(state),
): EncryptedMediaPolicy | undefined {
  const extensions = state.groupContext.extensions;
  return version === ENCRYPTED_MEDIA_VERSION_V2
    ? getEncryptedMediaPolicyV2(extensions)
    : getEncryptedMediaPolicy(extensions);
}

export type EncryptMediaMetadata = {
  filename: string;
  /** MIME type; falls back to `blob.type` when omitted. */
  type?: string;
  /** Optional `<width>x<height>` render hint. */
  dim?: string;
  /** Optional thumbhash preview value. */
  thumbhash?: string;
  /**
   * Media format to produce. Defaults to the group's format
   * ({@link selectGroupMediaVersion}); set it only to interoperate with a
   * peer that needs a specific version.
   */
  version?: EncryptedMediaVersion;
};

export type UploadMediaOptions = {
  /**
   * Blossom servers to try in order. Defaults to the group policy's
   * `blossom-v1` `default_blob_endpoints`.
   */
  servers?: string[];
};

export type DownloadMediaOptions = {
  /** Allow cleartext-`http` loopback fetch candidates (local dev/test only). */
  allowLoopbackHttp?: boolean;
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
  /** Signs Blossom upload authorizations for {@link GroupMediaService.uploadMedia}. */
  getSigner?: () => EventSigner;
  /** HTTP client for upload/download; defaults to the global `fetch`. */
  fetch?: FetchLike;
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
  readonly #getSigner?: () => EventSigner;
  readonly #fetch?: FetchLike;
  readonly #decryptingMedia = new Map<string, Promise<StoredMedia>>();

  constructor(options: GroupMediaServiceOptions<TMedia>) {
    this.media = options.media;
    this.#getState = options.getState;
    this.#getCiphersuite = options.getCiphersuite;
    this.#getRetainedStates = options.getRetainedStates;
    this.#getSigner = options.getSigner;
    this.#fetch = options.fetch;
  }

  /** The media format new references in this group use. */
  get mediaVersion(): EncryptedMediaVersion {
    return selectGroupMediaVersion(this.#getState());
  }

  /** The group's current media policy for {@link mediaVersion}, if any. */
  get mediaPolicy(): EncryptedMediaPolicy | undefined {
    return getGroupMediaPolicy(this.#getState());
  }

  /**
   * Encrypts a blob for sharing in a group message, in the group's media
   * format ({@link mediaVersion}, normally `encrypted-media-v2`). The returned
   * attachment has its hashes, nonce, media type, and filename set but no
   * locators — the caller uploads `encrypted` to a blob store, adds a
   * {@link MediaAttachment} locator, then serializes it with
   * `encodeMediaImetaTag`. {@link uploadMedia} does both steps.
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

    const version = metadata.version ?? this.mediaVersion;
    const plaintext = new Uint8Array(await blob.arrayBuffer());
    if (plaintext.length === 0) {
      throw new Error("encryptMedia: media plaintext cannot be empty");
    }
    const fields = {
      version,
      plaintextSha256: bytesToHex(sha256(plaintext)),
      mediaType:
        version === ENCRYPTED_MEDIA_VERSION_V2
          ? canonicalizeMimeTypeV2(mimeType)
          : canonicalizeMimeType(mimeType),
      // v1 trims the filename (MDK); v2 preserves it byte-for-byte.
      filename:
        version === ENCRYPTED_MEDIA_VERSION_V2
          ? metadata.filename
          : metadata.filename.trim(),
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
   * Encrypts `blob` and uploads the ciphertext to Blossom (MDK
   * `upload_encrypted_media`): tries `opts.servers`, or else the group
   * policy's `blossom-v1` default endpoints, in order. Returns the attachment
   * with one `blossom-v1` locator, ready for `encodeMediaImetaTag`.
   *
   * The key is bound to the CURRENT epoch, so send the carrying message before
   * the group advances; a reference sent from a later epoch will not decrypt.
   *
   * @throws When no signer is configured, no endpoint is available, the
   *   group policy does not allow `blossom-v1`, or every upload fails.
   */
  async uploadMedia(
    blob: Blob,
    metadata: EncryptMediaMetadata,
    opts: UploadMediaOptions = {},
  ): Promise<{ encrypted: Uint8Array; attachment: MediaAttachment }> {
    const signer = this.#getSigner?.();
    if (!signer) throw new Error("uploadMedia: no signer configured");
    const policy = this.mediaPolicy;
    const allowed = policy?.allowedLocatorKinds ?? [BLOSSOM_LOCATOR_KIND];
    if (!allowed.includes(BLOSSOM_LOCATOR_KIND)) {
      throw new Error(
        "uploadMedia: the group media policy does not allow blossom-v1 locators",
      );
    }
    const servers =
      opts.servers ??
      (policy?.defaultBlobEndpoints ?? [])
        .filter((e) => e.locatorKind === BLOSSOM_LOCATOR_KIND)
        .map((e) => e.baseUrl);

    const { encrypted, attachment } = await this.encryptMedia(blob, metadata);
    const { url } = await uploadBlossomBlobWithFallback({
      servers,
      blob: encrypted,
      signer,
      fetch: this.#fetch,
    });
    attachment.locators.push({ kind: BLOSSOM_LOCATOR_KIND, value: url });
    return { encrypted, attachment };
  }

  /**
   * Fetches, verifies and decrypts a parsed attachment (MDK
   * `download_encrypted_media`). Candidates are the attachment's fetchable
   * locators followed by the group policy's fallback endpoints
   * (`resolveMediaFetchUrls`); the first body matching `ciphertextSha256` is
   * decrypted with {@link decryptMedia}. Cached plaintext is returned without
   * a network request.
   */
  async downloadMedia(
    attachment: MediaAttachment,
    opts: DownloadMediaOptions = {},
  ): Promise<StoredMedia> {
    const cached = await this.media?.getMedia(attachment.ciphertextSha256);
    if (cached) return cached;
    const policy = getGroupMediaPolicy(this.#getState(), attachment.version);
    const candidates = resolveMediaFetchUrls(attachment, policy, {
      allowLoopbackHttp: opts.allowLoopbackHttp,
    });
    const encrypted = await fetchBlossomBlob(
      candidates,
      attachment.ciphertextSha256,
      { fetch: this.#fetch },
    );
    return this.decryptMedia(encrypted, attachment);
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
