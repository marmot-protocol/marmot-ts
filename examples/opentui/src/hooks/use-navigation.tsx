import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type { InviteEntry } from "../marmot/controller.js";
import { groupIsAdmin } from "../marmot/format.js";
import { nextPane, prevPane, type Pane } from "../components/focus.js";
import {
  useChat,
  useController,
  useWatchedGroups,
  useWatchedInvites,
} from "./use-marmot.js";
import { useListSelection } from "./use-list-selection.js";

/**
 * App-wide navigation state: which panel has focus, the selection cursor within
 * the groups and invites lists, the compose toggle, and everything derived from
 * those (the selected/active group, the visible invite set, admin flags).
 *
 * Lifting this into a context is what lets Sidebar, ChatView, ProfilePanel and
 * the keyboard handler read/update navigation without App threading a dozen
 * props through each. The live group/invite generators (`groups.watch()` /
 * `watchInvites()`) are consumed here exactly once, so consumers share one
 * subscription instead of each starting their own.
 */
export type Navigation = {
  groups: MarmotGroup[];
  invites: InviteEntry[];
  /** Invites we can actually accept (we still hold the target KeyPackage). */
  joinableInvites: InviteEntry[];
  /** What the invites panel shows — all invites, or joinable-only. */
  visibleInvites: InviteEntry[];
  hiddenInviteCount: number;
  showAllInvites: boolean;
  toggleShowAllInvites: () => void;

  focus: Pane;
  setFocus: (pane: Pane) => void;
  focusNext: () => void;
  focusPrev: () => void;

  groupIndex: number;
  inviteIndex: number;
  /** Move the cursor of whichever list panel currently has focus. */
  moveSelection: (delta: number) => void;

  composing: boolean;
  setComposing: (value: boolean) => void;

  selectedGroup?: MarmotGroup;
  selectedInvite?: InviteEntry;
  activeGroup?: MarmotGroup;
  selectedGroupIsAdmin: boolean;
  activeGroupIsAdmin: boolean;
};

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider(props: { children: ReactNode }) {
  const controller = useController();
  const { me, activeGroupId } = useChat();
  const groups = useWatchedGroups();
  const invites = useWatchedInvites();

  const [focus, setFocus] = useState<Pane>("groups");
  const [showAllInvites, setShowAllInvites] = useState(false);
  const [composing, setComposing] = useState(false);

  const joinableInvites = useMemo(
    () => invites.filter((entry) => entry.joinable),
    [invites],
  );
  const visibleInvites = showAllInvites ? invites : joinableInvites;
  const hiddenInviteCount = invites.length - joinableInvites.length;

  const groupSel = useListSelection(groups.length);
  const inviteSel = useListSelection(visibleInvites.length);

  const selectedGroup = groups[groupSel.index];
  const selectedInvite = visibleInvites[inviteSel.index];
  const activeGroup = groups.find((group) => group.idStr === activeGroupId);
  const selectedGroupIsAdmin = selectedGroup
    ? groupIsAdmin(selectedGroup, me.pubkey)
    : false;
  const activeGroupIsAdmin = activeGroup
    ? groupIsAdmin(activeGroup, me.pubkey)
    : false;

  // While the groups panel has focus, the active group follows the selection so
  // the chat panel previews each group as the user scrolls with j/k. Guarded on
  // a real change because setActive republishes the snapshot on every call.
  useEffect(() => {
    if (focus !== "groups" || !selectedGroup) return;
    if (selectedGroup.idStr === activeGroupId) return;
    controller.setActive(selectedGroup.idStr);
  }, [focus, selectedGroup, activeGroupId, controller]);

  // Composing is only valid while the chat panel has focus. If focus moves
  // elsewhere (e.g. a click on another panel, bypassing the keyboard handler),
  // stop composing so the <input> releases keyboard focus.
  useEffect(() => {
    if (focus !== "chat" && composing) setComposing(false);
  }, [focus, composing]);

  const value: Navigation = {
    groups,
    invites,
    joinableInvites,
    visibleInvites,
    hiddenInviteCount,
    showAllInvites,
    toggleShowAllInvites: () => {
      setShowAllInvites((v) => !v);
      inviteSel.set(0);
    },
    focus,
    setFocus,
    focusNext: () => setFocus((pane) => nextPane(pane)),
    focusPrev: () => setFocus((pane) => prevPane(pane)),
    groupIndex: groupSel.index,
    inviteIndex: inviteSel.index,
    moveSelection: (delta) => {
      if (focus === "groups") groupSel.move(delta);
      else if (focus === "invites") inviteSel.move(delta);
    },
    composing,
    setComposing,
    selectedGroup,
    selectedInvite,
    activeGroup,
    selectedGroupIsAdmin,
    activeGroupIsAdmin,
  };

  return (
    <NavigationContext.Provider value={value}>
      {props.children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): Navigation {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation used outside NavigationProvider");
  return ctx;
}
