import { useEffect, useState } from "react";

import { useKeyboard } from "@opentui/react";

import type { InviteEntry, InvitePreview } from "../marmot/controller.js";
import { useController } from "../hooks/use-marmot.js";
import { useDisplayName } from "../hooks/use-profile.js";
import { hexId, npubShort, relativeTime, short } from "../marmot/format.js";
import { ModalOverlay, Row } from "./primitives.js";

/**
 * Read-only details for a single incoming invite, shown before the user decides
 * to accept. Rumor-level fields render instantly; the decrypted group metadata
 * loads asynchronously via {@link MarmotController.previewInvite}.
 */
export function InviteDetailsModal(props: {
  entry: InviteEntry;
  onAccept: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const { invite, joinable } = props.entry;
  const controller = useController();
  const inviterName = useDisplayName(invite.pubkey, npubShort(invite.pubkey));
  const [preview, setPreview] = useState<InvitePreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    void controller.previewInvite(invite).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [controller, invite]);

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") props.onClose();
    else if (key.name === "d") props.onDismiss();
    else if (
      joinable &&
      (key.name === "return" || key.name === "enter" || key.name === "a")
    ) {
      props.onAccept();
    }
  });

  const group = preview?.group ?? null;

  return (
    <ModalOverlay
      title="invite details"
      width={72}
      height="70%"
      footer={`${joinable ? "enter/a: accept · " : ""}d: dismiss · esc/q: close`}
    >
      <scrollbox flexGrow={1} paddingX={1}>
        <box flexDirection="column">
          <text fg="#FFD700">From</text>
          <Row label="inviter" value={inviterName} />
          <Row label="npub" value={npubShort(invite.pubkey)} />
          <Row label="received" value={relativeTime(invite.created_at)} />
          <text>
            <span fg="#666">status: </span>
            {joinable ? (
              <span fg="#98C379">joinable</span>
            ) : (
              <span fg="#E5C07B">not joinable — KeyPackage not held</span>
            )}
          </text>

          <text fg="#666"> </text>
          <text fg="#FFD700">Group</text>
          {preview === null ? (
            <text fg="#666">decoding welcome…</text>
          ) : group ? (
            <box flexDirection="column">
              <Row label="name" value={group.name || "(unnamed)"} />
              {group.description ? (
                <Row label="description" value={group.description} />
              ) : null}
              <Row label="admins" value={group.adminPubkeys.length} />
              {group.adminPubkeys.map((pubkey) => (
                <text key={`admin:${pubkey}`}>
                  <span fg="#666"> · </span>
                  <span fg="#d7dde8">{npubShort(pubkey)}</span>
                </text>
              ))}
              {preview.epoch !== undefined ? (
                <Row label="epoch" value={preview.epoch.toString()} />
              ) : null}
              {group.relays.length ? (
                group.relays.map((relay) => (
                  <text key={`grouprelay:${relay}`}>
                    <span fg="#666">relay: </span>
                    <span fg="#d7dde8">{relay}</span>
                  </text>
                ))
              ) : (
                <text fg="#666">no group relays</text>
              )}
            </box>
          ) : (
            <text fg="#666">
              no group metadata available (cannot decrypt this Welcome)
            </text>
          )}

          <text fg="#666"> </text>
          <text fg="#FFD700">Welcome</text>
          {preview === null ? (
            <text fg="#666">decoding…</text>
          ) : (
            <box flexDirection="column">
              {preview.cipherSuite !== undefined ? (
                <Row label="cipher suite" value={hexId(preview.cipherSuite)} />
              ) : null}
              {preview.recipientCount !== undefined ? (
                <Row label="recipients" value={preview.recipientCount} />
              ) : null}
              {preview.keyPackageEventId ? (
                <Row
                  label="key package event"
                  value={short(preview.keyPackageEventId)}
                />
              ) : null}
              {preview.relays.length ? (
                preview.relays.map((relay) => (
                  <text key={`welcomerelay:${relay}`}>
                    <span fg="#666">welcome relay: </span>
                    <span fg="#d7dde8">{relay}</span>
                  </text>
                ))
              ) : (
                <text fg="#666">no welcome relays</text>
              )}
            </box>
          )}
        </box>
      </scrollbox>
    </ModalOverlay>
  );
}
