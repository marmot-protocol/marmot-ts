/**
 * Minimal filename → MIME type guesser for outgoing attachments. The encrypted
 * media format requires a media type (it is authenticated into the key
 * derivation and AEAD), so we always resolve one, falling back to a generic
 * binary type for unknown extensions.
 */
const BY_EXTENSION: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  // documents / text
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  csv: "text/csv",
  html: "text/html",
  // audio / video
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  // archives
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

/** Resolves a MIME type from a filename's extension. */
export function guessMediaType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return BY_EXTENSION[ext] ?? "application/octet-stream";
}
