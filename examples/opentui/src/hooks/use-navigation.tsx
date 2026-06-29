import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type { ChatMessage, InviteEntry } from "../marmot/controller.js";
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

  /**
   * True while picking a message to reply to (entered with `r` in the chat
   * panel). Only in this mode is the timeline cursor active and shown.
   */
  replySelecting: boolean;
  /** Cursor into the active group's timeline (defaults to the newest). */
  selectedMessageIndex: number;
  /** The message the chat cursor points at, if any. */
  selectedMessage?: ChatMessage;
  /** Enter reply-select mode (no-op when there's nothing to reply to). */
  startReplySelect: () => void;
  /** Leave reply-select mode without choosing a target. */
  cancelReplySelect: () => void;
  /** Confirm the cursor's message as the reply target and start composing. */
  confirmReplySelect: () => void;

  /**
   * True while picking a message to react to (entered with `c` in the chat
   * panel). Shares the timeline cursor with reply-select; the two are mutually
   * exclusive.
   */
  reactSelecting: boolean;
  /** Enter react-select mode (no-op when there's nothing to react to). */
  startReactSelect: () => void;
  /** Leave react-select mode without reacting. */
  cancelReactSelect: () => void;
  /** React to the cursor's message with `emoji`, then leave react-select mode. */
  reactWith: (emoji: string) => void;

  /**
   * True while picking a message whose attachments to save to disk (entered
   * with `s` in the chat panel). Shares the timeline cursor with the other
   * picker modes; all three are mutually exclusive.
   */
  saveSelecting: boolean;
  /** Enter save-select mode (no-op when there's nothing in the timeline). */
  startSaveSelect: () => void;
  /** Leave save-select mode without saving. */
  cancelSaveSelect: () => void;
  /** Save the cursor message's downloaded attachments, then leave the mode. */
  confirmSaveSelect: () => void;

  /** The message a new send should reply to (NIP-C7 `q` tag), if any. */
  replyTarget?: ChatMessage;
  setReplyTarget: (message: ChatMessage | undefined) => void;

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
  const { me, activeGroupId, messages } = useChat();
  const groups = useWatchedGroups();
  const invites = useWatchedInvites();

  const [focus, setFocus] = useState<Pane>("groups");
  const [showAllInvites, setShowAllInvites] = useState(false);
  const [composing, setComposing] = useState(false);
  // Reply-select mode: only while picking a reply target is the timeline cursor
  // active. `messageCursor === null` resolves to the newest message, so the
  // picker starts at the bottom (matching the sticky scroll) and j/k walk up.
  const [replySelecting, setReplySelecting] = useState(false);
  // React-select mode shares the timeline cursor with reply-select; only one is
  // ever active at a time (each entry point clears the others).
  const [reactSelecting, setReactSelecting] = useState(false);
  // Save-select mode: pick a message whose downloaded attachments to write to
  // disk. Shares the timeline cursor with the other two picker modes.
  const [saveSelecting, setSaveSelecting] = useState(false);
  const [messageCursor, setMessageCursor] = useState<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | undefined>(
    undefined,
  );

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

  const activeMessages = activeGroupId ? (messages[activeGroupId] ?? []) : [];
  // Resolve the cursor: an explicit pick (clamped) or the newest message.
  const selectedMessageIndex =
    activeMessages.length === 0
      ? 0
      : messageCursor === null
        ? activeMessages.length - 1
        : Math.max(0, Math.min(messageCursor, activeMessages.length - 1));
  const selectedMessage = activeMessages[selectedMessageIndex];

  // The three timeline-picker modes are mutually exclusive; entering one clears
  // the others and restarts the cursor at the newest message.
  const enterPicker = (set: (on: boolean) => void) => {
    if (!selectedMessage) return; // nothing in the timeline to pick
    setReplySelecting(false);
    setReactSelecting(false);
    setSaveSelecting(false);
    setMessageCursor(null);
    set(true);
  };

  const startReplySelect = () => enterPicker(setReplySelecting);
  const cancelReplySelect = () => {
    setReplySelecting(false);
    setMessageCursor(null);
  };
  const confirmReplySelect = () => {
    if (selectedMessage) {
      setReplyTarget(selectedMessage);
      setComposing(true);
    }
    setReplySelecting(false);
    setMessageCursor(null);
  };

  const startReactSelect = () => enterPicker(setReactSelecting);
  const cancelReactSelect = () => {
    setReactSelecting(false);
    setMessageCursor(null);
  };
  const reactWith = (emoji: string) => {
    if (selectedMessage) {
      void controller
        .sendReaction(selectedMessage, emoji)
        .catch((err) => controller.logError(err));
    }
    setReactSelecting(false);
    setMessageCursor(null);
  };

  const startSaveSelect = () => enterPicker(setSaveSelecting);
  const cancelSaveSelect = () => {
    setSaveSelecting(false);
    setMessageCursor(null);
  };
  const confirmSaveSelect = () => {
    if (selectedMessage) {
      void controller
        .saveMessageAttachments(selectedMessage)
        .catch((err) => controller.logError(err));
    }
    setSaveSelecting(false);
    setMessageCursor(null);
  };

  // Switching groups exits reply-select, resets the cursor, and drops any
  // pending reply target (it belonged to the previous group's timeline).
  useEffect(() => {
    setReplySelecting(false);
    setReactSelecting(false);
    setSaveSelecting(false);
    setMessageCursor(null);
    setReplyTarget(undefined);
  }, [activeGroupId]);

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
      else if (focus === "chat")
        setMessageCursor((cursor) => {
          if (activeMessages.length === 0) return null;
          const from = cursor ?? activeMessages.length - 1;
          return Math.max(0, Math.min(from + delta, activeMessages.length - 1));
        });
    },
    replySelecting,
    selectedMessageIndex,
    selectedMessage,
    startReplySelect,
    cancelReplySelect,
    confirmReplySelect,
    reactSelecting,
    startReactSelect,
    cancelReactSelect,
    reactWith,
    saveSelecting,
    startSaveSelect,
    cancelSaveSelect,
    confirmSaveSelect,
    replyTarget,
    setReplyTarget,
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
