import { useState } from "react";

import { useKeyboard } from "@opentui/react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { useProfile } from "../hooks/use-profile.js";
import { groupIsAdmin, groupName, npubShort } from "../marmot/format.js";

/**
 * A single group member. The display name resolves reactively through the shared
 * event store (`useProfile`), so it fills in as the kind 0 metadata loads. The
 * `(you)` and `[admin]` markers are derived from props so the row re-renders the
 * moment the admin set changes after a commit.
 */
function MemberRow(props: {
  pubkey: string;
  isAdmin: boolean;
  isSelf: boolean;
  active: boolean;
}) {
  const profile = useProfile(props.pubkey);
  const name = profile?.displayName || profile?.name || npubShort(props.pubkey);
  const dim = props.active ? "#0e0e16" : "#666";
  return (
    <text
      fg={props.active ? "#0e0e16" : "#d7dde8"}
      bg={props.active ? "#FFD700" : undefined}
    >
      {props.active ? "› " : "  "}
      {name}
      {props.isSelf ? <span fg={dim}> (you)</span> : ""}
      {props.isAdmin ? (
        <span fg={props.active ? "#0e0e16" : "#98C379"}> [admin]</span>
      ) : (
        ""
      )}
      <span fg={dim}>
        {"  "}
        {npubShort(props.pubkey)}
      </span>
    </text>
  );
}

/**
 * Lists a group's members and, for admins, lets them promote/demote other
 * members to admin or remove them. Membership and the admin set are read live
 * from `props.group` each render, so the list reflects the new epoch as soon as
 * an action's commit lands. The modal stays open after an action so an admin can
 * manage several members in a row.
 */
export function MembersModal(props: {
  group: MarmotGroup;
  mePubkey: string;
  onPromote: (pubkey: string) => void;
  onDemote: (pubkey: string) => void;
  onRemove: (pubkey: string) => void;
  onClose: () => void;
}) {
  const members = props.group.info.members.pubkeys;
  const admins = props.group.groupData?.adminPubkeys ?? [];
  const iAmAdmin = groupIsAdmin(props.group, props.mePubkey);
  const [cursor, setCursor] = useState(0);
  const index = members.length ? Math.min(cursor, members.length - 1) : 0;
  const selected = members[index];
  const selectedIsAdmin = selected ? admins.includes(selected) : false;
  const selectedIsSelf = selected === props.mePubkey;

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      props.onClose();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setCursor((c) => Math.min(c + 1, Math.max(0, members.length - 1)));
      return;
    }
    if (key.name === "up" || key.name === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (!iAmAdmin || !selected) return;
    if (key.name === "a") {
      if (selectedIsAdmin) props.onDemote(selected);
      else props.onPromote(selected);
      return;
    }
    // Removing yourself goes through "leave" (L) instead — guarded here so an
    // admin can't accidentally kick themselves and orphan the group.
    if (key.name === "x" && !selectedIsSelf) {
      props.onRemove(selected);
      return;
    }
  });

  const adminHint = selectedIsAdmin ? "demote" : "make";

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      shouldFill={false}
      justifyContent="center"
      alignItems="center"
    >
      <box
        border
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        width={84}
        height="70%"
        flexDirection="column"
        title=" group members "
      >
        <text fg="#FFD700">
          {groupName(props.group)}
          <span fg="#666">
            {" · "}
            {members.length} member(s) · {admins.length} admin(s)
          </span>
        </text>

        <scrollbox flexGrow={1} marginTop={1} paddingX={1}>
          <box flexDirection="column">
            {members.length ? (
              members.map((pubkey, i) => (
                <MemberRow
                  key={pubkey}
                  pubkey={pubkey}
                  isAdmin={admins.includes(pubkey)}
                  isSelf={pubkey === props.mePubkey}
                  active={i === index}
                />
              ))
            ) : (
              <text fg="#666">no members decoded</text>
            )}
          </box>
        </scrollbox>

        <text fg="#666">
          {iAmAdmin
            ? `j/k: move · a: ${adminHint} admin${selectedIsSelf ? "" : " · x: remove"} · esc: close`
            : "j/k: move · esc: close · only admins can manage members"}
        </text>
      </box>
    </box>
  );
}
