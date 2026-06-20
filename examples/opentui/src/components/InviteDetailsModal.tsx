import { useEffect, useState } from "react";

import { useKeyboard } from "@opentui/react";

import type { InviteEntry, InvitePreview } from "../marmot/controller.js";
import { useController } from "../hooks/use-marmot.js";
import { useDisplayName } from "../hooks/use-profile.js";
import { npubShort, relativeTime, short } from "../marmot/format.js";

function row(label: string, value: string | number) {
  return (
    <text>
      <span fg="#666">{label}: </span>
      <span fg="#d7dde8">{String(value)}</span>
    </text>
  );
}

function cipherSuiteLabel(id: number): string {
  return `0x${id.toString(16).padStart(4, "0")}`;
}

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
        width={72}
        height="70%"
        flexDirection="column"
        title=" invite details "
      >
        <scrollbox flexGrow={1} paddingX={1}>
          <box flexDirection="column">
            <text fg="#FFD700">From</text>
            {row("inviter", inviterName)}
            {row("npub", npubShort(invite.pubkey))}
            {row("received", relativeTime(invite.created_at))}
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
                {row("name", group.name || "(unnamed)")}
                {group.description
                  ? row("description", group.description)
                  : null}
                {row("admins", group.adminPubkeys.length)}
                {group.adminPubkeys.map((pubkey) => (
                  <text key={`admin:${pubkey}`}>
                    <span fg="#666"> · </span>
                    <span fg="#d7dde8">{npubShort(pubkey)}</span>
                  </text>
                ))}
                {preview.epoch !== undefined
                  ? row("epoch", preview.epoch.toString())
                  : null}
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
                {preview.cipherSuite !== undefined
                  ? row("cipher suite", cipherSuiteLabel(preview.cipherSuite))
                  : null}
                {preview.recipientCount !== undefined
                  ? row("recipients", preview.recipientCount)
                  : null}
                {preview.keyPackageEventId
                  ? row("key package event", short(preview.keyPackageEventId))
                  : null}
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
        <text fg="#666">
          {joinable ? "enter/a: accept · " : ""}d: dismiss · esc/q: close
        </text>
      </box>
    </box>
  );
}
