export interface KeyHint {
  key: string;
  label: string;
}

export function KeybindingFooter(props: { title: string; hints: KeyHint[] }) {
  return (
    <box height={1} backgroundColor="#15151f" paddingX={1} flexDirection="row">
      <text fg="#FFD700">{props.title.toUpperCase()} </text>
      {props.hints.map((hint, index) => (
        <text key={`${hint.key}:${hint.label}`} fg="#9aa9b8">
          {index === 0 ? " " : "  ·  "}
          <span fg="#7fd1ff">{hint.key}</span> {hint.label}
        </text>
      ))}
    </box>
  );
}
