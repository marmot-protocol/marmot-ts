import type { SelectOption } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

/**
 * A centered modal that offers a short list of choices via a `<select>`.
 * ↑/↓ moves, Enter chooses, Esc cancels.
 */
export function ChoicePrompt(props: {
  title: string;
  options: SelectOption[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "escape") props.onCancel();
  });

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
    >
      <box
        border
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        width={50}
        flexDirection="column"
        title={` ${props.title} `}
      >
        <select
          focused
          height={props.options.length}
          showDescription={false}
          options={props.options}
          onSelect={(index: number) => props.onSelect(index)}
        />
        <text fg="#666">↑/↓: choose · enter: select · esc: cancel</text>
      </box>
    </box>
  );
}
