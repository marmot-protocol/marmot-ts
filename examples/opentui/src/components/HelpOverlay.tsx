import type { KeyHint } from "./KeybindingFooter.js";
import type { Pane } from "./focus.js";
import { ModalOverlay } from "./primitives.js";

export function HelpOverlay(props: {
  panel: Pane;
  global: KeyHint[];
  panelHints: KeyHint[];
  onClose: () => void;
}) {
  return (
    <ModalOverlay title="keyboard help" width={76} footer="esc/q: close help">
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
    </ModalOverlay>
  );
}
