import { useKeyboard } from "@opentui/react";

import { isTextEntryKey, matches, type Key } from "../components/keys.js";
import { REACTION_EMOJIS } from "../components/reactions.js";
import type { Modal } from "../components/ModalHost.js";
import { useChat, useController } from "./use-marmot.js";
import { useNavigation } from "./use-navigation.js";

/**
 * The app's global keyboard handler, lifted out of App. Dispatches keys to
 * navigation (focus, selection), opens modals, and triggers controller actions,
 * reading all the state it needs from the navigation and chat contexts.
 *
 * A key is swallowed by a focused text input (compose box or a form modal)
 * before it reaches the shortcuts here — Escape is the one exception, so it can
 * always exit composing or a modal.
 */
export function useAppKeybindings(props: {
  modal: Modal;
  setModal: (modal: Modal) => void;
  onQuit: () => void;
}) {
  const { modal, setModal, onQuit } = props;
  const controller = useController();
  const { activeGroupId } = useChat();
  const nav = useNavigation();

  const activateGroup = (): void => {
    if (!nav.selectedGroup) return;
    controller.setActive(nav.selectedGroup.idStr);
    nav.setFocus("chat");
  };

  const inviteToActive = (): void => {
    if (!activeGroupId) return;
    setModal({ kind: "invite" });
  };

  // Accepting goes through the details modal: review the group/inviter first,
  // then confirm the join from there.
  const openInviteDetails = (): void => {
    if (!nav.selectedInvite) return;
    setModal({
      kind: "invite-details",
      inviteId: nav.selectedInvite.invite.id,
    });
  };

  const dismissInvite = (): void => {
    if (!nav.selectedInvite) return;
    void controller.dismissInvite(nav.selectedInvite.invite.id);
  };

  useKeyboard((key: Key) => {
    if (matches(key, "ctrl+c")) {
      onQuit();
      return;
    }

    const textInputFocused =
      nav.composing ||
      modal?.kind === "new" ||
      modal?.kind === "new-manual-relays" ||
      modal?.kind === "invite" ||
      modal?.kind === "groupinfo" ||
      modal?.kind === "profile" ||
      modal?.kind === "relays" ||
      modal?.kind === "newaccount";

    // Let Escape through even while a text input is focused, so it can exit
    // composing (and modals' own handlers can act on it).
    if (textInputFocused && isTextEntryKey(key) && !matches(key, "esc")) return;

    if (modal) {
      if (
        modal.kind === "help" &&
        (matches(key, "esc") || matches(key, "q") || matches(key, "?"))
      ) {
        setModal(null);
      }
      return;
    }

    if (nav.composing) {
      // A single Escape cancels composing and any in-progress reply.
      if (matches(key, "esc")) {
        nav.setComposing(false);
        nav.setReplyTarget(undefined);
      }
      return;
    }

    // Reply-select is a modal sub-mode of the chat panel: j/k move the timeline
    // cursor, Enter confirms the target (and starts composing), Esc cancels.
    // Every other key is swallowed so it can't trigger a panel action.
    if (nav.replySelecting) {
      if (matches(key, "esc")) nav.cancelReplySelect();
      else if (matches(key, "down") || matches(key, "j")) nav.moveSelection(1);
      else if (matches(key, "up") || matches(key, "k")) nav.moveSelection(-1);
      else if (matches(key, "enter")) nav.confirmReplySelect();
      return;
    }

    // React-select mirrors reply-select: j/k move the timeline cursor, the
    // number keys 1..N pick an emoji from the palette (and react), Esc cancels.
    if (nav.reactSelecting) {
      if (matches(key, "esc")) nav.cancelReactSelect();
      else if (matches(key, "down") || matches(key, "j")) nav.moveSelection(1);
      else if (matches(key, "up") || matches(key, "k")) nav.moveSelection(-1);
      else {
        const choice = REACTION_EMOJIS.findIndex((_, i) =>
          matches(key, String(i + 1)),
        );
        if (choice >= 0) nav.reactWith(REACTION_EMOJIS[choice]);
      }
      return;
    }

    if (matches(key, "tab")) return nav.focusNext();
    if (matches(key, "shift+tab")) return nav.focusPrev();
    if (matches(key, "?") || matches(key, ":")) {
      return setModal({ kind: "help" });
    }
    if (matches(key, "q")) return onQuit();
    if (matches(key, "down") || matches(key, "j")) return nav.moveSelection(1);
    if (matches(key, "up") || matches(key, "k")) return nav.moveSelection(-1);
    if (matches(key, "h") || matches(key, "left")) return nav.focusPrev();
    if (matches(key, "l") || matches(key, "right")) return nav.focusNext();
    if (matches(key, "enter")) {
      if (nav.focus === "groups") activateGroup();
      else if (nav.focus === "invites") openInviteDetails();
      else if (nav.focus === "chat") nav.setComposing(true);
      return;
    }

    if (nav.focus === "groups") {
      if (matches(key, "n")) setModal({ kind: "new" });
      else if (matches(key, "i")) inviteToActive();
      else if (matches(key, "m") && nav.selectedGroup) {
        setModal({ kind: "members", groupId: nav.selectedGroup.idStr });
      } else if (
        matches(key, "e") &&
        nav.selectedGroupIsAdmin &&
        nav.selectedGroup
      ) {
        setModal({ kind: "groupinfo", groupId: nav.selectedGroup.idStr });
      } else if (matches(key, "L")) void controller.leave();
    } else if (nav.focus === "invites") {
      if (matches(key, "a")) openInviteDetails();
      else if (matches(key, "d")) dismissInvite();
      else if (matches(key, "f")) nav.toggleShowAllInvites();
    } else if (nav.focus === "chat") {
      if (matches(key, "n")) nav.setComposing(true);
      else if (matches(key, "u") && activeGroupId)
        void controller.loadOlder(activeGroupId);
      else if (matches(key, "i")) inviteToActive();
      else if (matches(key, "m") && activeGroupId) {
        setModal({ kind: "members", groupId: activeGroupId });
      } else if (matches(key, "g") && activeGroupId) {
        setModal({ kind: "groupdebug", groupId: activeGroupId });
      } else if (matches(key, "e") && nav.activeGroupIsAdmin && activeGroupId) {
        setModal({ kind: "groupinfo", groupId: activeGroupId });
      } else if (matches(key, "r")) {
        // Enter reply-select mode to pick which message to reply to.
        nav.startReplySelect();
      } else if (matches(key, "c")) {
        // Enter react-select mode to pick which message to react to.
        nav.startReactSelect();
      } else if (matches(key, "R")) setModal({ kind: "relays" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
      else if (matches(key, "K")) setModal({ kind: "keypkg" });
    } else if (nav.focus === "profile") {
      if (matches(key, "i")) setModal({ kind: "myqr" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
      else if (matches(key, "r")) setModal({ kind: "relays" });
      else if (matches(key, "K")) setModal({ kind: "keypkg" });
      else if (matches(key, "o")) setModal({ kind: "newaccount-confirm" });
    }
  });
}
