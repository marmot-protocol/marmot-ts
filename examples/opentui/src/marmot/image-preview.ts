import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/**
 * Inline image previews for the terminal. We decode an attachment to RGBA
 * pixels, downsample to a small grid, and pack two vertical pixels per
 * character cell using the upper-half-block glyph `▀` (foreground = top pixel,
 * background = bottom pixel). The result is plain `<text>`/`<span>` rows, so it
 * flows in the normal flex/scroll layout — no FrameBuffer renderable needed.
 */

/** A decoded image as tightly-packed RGBA bytes. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

/** One rendered character cell: a half-block with top/bottom pixel colours. */
export interface PreviewCell {
  fg: string;
  bg: string;
}

/** Don't attempt to decode blobs larger than this (bytes). */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** Media types we can decode for preview. */
export function isPreviewable(mediaType: string): boolean {
  return mediaType === "image/png" || mediaType === "image/jpeg";
}

/** Decodes PNG/JPEG bytes to RGBA, or returns null on any failure. */
export function decodeImage(
  data: Uint8Array,
  mediaType: string,
): DecodedImage | null {
  if (data.length > MAX_PREVIEW_BYTES) return null;
  try {
    if (mediaType === "image/png") {
      const png = PNG.sync.read(Buffer.from(data));
      return {
        width: png.width,
        height: png.height,
        data: new Uint8Array(png.data),
      };
    }
    if (mediaType === "image/jpeg") {
      const img = jpeg.decode(Buffer.from(data), { useTArray: true });
      return {
        width: img.width,
        height: img.height,
        data: new Uint8Array(img.data),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Downsamples a decoded image into a grid of half-block cells that fits within
 * `maxCols` × `maxRows` character cells, preserving aspect ratio (each cell
 * holds two vertically-stacked, roughly-square pixels). Nearest-neighbour
 * sampling; transparent pixels fall back to `bgColor`.
 */
export function renderImageCells(
  image: DecodedImage,
  maxCols: number,
  maxRows: number,
  bgColor = "#000000",
): PreviewCell[][] {
  const aspect = image.width / image.height;
  // Two pixels per row vertically, so a cell is ~square: cols/(2*rows) == aspect.
  let cols = Math.min(maxCols, image.width);
  let rows = Math.max(1, Math.round((cols * image.height) / (2 * image.width)));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.min(maxCols, Math.max(1, Math.round(rows * 2 * aspect)));
  }

  const pxW = cols;
  const pxH = rows * 2;
  const sample = (px: number, py: number): string => {
    const sx = Math.min(image.width - 1, Math.floor((px * image.width) / pxW));
    const sy = Math.min(
      image.height - 1,
      Math.floor((py * image.height) / pxH),
    );
    const i = (sy * image.width + sx) * 4;
    const a = image.data[i + 3];
    if (a < 16) return bgColor;
    return toHex(image.data[i], image.data[i + 1], image.data[i + 2]);
  };

  const grid: PreviewCell[][] = [];
  for (let cy = 0; cy < rows; cy++) {
    const row: PreviewCell[] = [];
    for (let cx = 0; cx < cols; cx++) {
      row.push({ fg: sample(cx, cy * 2), bg: sample(cx, cy * 2 + 1) });
    }
    grid.push(row);
  }
  return grid;
}
