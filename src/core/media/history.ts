/** @module @category Core - Encrypted Media */
import { parseMediaImetaTag } from "./imeta.js";
import { parseMediaImetaTag as parseV1 } from "./v1/imeta.js";
import type { MediaAttachment } from "./types.js";
import type { MediaAttachment as MediaAttachmentV1 } from "./v1/types.js";

export type HistoricalMediaAttachment = MediaAttachment | MediaAttachmentV1;

/** Explicit version dispatch for history. Failed validation never tries another version. */
export function parseHistoricalMediaImetaTag(
  tag: string[],
): HistoricalMediaAttachment | null {
  const versions = tag
    .slice(1)
    .filter((field) => field === "v" || field.startsWith("v "));
  if (versions.length !== 1) return null;
  switch (versions[0]) {
    case "v encrypted-media-v2":
      return parseMediaImetaTag(tag);
    case "v encrypted-media-v1":
      return parseV1(tag);
    default:
      return null;
  }
}
