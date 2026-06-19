import { useEffect, useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

import {
  useChat,
  useController,
  useWatchedGroups,
  useWatchedInvites,
} from "../hooks/use-marmot.js";
import { useProfile } from "../hooks/use-profile.js";
import { ChatView } from "./ChatView.js";
import { ChoicePrompt } from "./ChoicePrompt.js";
import { GroupDebugModal } from "./GroupDebugModal.js";
import { GroupInfoModal } from "./GroupInfoModal.js";
import { Header } from "./Header.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { InviteModal } from "./InviteModal.js";
import { KeyPackageModal } from "./KeyPackageModal.js";
import { KeybindingFooter, type KeyHint } from "./KeybindingFooter.js";
import { MembersModal } from "./MembersModal.js";
import { NewAccountModal } from "./NewAccountModal.js";
import { ProfileModal } from "./ProfileModal.js";
import { ProfilePanel } from "./ProfilePanel.js";
import { QrModal } from "./QrModal.js";
import { RelaysModal } from "./RelaysModal.js";
import { Sidebar } from "./Sidebar.js";
import { TextPrompt } from "./TextPrompt.js";
import { nextPane, type Pane, prevPane } from "./focus.js";
import { groupIsAdmin } from "../marmot/format.js";
import type { InviteCandidates } from "../marmot/controller.js";

type Modal =
  | { kind: "new" }
  | { kind: "new-relays"; name: string }
  | { kind: "new-manual-relays"; name: string }
  | { kind: "invite" }
  | { kind: "invite-select"; data: InviteCandidates }
  | { kind: "keypkg" }
  | { kind: "groupdebug"; groupId: string }
  | { kind: "groupinfo"; groupId: string }
  | { kind: "members"; groupId: string }
  | { kind: "profile" }
  | { kind: "relays" }
  | { kind: "myqr" }
  | { kind: "newaccount" }
  | { kind: "help" }
  | null;

type Key = {
  name?: string;
  sequence?: string;
  shift?: boolean | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  option?: boolean | undefined;
};

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function matches(key: Key, binding: string): boolean {
  if (binding === "shift+tab") return key.name === "tab" && key.shift === true;
  if (binding === "ctrl+c") return key.name === "c" && key.ctrl === true;
  if (binding.length === 1 && binding >= "A" && binding <= "Z") {
    return (
      key.sequence === binding ||
      (key.name === binding.toLowerCase() && key.shift === true)
    );
  }
  if (binding.length === 1 && binding >= "a" && binding <= "z") {
    return key.sequence === binding || (key.name === binding && !key.shift);
  }
  if (binding === "enter") return key.name === "return" || key.name === "enter";
  if (binding === "esc") return key.name === "escape";
  return key.name === binding || key.sequence === binding;
}

function isTextEntryKey(key: Key): boolean {
  if (key.ctrl || key.meta || key.option) return false;
  return key.sequence?.length === 1 || key.name?.length === 1;
}

function parseRelays(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

export function App(props: {
  onQuit: () => void;
  onLogout: (params: { name: string; relays: string[] }) => void;
}) {
  const controller = useController();
  const { me, activeGroupId, outboxRelays, inboxRelays, keyPackages } =
    useChat();
  const myProfile = useProfile(me.pubkey);
  const groups = useWatchedGroups();
  const invites = useWatchedInvites();

  const started = useRef(false);
  const [focus, setFocus] = useState<Pane>("groups");
  const [groupIndex, setGroupIndex] = useState(0);
  const [inviteIndex, setInviteIndex] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    controller.start().catch((err) => controller.logError(err));
  }, [controller]);

  useEffect(
    () => setGroupIndex((index) => clamp(index, groups.length)),
    [groups],
  );
  useEffect(
    () => setInviteIndex((index) => clamp(index, invites.length)),
    [invites],
  );
  const selectedGroup = groups[groupIndex];
  const activeGroup = groups.find((group) => group.idStr === activeGroupId);
  const selectedInvite = invites[inviteIndex];
  const selectedGroupIsAdmin = selectedGroup
    ? groupIsAdmin(selectedGroup, me.pubkey)
    : false;
  const activeGroupIsAdmin = activeGroup
    ? groupIsAdmin(activeGroup, me.pubkey)
    : false;

  // While the groups panel has focus, the active group follows the selection so
  // the chat panel previews each group as the user scrolls through the list with
  // j/k. Enter then just focuses the chat panel (see activateGroup). Guarded on a
  // real change because setActive republishes the snapshot on every call.
  useEffect(() => {
    if (focus !== "groups" || !selectedGroup) return;
    if (selectedGroup.idStr === activeGroupId) return;
    controller.setActive(selectedGroup.idStr);
  }, [focus, selectedGroup, activeGroupId, controller]);

  // Composing is only valid while the chat panel has focus. If focus moves
  // elsewhere (e.g. a mouse click on another panel, which bypasses the keyboard
  // handler), stop composing so the <input> releases keyboard focus — otherwise
  // it keeps capturing keys and every global shortcut is blocked.
  useEffect(() => {
    if (focus !== "chat" && composing) setComposing(false);
  }, [focus, composing]);

  const moveSelection = (delta: number): void => {
    if (focus === "groups") {
      setGroupIndex((index) => clamp(index + delta, groups.length));
    } else if (focus === "invites") {
      setInviteIndex((index) => clamp(index + delta, invites.length));
    }
  };

  const activateGroup = (): void => {
    if (!selectedGroup) return;
    controller.setActive(selectedGroup.idStr);
    setFocus("chat");
  };

  const inviteToActive = (): void => {
    if (!activeGroupId) return;
    setModal({ kind: "invite" });
  };

  const acceptInvite = (): void => {
    if (!selectedInvite) return;
    void controller.joinInvite(selectedInvite.id);
    setFocus("chat");
  };

  const panelHints: Record<Pane, KeyHint[]> = {
    groups: [
      { key: "j/k", label: "switch group" },
      { key: "enter", label: "open chat" },
      { key: "n", label: "new group" },
      { key: "i", label: "invite" },
      { key: "m", label: "members" },
      ...(selectedGroupIsAdmin ? [{ key: "e", label: "edit info" }] : []),
      { key: "L", label: "leave active" },
    ],
    invites: [
      { key: "j/k", label: "move" },
      { key: "enter", label: "accept" },
      { key: "a", label: "accept" },
      { key: "r", label: "relays" },
      { key: "p", label: "profile" },
    ],
    chat: composing
      ? [
          { key: "enter", label: "send" },
          { key: "esc", label: "stop composing" },
        ]
      : [
          { key: "n", label: "compose" },
          { key: "u", label: "load older" },
          { key: "i", label: "invite" },
          { key: "m", label: "members" },
          { key: "g", label: "group info" },
          ...(activeGroupIsAdmin ? [{ key: "e", label: "edit info" }] : []),
          { key: "r", label: "relays" },
          { key: "p", label: "profile" },
          { key: "K", label: "key package" },
        ],
    profile: [
      { key: "i", label: "invite QR" },
      { key: "p", label: "edit profile" },
      { key: "r", label: "edit relays" },
      { key: "K", label: "key package" },
      { key: "o", label: "new account" },
    ],
  };

  const globalHints: KeyHint[] = [
    { key: "tab", label: "next panel" },
    { key: "shift+tab", label: "prev panel" },
    { key: "?", label: "help" },
    { key: "q", label: "quit/back" },
  ];

  useKeyboard((key: Key) => {
    if (matches(key, "ctrl+c")) {
      props.onQuit();
      return;
    }

    const textInputFocused =
      composing ||
      modal?.kind === "new" ||
      modal?.kind === "new-manual-relays" ||
      modal?.kind === "invite" ||
      modal?.kind === "groupinfo" ||
      modal?.kind === "profile" ||
      modal?.kind === "relays" ||
      modal?.kind === "newaccount";

    // Let Escape through even while a text input is focused, so it can exit
    // composing (and other modals' own handlers can act on it).
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

    if (composing) {
      if (matches(key, "esc")) setComposing(false);
      return;
    }

    if (matches(key, "tab")) {
      setFocus((pane) => nextPane(pane));
      return;
    }
    if (matches(key, "shift+tab")) {
      setFocus((pane) => prevPane(pane));
      return;
    }
    if (matches(key, "?") || matches(key, ":")) {
      setModal({ kind: "help" });
      return;
    }
    if (matches(key, "q")) {
      props.onQuit();
      return;
    }
    if (matches(key, "down") || matches(key, "j")) {
      moveSelection(1);
      return;
    }
    if (matches(key, "up") || matches(key, "k")) {
      moveSelection(-1);
      return;
    }
    if (matches(key, "h") || matches(key, "left")) {
      setFocus((pane) => prevPane(pane));
      return;
    }
    if (matches(key, "l") || matches(key, "right")) {
      setFocus((pane) => nextPane(pane));
      return;
    }
    if (matches(key, "enter")) {
      if (focus === "groups") activateGroup();
      else if (focus === "invites") acceptInvite();
      else if (focus === "chat") setComposing(true);
      return;
    }

    if (focus === "groups") {
      if (matches(key, "n")) setModal({ kind: "new" });
      else if (matches(key, "i")) inviteToActive();
      else if (matches(key, "m") && selectedGroup) {
        setModal({ kind: "members", groupId: selectedGroup.idStr });
      } else if (matches(key, "e") && selectedGroupIsAdmin && selectedGroup) {
        setModal({ kind: "groupinfo", groupId: selectedGroup.idStr });
      } else if (matches(key, "L")) void controller.leave();
    } else if (focus === "invites") {
      if (matches(key, "a")) acceptInvite();
      else if (matches(key, "r")) setModal({ kind: "relays" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
    } else if (focus === "chat") {
      if (matches(key, "n")) setComposing(true);
      else if (matches(key, "u") && activeGroupId)
        void controller.loadOlder(activeGroupId);
      else if (matches(key, "i")) inviteToActive();
      else if (matches(key, "m") && activeGroupId) {
        setModal({ kind: "members", groupId: activeGroupId });
      } else if (matches(key, "g") && activeGroupId) {
        setModal({ kind: "groupdebug", groupId: activeGroupId });
      } else if (matches(key, "e") && activeGroupIsAdmin && activeGroupId) {
        setModal({ kind: "groupinfo", groupId: activeGroupId });
      } else if (matches(key, "r")) setModal({ kind: "relays" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
      else if (matches(key, "K")) setModal({ kind: "keypkg" });
    } else if (focus === "profile") {
      if (matches(key, "i")) setModal({ kind: "myqr" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
      else if (matches(key, "r")) setModal({ kind: "relays" });
      else if (matches(key, "K")) setModal({ kind: "keypkg" });
      else if (matches(key, "o")) setModal({ kind: "newaccount" });
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#0e0e16"
    >
      <Header
        groupCount={groups.length}
        inviteCount={invites.length}
        onShowQr={() => setModal({ kind: "myqr" })}
      />

      <box flexGrow={1} flexDirection="row">
        <Sidebar
          groups={groups}
          invites={invites}
          activeId={activeGroupId}
          focus={focus}
          groupIndex={groupIndex}
          inviteIndex={inviteIndex}
          onFocusPane={setFocus}
        />
        <ChatView
          activeGroup={activeGroup}
          focused={focus === "chat"}
          composing={composing}
          onFocusInput={() => setFocus("chat")}
        />
        <ProfilePanel
          focused={focus === "profile"}
          hints={panelHints.profile}
          onFocus={() => setFocus("profile")}
        />
      </box>

      <KeybindingFooter
        title={focus}
        hints={[...panelHints[focus], ...globalHints]}
      />

      {modal?.kind === "help" && (
        <HelpOverlay
          panel={focus}
          global={globalHints}
          panelHints={panelHints[focus]}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "new" && (
        <TextPrompt
          title="new group"
          placeholder="group name"
          onSubmit={(value) => {
            const name = value.trim();
            setModal(name ? { kind: "new-relays", name } : null);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "new-relays" && (
        <ChoicePrompt
          title="group relays"
          options={[
            {
              name: "Use default outbox relays",
              description: outboxRelays.join(", ") || "none loaded",
            },
            {
              name: "Enter relays manually",
              description: "space or comma separated relay URLs/domains",
            },
          ]}
          onSelect={(index) => {
            if (index === 0) {
              setModal(null);
              void controller.createGroup(modal.name, outboxRelays);
            } else {
              setModal({ kind: "new-manual-relays", name: modal.name });
            }
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "new-manual-relays" && (
        <TextPrompt
          title="group relays"
          placeholder="relay.damus.io, wss://relay.primal.net"
          onSubmit={(value) => {
            setModal(null);
            void controller.createGroup(modal.name, parseRelays(value));
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "invite" && (
        <TextPrompt
          title="invite to the active group"
          placeholder="npub or hex pubkey"
          onSubmit={(value) => {
            setModal(null);
            const target = value.trim();
            if (!target) return;
            void controller.loadInviteCandidates(target).then((data) => {
              if (data) setModal({ kind: "invite-select", data });
            });
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "invite-select" && (
        <InviteModal
          data={modal.data}
          onConfirm={(events) => {
            const { groupId } = modal.data;
            setModal(null);
            void controller.inviteKeyPackages(groupId, events);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "groupinfo" &&
        groups.find((group) => group.idStr === modal.groupId) && (
          <GroupInfoModal
            group={groups.find((group) => group.idStr === modal.groupId)!}
            onSave={(fields) => {
              const name = fields.name.trim();
              setModal(null);
              void controller.updateGroupInfo(modal.groupId, {
                name,
                description: fields.description.trim(),
              });
            }}
            onCancel={() => setModal(null)}
          />
        )}
      {modal?.kind === "groupdebug" &&
        groups.find((group) => group.idStr === modal.groupId) && (
          <GroupDebugModal
            group={groups.find((group) => group.idStr === modal.groupId)!}
            onClose={() => setModal(null)}
          />
        )}
      {modal?.kind === "members" &&
        groups.find((group) => group.idStr === modal.groupId) && (
          <MembersModal
            group={groups.find((group) => group.idStr === modal.groupId)!}
            mePubkey={me.pubkey}
            onPromote={(pubkey) =>
              void controller.setMemberAdmin(modal.groupId, pubkey, true)
            }
            onDemote={(pubkey) =>
              void controller.setMemberAdmin(modal.groupId, pubkey, false)
            }
            onRemove={(pubkey) =>
              void controller.removeMember(modal.groupId, pubkey)
            }
            onClose={() => setModal(null)}
          />
        )}
      {modal?.kind === "keypkg" && (
        <KeyPackageModal
          summary={keyPackages}
          onPublish={() => {
            setModal(null);
            void controller.publishKeyPackage();
          }}
          onRotate={() => {
            setModal(null);
            void controller.rotateKeyPackage();
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "profile" && (
        <ProfileModal
          profile={myProfile?.metadata ?? null}
          onSave={(fields) => {
            setModal(null);
            void controller.saveProfile(fields);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "myqr" && (
        <QrModal npub={me.npub} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "newaccount" && (
        <NewAccountModal
          onSubmit={(params) => {
            setModal(null);
            props.onLogout(params);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "relays" && (
        <RelaysModal
          outbox={outboxRelays}
          inbox={inboxRelays}
          onSave={(outbox, inbox) => {
            setModal(null);
            void controller.saveRelayLists(outbox, inbox);
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </box>
  );
}
