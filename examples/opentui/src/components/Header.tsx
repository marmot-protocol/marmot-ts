import { getDisplayName } from "applesauce-core/helpers/profile";

import { useChat } from "../hooks/use-marmot.js";

/** The top status bar: identity (profile name when set), live counts, busy. */
export function Header(props: { groupCount: number; inviteCount: number }) {
  const { me, profile, relays, busy } = useChat();
  const name = getDisplayName(profile ?? undefined);
  const who = name
    ? `${name} (${me.npub.slice(0, 12)}…)`
    : `${me.npub.slice(0, 16)}…`;
  return (
    <box height={1} paddingX={1} backgroundColor="#1b1b2b" flexDirection="row">
      <text fg="#FFD700" flexGrow={1}>
        ⬡ marmot · react tui {busy ? "· …working" : ""}
      </text>
      <text fg="#9aa9b8">
        {who} · {props.groupCount} groups · {props.inviteCount} invites ·{" "}
        {relays.length} relays
      </text>
    </box>
  );
}
