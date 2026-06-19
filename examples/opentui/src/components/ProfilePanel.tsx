import type { KeyHint } from "./KeybindingFooter.js";
import { useChat } from "../hooks/use-marmot.js";
import { useProfile } from "../hooks/use-profile.js";

function ageLabel(timestamp: number | null): string {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function row(label: string, value: string | number) {
  return (
    <text>
      <span fg="#666">{label}: </span>
      <span fg="#d7dde8">{value}</span>
    </text>
  );
}

export function ProfilePanel(props: {
  focused: boolean;
  hints: KeyHint[];
  onFocus: () => void;
}) {
  const {
    me,
    relays,
    connectedRelayCount,
    outboxRelays,
    inboxRelays,
    keyPackages,
    clientId,
  } = useChat();
  const profile = useProfile(me.pubkey);
  const displayName = profile?.displayName || profile?.name || "not set";
  const about = profile?.about ?? "";
  const nip05 = profile?.dnsIdentity;

  return (
    <box
      width={36}
      flexDirection="column"
      border
      borderColor={props.focused ? "#FFD700" : "#444"}
      title=" profile "
      paddingX={1}
      onMouseDown={props.onFocus}
    >
      <text fg="#FFD700">{displayName}</text>
      <text fg="#7fd1ff" selectable>
        {me.npub}
      </text>
      {nip05 ? <text fg="#9aa9b8">{nip05}</text> : null}
      {about ? <text fg="#9aa9b8">{about.slice(0, 64)}</text> : null}

      <box height={1} />
      <text fg="#888">relays</text>
      {row("session", relays.length)}
      {row("connected", connectedRelayCount)}
      {row("outbox", outboxRelays.length)}
      {row("inbox", inboxRelays.length)}

      <box height={1} />
      <text fg="#888">key package</text>
      {row("slot", keyPackages.slot ?? clientId)}
      {row("stored", keyPackages.total)}
      {row("unused", keyPackages.unused)}
      {row("published", ageLabel(keyPackages.newestPublishedAt))}

      <box height={1} />
      <text fg="#888">manage yourself</text>
      {props.hints.map((hint) => (
        <text key={`${hint.key}:${hint.label}`} fg="#9aa9b8">
          <span fg="#7fd1ff">{hint.key}</span> {hint.label}
        </text>
      ))}
    </box>
  );
}
