import { useChat, useController } from "../hooks/use-marmot.js";
import { useNavigation } from "../hooks/use-navigation.js";
import { useProfile } from "../hooks/use-profile.js";
import type { InviteCandidates } from "../marmot/controller.js";
import { parseRelays } from "../marmot/format.js";
import { ChoicePrompt } from "./ChoicePrompt.js";
import { GroupDebugModal } from "./GroupDebugModal.js";
import { GroupInfoModal } from "./GroupInfoModal.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { InviteDetailsModal } from "./InviteDetailsModal.js";
import { InviteModal } from "./InviteModal.js";
import { KeyPackageModal } from "./KeyPackageModal.js";
import { MembersModal } from "./MembersModal.js";
import { ProfileModal } from "./ProfileModal.js";
import { QrModal } from "./QrModal.js";
import { RelaysModal } from "./RelaysModal.js";
import { TextPrompt } from "./TextPrompt.js";
import { globalHints, panelHints } from "./hints.js";

/** Every modal/overlay the app can show, plus the data each one needs. */
export type Modal =
  | { kind: "new" }
  | { kind: "new-relays"; name: string }
  | { kind: "new-manual-relays"; name: string }
  | { kind: "invite" }
  | { kind: "invite-select"; data: InviteCandidates }
  | { kind: "invite-details"; inviteId: string }
  | { kind: "keypkg" }
  | { kind: "groupdebug"; groupId: string }
  | { kind: "groupinfo"; groupId: string }
  | { kind: "members"; groupId: string }
  | { kind: "profile" }
  | { kind: "relays" }
  | { kind: "attach" }
  | { kind: "myqr" }
  | { kind: "help" }
  | null;

/**
 * Renders whichever modal is currently open and wires its callbacks to the
 * controller. Centralising the modal switchboard here (instead of inline in App)
 * keeps App focused on layout, and lets each modal pull the live group / chat /
 * profile state it needs straight from the hooks rather than via drilled props.
 */
export function ModalHost(props: {
  modal: Modal;
  setModal: (modal: Modal) => void;
}) {
  const { modal, setModal } = props;
  const controller = useController();
  const { me, outboxRelays, inboxRelays, keyPackages } = useChat();
  const nav = useNavigation();
  const myProfile = useProfile(me.pubkey);

  if (!modal) return null;

  const groupById = (id: string) =>
    nav.groups.find((group) => group.idStr === id);

  switch (modal.kind) {
    case "help": {
      const hints = panelHints({
        composing: nav.composing,
        replySelecting: nav.replySelecting,
        reactSelecting: nav.reactSelecting,
        saveSelecting: nav.saveSelecting,
        showAllInvites: nav.showAllInvites,
        selectedGroupIsAdmin: nav.selectedGroupIsAdmin,
        activeGroupIsAdmin: nav.activeGroupIsAdmin,
      });
      return (
        <HelpOverlay
          panel={nav.focus}
          global={globalHints({ canUploadAudit: controller.canUploadAudit })}
          panelHints={hints[nav.focus]}
          onClose={() => setModal(null)}
        />
      );
    }
    case "new":
      return (
        <TextPrompt
          title="new group"
          placeholder="group name"
          onSubmit={(value) => {
            const name = value.trim();
            setModal(name ? { kind: "new-relays", name } : null);
          }}
          onCancel={() => setModal(null)}
        />
      );
    case "new-relays":
      return (
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
      );
    case "new-manual-relays":
      return (
        <TextPrompt
          title="group relays"
          placeholder="relay.damus.io, wss://relay.primal.net"
          onSubmit={(value) => {
            setModal(null);
            void controller.createGroup(modal.name, parseRelays(value));
          }}
          onCancel={() => setModal(null)}
        />
      );
    case "invite":
      return (
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
      );
    case "invite-select": {
      const { data } = modal;
      return (
        <InviteModal
          data={data}
          onConfirm={(events) => {
            setModal(null);
            void controller.inviteKeyPackages(data.groupId, events);
          }}
          onCancel={() => setModal(null)}
        />
      );
    }
    case "invite-details": {
      const entry = nav.invites.find((e) => e.invite.id === modal.inviteId);
      if (!entry) return null;
      const inviteId = modal.inviteId;
      return (
        <InviteDetailsModal
          entry={entry}
          onAccept={() => {
            setModal(null);
            void controller.joinInvite(inviteId);
            nav.setFocus("chat");
          }}
          onDismiss={() => {
            setModal(null);
            void controller.dismissInvite(inviteId);
          }}
          onClose={() => setModal(null)}
        />
      );
    }
    case "groupinfo": {
      const group = groupById(modal.groupId);
      if (!group) return null;
      const groupId = modal.groupId;
      return (
        <GroupInfoModal
          group={group}
          onSave={(fields) => {
            setModal(null);
            void controller.updateGroupInfo(groupId, {
              name: fields.name.trim(),
              description: fields.description.trim(),
              blossomServers: fields.blossomServers,
            });
          }}
          onCancel={() => setModal(null)}
        />
      );
    }
    case "groupdebug": {
      const group = groupById(modal.groupId);
      if (!group) return null;
      return <GroupDebugModal group={group} onClose={() => setModal(null)} />;
    }
    case "members": {
      const group = groupById(modal.groupId);
      if (!group) return null;
      const groupId = modal.groupId;
      return (
        <MembersModal
          group={group}
          mePubkey={me.pubkey}
          onPromote={(pubkey) =>
            void controller.setMemberAdmin(groupId, pubkey, true)
          }
          onDemote={(pubkey) =>
            void controller.setMemberAdmin(groupId, pubkey, false)
          }
          onRemove={(pubkey) => void controller.removeMember(groupId, pubkey)}
          onClose={() => setModal(null)}
        />
      );
    }
    case "keypkg":
      return (
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
      );
    case "profile":
      return (
        <ProfileModal
          profile={myProfile?.metadata ?? null}
          onSave={(fields) => {
            setModal(null);
            void controller.saveProfile(fields);
          }}
          onCancel={() => setModal(null)}
        />
      );
    case "myqr":
      return <QrModal npub={me.npub} onClose={() => setModal(null)} />;
    case "relays":
      return (
        <RelaysModal
          outbox={outboxRelays}
          inbox={inboxRelays}
          onSave={(outbox, inbox) => {
            setModal(null);
            void controller.saveRelayLists(outbox, inbox);
          }}
          onCancel={() => setModal(null)}
        />
      );
    case "attach":
      return (
        <TextPrompt
          title="attach a file"
          placeholder="/path/to/file (or ~/file)"
          onSubmit={(value) => {
            setModal(null);
            const path = expandHome(value.trim());
            if (path) void controller.sendFile(path, nav.replyTarget);
            nav.setReplyTarget(undefined);
          }}
          onCancel={() => setModal(null)}
        />
      );
  }
}

/** Expands a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  if (path.startsWith("~/") && process.env.HOME) {
    return `${process.env.HOME}${path.slice(1)}`;
  }
  return path;
}
