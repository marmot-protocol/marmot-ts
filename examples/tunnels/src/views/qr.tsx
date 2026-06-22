import type { FC } from "hono/jsx";
import { qrcode } from "@libs/qrcode";

/**
 * Render a string as a scannable QR code, inline as a server-side SVG. The
 * `qrcode` helper returns a boolean module matrix; we paint every dark module as
 * a 1×1 rect in one `<path>` (compact) over a white quiet-zone background.
 */
export const QrCode: FC<{ value: string; size?: number }> = ({
  value,
  size = 132,
}) => {
  const matrix = qrcode(value);
  const n = matrix.length;
  const quiet = 2;
  const dim = n + quiet * 2;

  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y]![x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shape-rendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
};
