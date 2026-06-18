export interface ListPanelItem {
  id: string;
  label: string;
  detail?: string;
  level?: "info" | "warn" | "error";
}

const LEVEL_COLORS: Record<NonNullable<ListPanelItem["level"]>, string> = {
  info: "#9aa9b8",
  warn: "#E5C07B",
  error: "#E06C75",
};

export function ListPanel(props: {
  title: string;
  focused: boolean;
  items: ListPanelItem[];
  selectedIndex: number;
  empty: string;
  height?: number;
  width?: number;
  flexGrow?: number;
  onFocus: () => void;
}) {
  return (
    <box
      height={props.height}
      width={props.width}
      flexGrow={props.flexGrow}
      flexDirection="column"
      border
      borderColor={props.focused ? "#FFD700" : "#444"}
      title={` ${props.title} `}
      paddingX={1}
      onMouseDown={props.onFocus}
    >
      {props.items.length === 0 ? (
        <text fg="#555">{props.empty}</text>
      ) : (
        props.items.map((item, index) => {
          const selected = index === props.selectedIndex;
          const fg = item.level ? LEVEL_COLORS[item.level] : "#d7dde8";
          return (
            <text
              key={item.id}
              fg={selected ? "#0e0e16" : fg}
              bg={selected ? "#FFD700" : undefined}
            >
              {selected ? "› " : "  "}
              {item.label}
              {item.detail ? (
                <span fg={selected ? "#0e0e16" : "#666"}> {item.detail}</span>
              ) : null}
            </text>
          );
        })
      )}
    </box>
  );
}
