import type { AuditStatus } from "../marmot/controller.js";
import { useChat } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useProfile } from "../hooks/use-profile.js";
import { short } from "../marmot/format.js";
import { panelHints } from "./hints.js";
import { Row } from "./primitives.js";

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

/** Map the audit-upload status into a colored label + one-line detail. */
function auditView(audit: AuditStatus): {
  label: string;
  color: string;
  detail: string | null;
} {
  if (!audit.enabled)
    return {
      label: "disabled",
      color: "#666",
      detail: "run with --audit-upload <url>",
    };
  switch (audit.state) {
    case "uploading":
      return { label: "uploading…", color: "#FFD700", detail: null };
    case "success":
      return {
        label: "uploaded",
        color: "#7fe08a",
        detail: `${audit.bytesSent ?? 0}B · HTTP ${audit.httpStatus ?? "?"} · ${ageLabel(audit.updatedAt)}`,
      };
    case "failed":
      return {
        label: "failed",
        color: "#ff6b6b",
        detail: audit.error ?? "unknown error",
      };
    default:
      return { label: "idle", color: "#9aa9b8", detail: "press U to upload" };
  }
}

export function ProfilePanel() {
  const {
    me,
    relays,
    connectedRelayCount,
    outboxRelays,
    inboxRelays,
    keyPackages,
    clientId,
    audit,
  } = useChat();
  const nav = useNavigation();
  const auditStatus = auditView(audit);
  const profile = useProfile(me.pubkey);
  const displayName = profile?.displayName || profile?.name || "not set";
  const about = profile?.about ?? "";
  const nip05 = profile?.dnsIdentity;
  const hints = panelHints({
    composing: nav.composing,
    replySelecting: nav.replySelecting,
    reactSelecting: nav.reactSelecting,
    saveSelecting: nav.saveSelecting,
    showAllInvites: nav.showAllInvites,
    selectedGroupIsAdmin: nav.selectedGroupIsAdmin,
    activeGroupIsAdmin: nav.activeGroupIsAdmin,
  }).profile;

  return (
    <box
      width={36}
      flexDirection="column"
      border
      borderColor={nav.focus === "profile" ? "#FFD700" : "#444"}
      title=" profile "
      paddingX={1}
      onMouseDown={() => nav.setFocus("profile")}
    >
      <text fg="#FFD700">{displayName}</text>
      <text fg="#7fd1ff" selectable>
        {me.npub}
      </text>
      {nip05 ? <text fg="#9aa9b8">{nip05}</text> : null}
      {about ? <text fg="#9aa9b8">{about.slice(0, 64)}</text> : null}

      <box height={1} />
      <text fg="#888">relays</text>
      <Row label="session" value={relays.length} />
      <Row label="connected" value={connectedRelayCount} />
      <Row label="outbox" value={outboxRelays.length} />
      <Row label="inbox" value={inboxRelays.length} />

      <box height={1} />
      <text fg="#888">key package</text>
      <Row label="slot" value={keyPackages.slot ?? clientId} />
      <Row label="stored" value={keyPackages.total} />
      <Row label="unused" value={keyPackages.unused} />
      <Row label="published" value={ageLabel(keyPackages.newestPublishedAt)} />
      {keyPackages.newestPublishedId ? (
        <Row label="latest id" value={short(keyPackages.newestPublishedId)} />
      ) : null}

      <box height={1} />
      <text fg="#888">audit log</text>
      <text>
        <span fg="#666">status: </span>
        <span fg={auditStatus.color}>{auditStatus.label}</span>
      </text>
      {auditStatus.detail ? (
        <text fg="#9aa9b8">{auditStatus.detail}</text>
      ) : null}

      <box height={1} />
      <text fg="#888">manage yourself</text>
      {hints.map((hint) => (
        <text key={`${hint.key}:${hint.label}`} fg="#9aa9b8">
          <span fg="#7fd1ff">{hint.key}</span> {hint.label}
        </text>
      ))}
    </box>
  );
}
