import { getDisplayName } from "applesauce-core/helpers/profile";

import { useChat } from "../hooks/use-marmot.js";

/** The top status bar: identity (profile name when set), live counts, busy. */
export function Header(props: {
  groupCount: number;
  inviteCount: number;
  onShowQr: () => void;
}) {
  const { me, profile, relays, busy } = useChat();
  const name = getDisplayName(profile ?? undefined);
  return (
    <box backgroundColor="#1b1b2b" flexDirection="column">
      <box height={1} paddingX={1} flexDirection="row">
        <text fg="#FFD700" flexGrow={1}>
          ⬡ marmot · react tui {busy ? "· …working" : ""}
        </text>
        <text fg="#9aa9b8">
          {props.groupCount} groups · {props.inviteCount} invites ·{" "}
          {relays.length} relays
        </text>
      </box>
      <box
        height={1}
        paddingX={1}
        flexDirection="row"
        onMouseDown={() => props.onShowQr()}
      >
        <text fg="#9aa9b8">{name ? `${name} · ` : ""}</text>
        <text fg="#7fd1ff" selectable>
          {me.npub}
        </text>
        <text fg="#555"> · click for QR</text>
      </box>
    </box>
  );
}
