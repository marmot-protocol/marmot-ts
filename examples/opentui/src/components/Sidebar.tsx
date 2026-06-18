import type {
  MarmotGroup,
  UnreadInvite,
} from "@internet-privacy/marmot-ts/client";

import {
  groupEpoch,
  groupMemberCount,
  groupName,
  npubShort,
} from "../marmot/format.js";
import { ListPanel } from "./ListPanel.js";
import type { Pane } from "./focus.js";

export function Sidebar(props: {
  groups: MarmotGroup[];
  invites: UnreadInvite[];
  activeId: string | null;
  focus: Pane;
  groupIndex: number;
  inviteIndex: number;
  onFocusPane: (pane: Pane) => void;
}) {
  return (
    <box flexDirection="column" width={32}>
      <ListPanel
        title={`groups (${props.groups.length})`}
        focused={props.focus === "groups"}
        items={props.groups.map((group) => ({
          id: group.idStr,
          label: groupName(group),
          detail: `${group.idStr === props.activeId ? "active · " : ""}e${groupEpoch(group)} · ${groupMemberCount(group)}m`,
        }))}
        selectedIndex={props.groupIndex}
        empty="no groups yet"
        flexGrow={1}
        onFocus={() => props.onFocusPane("groups")}
      />
      <ListPanel
        title={`invites (${props.invites.length})`}
        focused={props.focus === "invites"}
        items={props.invites.map((invite) => ({
          id: invite.id,
          label: npubShort(invite.pubkey),
        }))}
        selectedIndex={props.inviteIndex}
        empty="none yet"
        height={8}
        onFocus={() => props.onFocusPane("invites")}
      />
    </box>
  );
}
