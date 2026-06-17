import type { StatusLine } from "../marmot/controller.js";
import { useChat } from "../hooks/use-marmot.js";

const LEVEL_COLORS: Record<StatusLine["level"], string> = {
  info: "#9aa9b8",
  warn: "#E5C07B",
  error: "#E06C75",
};

/** A small footer showing the most recent lifecycle/status lines. */
export function ActivityLog() {
  const { status } = useChat();
  const recent = status.slice(-4);
  return (
    <box
      height={6}
      border
      borderColor="#333"
      title=" activity "
      paddingX={1}
      flexDirection="column"
    >
      {recent.length === 0 ? (
        <text fg="#555">…</text>
      ) : (
        recent.map((line) => (
          <text key={line.id} fg={LEVEL_COLORS[line.level]}>
            {line.text}
          </text>
        ))
      )}
    </box>
  );
}
