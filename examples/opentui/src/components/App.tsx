import { useEffect, useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

import {
  useChat,
  useController,
  useWatchedGroups,
  useWatchedInvites,
} from "../hooks/use-marmot.js";
import { ActionBar, type Action } from "./ActionBar.js";
import { ActivityLog } from "./ActivityLog.js";
import { ChatView } from "./ChatView.js";
import { ChoicePrompt } from "./ChoicePrompt.js";
import { Header } from "./Header.js";
import { ProfileModal } from "./ProfileModal.js";
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
  | null;

/**
 * Root layout and interaction controller. Manages focus across panes (Tab),
 * the action bar, and modal prompts, then wires the controller snapshot and the
 * two library async generators (groups + invites) into the tree.
 */
export function App(props: { onQuit: () => void }) {
  const controller = useController();
  const { activeGroupId, profile, outboxRelays, inboxRelays } = useChat();
  const groups = useWatchedGroups();
  const invites = useWatchedInvites();

  const started = useRef(false);
  const [focus, setFocus] = useState<Pane>("input");
  const [actionIndex, setActionIndex] = useState(0);
  const [modal, setModal] = useState<Modal>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    controller.start().catch((err) => controller.logError(err));
  }, [controller]);

  const actions: Action[] = [
    { label: "New group", run: () => setModal({ kind: "new" }) },
    { label: "Invite", run: () => setModal({ kind: "invite" }) },
    { label: "Leave", run: () => void controller.leave() },
    { label: "Profile", run: () => setModal({ kind: "profile" }) },
    { label: "Relays", run: () => setModal({ kind: "relays" }) },
    { label: "KeyPkg", run: () => setModal({ kind: "keypkg" }) },
    { label: "Quit", run: props.onQuit },
  ];

  useKeyboard((key) => {
    if (modal) return; // modals handle their own keys (incl. Esc)

    if (key.name === "tab") {
      setFocus((pane) => (key.shift ? prevPane(pane) : nextPane(pane)));
      return;
    }

    // groups/invites keys are handled by their focused <select>; the input by
    // its focused <input>. Only the action bar needs manual key handling.
    if (focus === "actions") {
      if (key.name === "left") {
        setActionIndex((i) => (i - 1 + actions.length) % actions.length);
      } else if (key.name === "right") {
        setActionIndex((i) => (i + 1) % actions.length);
      } else if (key.name === "return" || key.name === "enter") {
        actions[actionIndex].run();
      }
    }
  });

  const activeGroup = groups.find((group) => group.idStr === activeGroupId);
  const modalOpen = modal !== null;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#0e0e16"
    >
      <Header groupCount={groups.length} inviteCount={invites.length} />

      <box flexGrow={1} flexDirection="row">
        <Sidebar
          groups={groups}
          invites={invites}
          activeId={activeGroupId}
          focus={focus}
          modalOpen={modalOpen}
          onFocusPane={setFocus}
          onPreviewGroup={(id) => controller.setActive(id)}
          onConfirmGroup={(id) => {
            controller.setActive(id);
            setFocus("input");
          }}
          onAcceptInvite={(id) => {
            void controller.joinInvite(id);
            setFocus("input");
          }}
        />
        <ChatView
          activeGroup={activeGroup}
          inputFocused={!modalOpen && focus === "input"}
          onFocusInput={() => setFocus("input")}
        />
      </box>

      <ActionBar
        actions={actions}
        focused={focus === "actions"}
        focusedIndex={actionIndex}
      />
      <text fg="#555">
        {" "}
        Tab: switch pane · ↑/↓: navigate · Enter: select · mouse works too
      </text>
      <ActivityLog />

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
