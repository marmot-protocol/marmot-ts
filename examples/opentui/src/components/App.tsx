import { useEffect, useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

import {
  useChat,
  useController,
  useWatchedGroups,
  useWatchedInvites,
} from "../hooks/use-marmot.js";
import { ActivityLog } from "./ActivityLog.js";
import { ChatView } from "./ChatView.js";
import { ChoicePrompt } from "./ChoicePrompt.js";
import { Header } from "./Header.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { KeybindingFooter, type KeyHint } from "./KeybindingFooter.js";
import { ProfileModal } from "./ProfileModal.js";
import { QrModal } from "./QrModal.js";
import { RelaysModal } from "./RelaysModal.js";
import { Sidebar } from "./Sidebar.js";
import { TextPrompt } from "./TextPrompt.js";
import { nextPane, type Pane, prevPane } from "./focus.js";

type Modal =
  | { kind: "new" }
  | { kind: "invite" }
  | { kind: "keypkg" }
  | { kind: "profile" }
  | { kind: "relays" }
  | { kind: "myqr" }
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

export function App(props: { onQuit: () => void }) {
  const controller = useController();
  const { me, activeGroupId, profile, outboxRelays, inboxRelays, status } =
    useChat();
  const groups = useWatchedGroups();
  const invites = useWatchedInvites();

  const started = useRef(false);
  const [focus, setFocus] = useState<Pane>("groups");
  const [groupIndex, setGroupIndex] = useState(0);
  const [inviteIndex, setInviteIndex] = useState(0);
  const [activityIndex, setActivityIndex] = useState(0);
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
  useEffect(
    () => setActivityIndex((index) => clamp(index, status.slice(-8).length)),
    [status],
  );

  const selectedGroup = groups[groupIndex];
  const activeGroup = groups.find((group) => group.idStr === activeGroupId);
  const selectedInvite = invites[inviteIndex];

  const moveSelection = (delta: number): void => {
    if (focus === "groups") {
      setGroupIndex((index) => clamp(index + delta, groups.length));
    } else if (focus === "invites") {
      setInviteIndex((index) => clamp(index + delta, invites.length));
    } else if (focus === "activity") {
      setActivityIndex((index) =>
        clamp(index + delta, status.slice(-8).length),
      );
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
      { key: "j/k", label: "move" },
      { key: "enter", label: "open" },
      { key: "n", label: "new group" },
      { key: "i", label: "invite" },
      { key: "L", label: "leave active" },
    ],
    invites: [
      { key: "j/k", label: "move" },
      { key: "enter", label: "accept" },
      { key: "a", label: "accept" },
    ],
    chat: [
      { key: "n", label: "compose" },
      { key: "i", label: "invite" },
    ],
    activity: [
      { key: "j/k", label: "move" },
      { key: "r", label: "relays" },
      { key: "p", label: "profile" },
      { key: "K", label: "key package" },
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
      modal?.kind === "invite" ||
      modal?.kind === "profile" ||
      modal?.kind === "relays";

    if (textInputFocused && isTextEntryKey(key)) return;

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
      else if (matches(key, "L")) void controller.leave();
    } else if (focus === "invites") {
      if (matches(key, "a")) acceptInvite();
    } else if (focus === "chat") {
      if (matches(key, "n")) setComposing(true);
      else if (matches(key, "i")) inviteToActive();
    } else if (focus === "activity") {
      if (matches(key, "r")) setModal({ kind: "relays" });
      else if (matches(key, "p")) setModal({ kind: "profile" });
      else if (matches(key, "K")) setModal({ kind: "keypkg" });
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
        <box flexGrow={1} flexDirection="column">
          <ChatView
            activeGroup={activeGroup}
            focused={focus === "chat"}
            composing={composing}
            onFocusInput={() => setFocus("chat")}
            onDoneComposing={() => setComposing(false)}
          />
          <ActivityLog
            focused={focus === "activity"}
            selectedIndex={activityIndex}
            onFocus={() => setFocus("activity")}
          />
        </box>
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
            setModal(null);
            const name = value.trim();
            if (name) void controller.createGroup(name);
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
            if (target) void controller.invite(target);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "keypkg" && (
        <ChoicePrompt
          title="key package"
          options={[
            { name: "Publish a fresh KeyPackage", description: "" },
            { name: "Rotate this device's KeyPackage", description: "" },
          ]}
          onSelect={(index) => {
            setModal(null);
            if (index === 0) void controller.publishKeyPackage();
            else void controller.rotateKeyPackage();
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === "profile" && (
        <ProfileModal
          profile={profile}
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
