import { useKeyboard } from "@opentui/react";

/**
 * A centered modal that collects a single line of text (group name, npub).
 * Enter submits, Esc cancels. Rendered as an absolutely-positioned overlay so
 * the chat stays visible behind it.
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
        width={60}
        flexDirection="column"
        title={` ${props.title} `}
      >
        <input
          focused
          placeholder={props.placeholder}
          onSubmit={((value: string) => props.onSubmit(value)) as any}
        />
        <text fg="#666">enter: confirm · esc: cancel</text>
      </box>
    </box>
  );
}
