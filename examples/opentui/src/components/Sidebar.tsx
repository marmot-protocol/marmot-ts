import { useChat } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useDisplayName } from "../hooks/use-profile.js";
import {
  groupEpoch,
  groupMemberCount,
  groupName,
  npubShort,
  relativeTime,
} from "../marmot/format.js";
import { ListPanel } from "./ListPanel.js";

/** Resolves an inviter's display name reactively, falling back to a short npub. */
function InviteName(props: { pubkey: string }) {
  return <>{useDisplayName(props.pubkey, npubShort(props.pubkey))}</>;
}

/** The left column: the groups list above the invites list. */
export function Sidebar() {
  const { activeGroupId } = useChat();
  const nav = useNavigation();

  const invitesTitle = nav.showAllInvites
    ? `invites (${nav.invites.length}) · all`
    : nav.hiddenInviteCount > 0
      ? `invites (${nav.joinableInvites.length}) · +${nav.hiddenInviteCount} hidden`
      : `invites (${nav.joinableInvites.length})`;

  return (
    <box flexDirection="column" width={32}>
      <ListPanel
        title={`groups (${nav.groups.length})`}
        focused={nav.focus === "groups"}
        items={nav.groups.map((group) => ({
          id: group.idStr,
          label: groupName(group),
          detail: `${group.idStr === activeGroupId ? "active · " : ""}e${groupEpoch(group)} · ${groupMemberCount(group)}m`,
        }))}
        selectedIndex={nav.groupIndex}
        empty="no groups yet"
        flexGrow={1}
        onFocus={() => nav.setFocus("groups")}
      />
      <ListPanel
        title={invitesTitle}
        focused={nav.focus === "invites"}
        items={nav.visibleInvites.map(({ invite, joinable }) => ({
          id: invite.id,
          label: <InviteName pubkey={invite.pubkey} />,
          detail: joinable
            ? relativeTime(invite.created_at)
            : `${relativeTime(invite.created_at)} · no key pkg`,
          level: joinable ? undefined : "warn",
        }))}
        selectedIndex={nav.inviteIndex}
        empty="none yet"
        height={8}
        onFocus={() => nav.setFocus("invites")}
      />
    </box>
  );
}
