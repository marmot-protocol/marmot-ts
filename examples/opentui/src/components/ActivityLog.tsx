import { ListPanel } from "./ListPanel.js";
import { useChat } from "../hooks/use-marmot.js";

/** A navigable panel showing recent lifecycle/status lines. */
export function ActivityLog(props: {
  focused: boolean;
  selectedIndex: number;
  onFocus: () => void;
}) {
  const { status } = useChat();
  const recent = status.slice(-8);
  return (
    <ListPanel
      title="activity"
      focused={props.focused}
      items={recent.map((line) => ({
        id: String(line.id),
        label: line.text,
        level: line.level,
      }))}
      selectedIndex={props.selectedIndex}
      empty="…"
      height={10}
      onFocus={props.onFocus}
    />
  );
}
