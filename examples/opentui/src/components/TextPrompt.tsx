import { useKeyboard } from "@opentui/react";

import { ModalOverlay } from "./primitives.js";

/**
 * A centered modal that collects a single line of text (group name, npub).
 * Enter submits, Esc cancels. Rendered as an overlay so the chat stays visible
 * behind it.
 */
export function TextPrompt(props: {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "escape") props.onCancel();
  });

  return (
    <ModalOverlay
      title={props.title}
      width={60}
      footer="enter: confirm · esc: cancel"
    >
      <input
        focused
        placeholder={props.placeholder}
        onSubmit={((value: string) => props.onSubmit(value)) as any}
      />
    </ModalOverlay>
  );
}
