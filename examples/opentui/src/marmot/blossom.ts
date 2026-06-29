import {
  Actions,
  createUploadAuth,
  type Signer as BlossomSigner,
} from "blossom-client-sdk";

const { uploadBlob } = Actions;

/**
 * Blob transport for encrypted-media attachments.
 *
 * Marmot deliberately keeps blob upload/download OUTSIDE MLS group state: a
 * failed upload or fetch never changes the group epoch. The library encrypts
 * the file and derives its key from the group's MLS exporter; this module only
 * moves the *ciphertext* to and from a Blossom server, content-addressed by its
 * SHA-256 (which equals `attachment.ciphertextSha256`).
 *
 * @see darkmatter `spec/features/encrypted-media.md`
 */

/** The minimal signer shape this module needs (applesauce `EventSigner`). */
export type EventSigner = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<any> | any;
};

/** Adapts an applesauce `EventSigner` to the Blossom `(draft) => SignedEvent` signer. */
function toBlossomSigner(signer: EventSigner): BlossomSigner {
  return async (draft) => signer.signEvent(draft);
}

/**
 * Uploads already-encrypted bytes to a Blossom server and returns the blob URL
 * to store as a `blossom-v1` locator. The ciphertext is uploaded as
 * `application/octet-stream`; the real media type travels (authenticated) in
 * the message `imeta` tag, not in the blob's stored content type.
 *
 * `uploadBlob` requests a BUD-02 signed auth event via `onAuth` when the server
 * asks for one (HTTP 401), so private/auth-required Blossom servers work too.
 */
export async function uploadEncryptedBlob(
  encrypted: Uint8Array,
  server: string,
  signer: EventSigner,
): Promise<string> {
  const sign = toBlossomSigner(signer);
  const blob = new Blob([encrypted as unknown as BlobPart], {
    type: "application/octet-stream",
  });
  const descriptor = await uploadBlob(server, blob, {
    onAuth: (
      _server: string,
      _sha256: string,
      _type: "upload" | "media",
      b: Blob,
    ) => createUploadAuth(sign, b),
  });
  return descriptor.url;
}

/**
 * Fetches an encrypted blob by URL. No auth is sent: encrypted-media blobs are
 * public, content-addressed, and authenticated by their SHA-256 — the caller
 * (`MarmotGroup.decryptMedia`) verifies `ciphertextSha256` before decrypting.
 */
export async function downloadEncryptedBlob(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`blob fetch failed (${response.status}) for ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
