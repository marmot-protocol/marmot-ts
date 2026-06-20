import type { ReactNode } from "react";

/** Shared modal/panel theme colors, previously hardcoded in every component. */
export const theme = {
  accent: "#FFD700",
  panelBg: "#15151f",
  border: "#444",
  borderDim: "#555",
  label: "#666",
  labelActive: "#888",
  value: "#d7dde8",
} as const;

/**
 * A `label: value` line, used throughout the detail/debug modals and the
 * profile panel. Previously copy-pasted as a local `row()` helper in four
 * different components.
 */
export function Row(props: {
  label: string;
  value: string | number | boolean;
}) {
  return (
    <text>
      <span fg={theme.label}>{props.label}: </span>
      <span fg={theme.value}>{String(props.value)}</span>
    </text>
  );
}

/**
 * The centered, absolutely-positioned overlay shared by every modal: a full
 * screen click-through layer with a bordered, titled card centered inside it.
 * An optional `footer` renders the dim hint line at the bottom of the card.
 */
export function ModalOverlay(props: {
  title: string;
  width: number;
  height?: number | `${number}%`;
  footer?: ReactNode;
  children: ReactNode;
}) {
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
        borderColor={theme.accent}
        backgroundColor={theme.panelBg}
        padding={1}
        width={props.width}
        height={props.height}
        flexDirection="column"
        title={` ${props.title} `}
      >
        {props.children}
        {props.footer !== undefined ? (
          <text fg={theme.label}>{props.footer}</text>
        ) : null}
      </box>
    </box>
  );
}
