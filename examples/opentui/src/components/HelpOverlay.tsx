import type { KeyHint } from "./KeybindingFooter.js";
import type { Pane } from "./focus.js";

export function HelpOverlay(props: {
  panel: Pane;
  global: KeyHint[];
  panelHints: KeyHint[];
  onClose: () => void;
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
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        width={76}
        flexDirection="column"
        title=" keyboard help "
      >
        <text fg="#FFD700">focused panel: {props.panel}</text>
        <text fg="#666"> </text>
        <text fg="#9aa9b8">global</text>
        {props.global.map((hint) => (
          <text key={`global:${hint.key}:${hint.label}`}>
            <span fg="#7fd1ff">{hint.key.padEnd(10)}</span>
            <span fg="#d7dde8">{hint.label}</span>
          </text>
        ))}
        <text fg="#666"> </text>
        <text fg="#9aa9b8">current panel</text>
        {props.panelHints.map((hint) => (
          <text key={`panel:${hint.key}:${hint.label}`}>
            <span fg="#7fd1ff">{hint.key.padEnd(10)}</span>
            <span fg="#d7dde8">{hint.label}</span>
          </text>
        ))}
        <text fg="#666"> </text>
        <text fg="#666">esc/q: close help</text>
      </box>
    </box>
  );
}
