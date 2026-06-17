import type { SelectOption } from "@opentui/core";

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
import type { Pane } from "./focus.js";

/**
 * The left rail: a focusable group list and a focusable invite list, both built
 * on OpenTUI's `<select>`. The lists are fed by the library's async generators
 * (`groups.watch()` / `invites.watchUnread()`). Clicking a pane focuses it;
 * once focused, ↑/↓ navigate, Enter selects (a group) or accepts (an invite).
 */
export function Sidebar(props: {
  groups: MarmotGroup[];
  invites: UnreadInvite[];
  activeId: string | null;
  focus: Pane;
  modalOpen: boolean;
  onFocusPane: (pane: Pane) => void;
  onPreviewGroup: (idStr: string) => void;
  onConfirmGroup: (idStr: string) => void;
  onAcceptInvite: (inviteId: string) => void;
}) {
  const activeIndex = Math.max(
    0,
    props.groups.findIndex((group) => group.idStr === props.activeId),
  );

  const groupOptions: SelectOption[] = props.groups.map((group) => ({
    name: `${groupName(group)}  e${groupEpoch(group)}·${groupMemberCount(group)}m`,
    description: "",
    value: group.idStr,
  }));

  const inviteOptions: SelectOption[] = props.invites.map((invite) => ({
    name: npubShort(invite.pubkey),
    description: "",
    value: invite.id,
  }));

  return (
    <box flexDirection="column" width={30}>
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderColor={props.focus === "groups" ? "#FFD700" : "#444"}
        title=" groups "
        paddingX={1}
        onMouseDown={() => props.onFocusPane("groups")}
      >
        {groupOptions.length === 0 ? (
          <text fg="#666">no groups yet</text>
        ) : (
          <select
            flexGrow={1}
            focused={!props.modalOpen && props.focus === "groups"}
            options={groupOptions}
            selectedIndex={activeIndex}
            showDescription={false}
            wrapSelection
            showScrollIndicator
            onChange={(index: number) =>
              props.onPreviewGroup(props.groups[index].idStr)
            }
            onSelect={(index: number) =>
              props.onConfirmGroup(props.groups[index].idStr)
            }
          />
        )}
      </box>

      <box
        height={8}
        flexDirection="column"
        border
        borderColor={props.focus === "invites" ? "#FFD700" : "#444"}
        title={` invites (${props.invites.length}) `}
        paddingX={1}
        onMouseDown={() => props.onFocusPane("invites")}
      >
        {inviteOptions.length === 0 ? (
          <text fg="#555">none yet</text>
        ) : (
          <select
            flexGrow={1}
            focused={!props.modalOpen && props.focus === "invites"}
            options={inviteOptions}
            showDescription={false}
            showScrollIndicator
            onSelect={(index: number) =>
              props.onAcceptInvite(props.invites[index].id)
            }
          />
        )}
      </box>
    </box>
  );
}
