import type { SelectOption } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { ModalOverlay } from "./primitives.js";

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
    <ModalOverlay
      title={props.title}
      width={50}
      footer="↑/↓: choose · enter: select · esc: cancel"
    >
      <select
        focused
        height={props.options.length}
        showDescription={false}
        options={props.options}
        onSelect={(index: number) => props.onSelect(index)}
      />
    </ModalOverlay>
  );
}
