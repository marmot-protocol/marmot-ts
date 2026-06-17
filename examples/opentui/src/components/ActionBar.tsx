import { Button } from "./Button.js";

export interface Action {
  label: string;
  run: () => void;
}

/**
 * The row of action buttons. Each button is clickable (mouse) and the whole row
 * is one focus pane: when focused, ←/→ moves the highlight and Enter runs the
 * highlighted action (handled by the parent's global key handler).
 */
export function ActionBar(props: {
  actions: Action[];
  focused: boolean;
  focusedIndex: number;
}) {
  return (
    <box flexDirection="row" height={3}>
      {props.actions.map((action, index) => (
        <Button
          key={action.label}
          label={action.label}
          focused={props.focused && index === props.focusedIndex}
          onPress={action.run}
        />
      ))}
    </box>
  );
}
