/**
 * A clickable "button" — OpenTUI has no dedicated button element, so this is a
 * bordered box wired to `onMouseDown`. It also renders a focused state so the
 * keyboard-driven action bar can highlight the current selection.
 */
export function Button(props: {
  label: string;
  focused?: boolean;
  onPress: () => void;
}) {
  return (
    <box
      border
      height={3}
      paddingX={1}
      borderColor={props.focused ? "#FFD700" : "#555"}
      backgroundColor={props.focused ? "#2a2a40" : "#13131d"}
      onMouseDown={() => props.onPress()}
    >
      <text fg={props.focused ? "#FFD700" : "#cccccc"}>{props.label}</text>
    </box>
  );
}
