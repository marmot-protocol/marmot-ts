import { useState } from "react";

import { useController } from "../hooks/use-marmot.js";

/**
 * The message composer. It only sends chat messages to the active group — all
 * other actions live in the action bar and the sidebar lists. After each submit
 * the input is remounted (via a changing `key`) to clear it but stays focused,
 * so several messages can be sent in a row; Esc exits composing (handled in
 * {@link App}).
 */
export function InputBar(props: { focused: boolean; onFocus: () => void }) {
  const controller = useController();
  const [resetKey, setResetKey] = useState(0);

  const handleSubmit = async (value: string) => {
    const text = value.trim();
    // Clear the field by remounting; keep `focused` so the user can keep typing.
    setResetKey((k) => k + 1);
    if (!text) return;
    try {
      await controller.sendText(text);
    } catch (err) {
      controller.logError(err);
    }
  };

  return (
    <box
      height={3}
      border
      borderColor={props.focused ? "#FFD700" : "#444"}
      paddingX={1}
      onMouseDown={() => props.onFocus()}
    >
      <input
        key={resetKey}
        focused={props.focused}
        placeholder={props.focused ? "type a message" : "press n to compose"}
        // OpenTUI's <input> type intersects the renderable onSubmit(event) with
        // the React onSubmit(value: string); at runtime we get the string.
        onSubmit={handleSubmit as any}
      />
    </box>
  );
}
