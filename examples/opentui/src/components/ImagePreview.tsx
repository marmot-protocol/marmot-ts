import { useMemo } from "react";

import type { ChatAttachment } from "../marmot/controller.js";
import {
  decodeImage,
  isPreviewable,
  renderImageCells,
} from "../marmot/image-preview.js";

/** The upper-half-block glyph: foreground is the top pixel, background the bottom. */
const HALF_BLOCK = "▀";

/** Max preview footprint, in character cells. */
const MAX_COLS = 48;
const MAX_ROWS = 20;

/**
 * Renders a ready image attachment as inline half-block "pixels". Returns null
 * for non-images or anything that fails to decode (the file row still shows).
 * Decoding is memoised on the blob id so it runs once per image, not per frame.
 */
export function ImagePreview(props: { attachment: ChatAttachment }) {
  const { attachment } = props;
  const rows = useMemo(() => {
    if (attachment.status !== "ready" || !attachment.data) return null;
    if (!isPreviewable(attachment.mediaType)) return null;
    const decoded = decodeImage(attachment.data, attachment.mediaType);
    if (!decoded) return null;
    return renderImageCells(decoded, MAX_COLS, MAX_ROWS);
  }, [attachment.id, attachment.status, attachment.mediaType, attachment.data]);

  if (!rows) return null;

  return (
    <box flexDirection="column" paddingLeft={4}>
      {rows.map((cells, y) => (
        <text key={y}>
          {cells.map((cell, x) => (
            <span key={x} fg={cell.fg} bg={cell.bg}>
              {HALF_BLOCK}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
