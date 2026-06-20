import { useChat } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useDisplayName } from "../hooks/use-profile.js";

/** The top status bar: identity (profile name when set), live counts, busy. */
export function Header(props: { onShowQr: () => void }) {
  const { me, relays, busy } = useChat();
  const { groups, joinableInvites } = useNavigation();
  const name = useDisplayName(me.pubkey);
  return (
    <box backgroundColor="#1b1b2b" flexDirection="column">
      <box height={1} paddingX={1} flexDirection="row">
        <text fg="#FFD700" flexGrow={1}>
          ⬡ marmot · react tui {busy ? "· …working" : ""}
        </text>
        <text fg="#9aa9b8">
          {groups.length} groups · {joinableInvites.length} invites ·{" "}
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
