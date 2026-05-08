import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "applesauce-core/helpers/event";

import { decryptGroupImage } from "../../core/group-image.js";
import { canonicalizeMimeType } from "../../core/media.js";
import type { MarmotGroupData } from "../../core/protocol.js";

export type GroupImageDownloadOptions = {
  force?: boolean;
  mimeType?: string;
};

/** A class that represents a groups MIP-01 image */
export class GroupImage {
  readonly groupData: MarmotGroupData;

  #groupImageData: Uint8Array | null = null;
  #groupImageMimeType: string | null = null;
  #groupImageObjectUrl: string | null = null;
  #groupImageHashHex: string | null = null;
  #downloadingGroupImage: Promise<Uint8Array | null> | null = null;

  constructor(groupData: MarmotGroupData) {
    this.groupData = groupData;
  }

  hasImage(): boolean {
    return (
      this.groupData.imageHash.length === 32 &&
      this.groupData.imageKey.length === 32 &&
      this.groupData.imageNonce.length === 12
    );
  }

  async download(
    url: string,
    options?: GroupImageDownloadOptions,
  ): Promise<Uint8Array | null> {
    if (!this.hasImage()) return null;

    const imageHashHex = bytesToHex(this.groupData.imageHash);
    if (
      !options?.force &&
      this.#groupImageData &&
      this.#groupImageHashHex === imageHashHex
    ) {
      return this.#groupImageData;
    }

    if (!options?.force && this.#downloadingGroupImage) {
      return this.#downloadingGroupImage;
    }

    const downloadPromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download group image: ${response.status}`);
      }

      const encrypted = new Uint8Array(await response.arrayBuffer());
      const actualHashHex = bytesToHex(sha256(encrypted));
      if (actualHashHex !== imageHashHex) {
        throw new Error("group image hash mismatch");
      }

      const plaintext = decryptGroupImage(
        encrypted,
        this.groupData.imageKey,
        this.groupData.imageNonce,
      );

      this.#groupImageData = plaintext;
      this.#groupImageHashHex = imageHashHex;

      const headerMimeType = response.headers.get("content-type");
      this.#groupImageMimeType = options?.mimeType
        ? canonicalizeMimeType(options.mimeType)
        : headerMimeType
          ? canonicalizeMimeType(headerMimeType)
          : null;

      return plaintext;
    })();

    this.#downloadingGroupImage = downloadPromise;

    try {
      return await downloadPromise;
    } finally {
      if (this.#downloadingGroupImage === downloadPromise) {
        this.#downloadingGroupImage = null;
      }
    }
  }

  async getObjectUrl(
    url: string,
    options?: GroupImageDownloadOptions,
  ): Promise<string | null> {
    const plaintext = await this.download(url, options);
    if (!plaintext) return null;

    if (this.#groupImageObjectUrl && !options?.force) {
      return this.#groupImageObjectUrl;
    }

    this.revokeObjectUrl();

    const blob = new Blob([Uint8Array.from(plaintext).buffer], {
      type:
        options?.mimeType ??
        this.#groupImageMimeType ??
        "application/octet-stream",
    });

    this.#groupImageObjectUrl = URL.createObjectURL(blob);
    return this.#groupImageObjectUrl;
  }

  revokeObjectUrl(): void {
    if (!this.#groupImageObjectUrl) return;

    URL.revokeObjectURL(this.#groupImageObjectUrl);
    this.#groupImageObjectUrl = null;
  }

  destroy(): void {
    this.revokeObjectUrl();
    this.#groupImageData = null;
    this.#groupImageMimeType = null;
    this.#groupImageHashHex = null;
    this.#downloadingGroupImage = null;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}
