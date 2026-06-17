import { useMemo } from "react";

import { useKeyboard } from "@opentui/react";
import { qrcode } from "@libs/qrcode";

const DARK = "#000000";
const LIGHT = "#ffffff";

/** One run of same-colored cells within a rendered QR line. */
type Run = { key: number; glyph: string; fg: string; bg: string };

/**
 * Render a QR matrix as terminal lines using the upper-half-block glyph (▀):
 * each character cell stacks two vertical modules — the glyph foreground paints
 * the top module, the cell background paints the bottom one — so the printed
 * code stays roughly square instead of twice as tall. Consecutive cells with
 * the same colors are merged into a single span to keep the element count down.
 */
function toLines(matrix: boolean[][]): Run[][] {
  const width = matrix[0]?.length ?? 0;
  const lines: Run[][] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    const top = matrix[y];
    const bottom = matrix[y + 1]; // may be undefined on an odd final row
    const runs: Run[] = [];
    for (let x = 0; x < width; x++) {
      const fg = top[x] ? DARK : LIGHT;
      const bg = bottom?.[x] ? DARK : LIGHT;
      const last = runs[runs.length - 1];
      if (last && last.fg === fg && last.bg === bg) last.glyph += "▀";
      else runs.push({ key: x, glyph: "▀", fg, bg });
    }
    lines.push(runs);
  }
  return lines;
}

/**
 * A modal that renders the current user's npub as a scannable QR code so others
 * can scan it to invite this account, with the full npub printed below for
 * copy-paste. Any key (or a click) dismisses it.
 */
export function QrModal(props: { npub: string; onClose: () => void }) {
  const lines = useMemo(() => toLines(qrcode(props.npub)), [props.npub]);

  useKeyboard(() => props.onClose());

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      shouldFill={false}
      justifyContent="center"
      alignItems="center"
      onMouseDown={() => props.onClose()}
    >
      <box
        border
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        flexDirection="column"
        alignItems="center"
        title=" invite me — scan or copy "
      >
        <box flexDirection="column" backgroundColor={LIGHT} paddingX={1}>
          {lines.map((runs, i) => (
            <text key={i}>
              {runs.map((run) => (
                <span key={run.key} fg={run.fg} bg={run.bg}>
                  {run.glyph}
                </span>
              ))}
            </text>
          ))}
        </box>

        <text fg="#7fd1ff" selectable marginTop={1}>
          {props.npub}
        </text>
        <text fg="#666">scan to invite this account · press any key to close</text>
      </box>
    </box>
  );
}
