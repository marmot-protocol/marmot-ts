import { useKeyboard } from "@opentui/react";
import { npubEncode } from "applesauce-core/helpers/pointers";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { useProfile } from "../hooks/use-profile.js";

function shortHex(value: string, max = 96): string {
  if (value.length <= max) return value || "empty";
  return `${value.slice(0, max)}...`;
}

function componentId(id: number): string {
  return `0x${id.toString(16).padStart(4, "0")}`;
}

function row(label: string, value: string | number | boolean) {
  return (
    <text>
      <span fg="#666">{label}: </span>
      <span fg="#d7dde8">{String(value)}</span>
    </text>
  );
}

function formatDecoded(value: unknown): string {
  if (value === undefined) return "not decoded";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return shortHex(Buffer.from(value).toString("hex"));
  if (Array.isArray(value)) {
    return value.map((item) => formatDecoded(item)).join(", ");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => {
      const formatted = item instanceof Uint8Array
        ? Buffer.from(item).toString("hex")
        : formatDecoded(item);
      return `${key}=${formatted}`;
    });
    return entries.join("; ");
  }
  return String(value);
}

/**
 * A single decoded group member. The display name resolves reactively through
 * the shared event store (`useProfile`), so it fills in as the kind 0 metadata
 * loads — no profile map threaded down from the controller.
 */
function MemberRow(props: { pubkey: string }) {
  const profile = useProfile(props.pubkey);
  const name = profile?.displayName || profile?.name;
  return (
    <box flexDirection="column" marginTop={1}>
      <text>
        <span fg="#666">name: </span>
        <span fg="#d7dde8">{name || "profile name unavailable"}</span>
      </text>
      <text>
        <span fg="#666">npub: </span>
        <span fg="#7fd1ff">{npubEncode(props.pubkey)}</span>
      </text>
    </box>
  );
}

export function GroupDebugModal(props: {
  group: MarmotGroup;
  onClose: () => void;
}) {
  const info = props.group.info;

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") props.onClose();
  });

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
        width={112}
        height="86%"
        flexDirection="column"
        title=" group debug info "
      >
        <scrollbox flexGrow={1} paddingX={1}>
          <box flexDirection="column">
            <text fg="#FFD700">MLS</text>
            {row("group id", info.mls.groupIdHex)}
            {row("epoch", info.mls.epochString)}
            {row(
              "cipher suite",
              info.mls.cipherSuiteName ?? componentId(info.mls.cipherSuite),
            )}
            {row("lifecycle", props.group.lifecycle)}
            {row("member count", info.mls.memberCount)}
            {row("pending proposals", info.mls.proposalCount)}
            {row("tree hash", shortHex(info.mls.treeHashHex))}
            {row(
              "transcript hash",
              shortHex(info.mls.confirmedTranscriptHashHex),
            )}
            {row("confirmation tag", shortHex(info.mls.confirmationTagHex ?? ""))}
            {row("historical epochs", info.mls.historicalEpochs.join(", ") || "none")}

            <text fg="#666"> </text>
            <text fg="#FFD700">Nostr Transport</text>
            {row("routing present", info.nostr.hasRouting)}
            {row("nostr group id", info.nostr.groupIdHex ?? "none")}
            {row("relay count", info.nostr.relayCount)}
            {info.nostr.relays.length ? (
              info.nostr.relays.map((relay) => (
                <text key={`relay:${relay}`}>
                  <span fg="#666">relay: </span>
                  <span fg="#d7dde8">{relay}</span>
                </text>
              ))
            ) : (
              <text fg="#666">no relays</text>
            )}

            <text fg="#666"> </text>
            <text fg="#FFD700">App Components</text>
            {row("component count", info.app.componentCount)}
            {row(
              "required ids",
              info.app.requiredComponentIds.map(componentId).join(", ") || "none",
            )}
            {info.app.decodeError && row("dictionary decode error", info.app.decodeError)}
            {info.app.components.map((component) => (
              <box
                key={`${component.idHex}:${component.name}`}
                flexDirection="column"
                marginTop={1}
              >
                <text fg="#9aa9b8">
                  {component.idHex} {component.name}
                </text>
                {row("bytes", component.dataLength)}
                {row("raw", shortHex(component.dataHex))}
                {component.decodeError
                  ? row("decode error", component.decodeError)
                  : row("decoded", shortHex(formatDecoded(component.decoded), 180))}
              </box>
            ))}

            <text fg="#666"> </text>
            <text fg="#FFD700">Members</text>
            {info.members.pubkeys.length ? (
              info.members.pubkeys.map((pubkey) => (
                <MemberRow key={`member:${pubkey}`} pubkey={pubkey} />
              ))
            ) : (
              <text fg="#666">no member pubkeys decoded</text>
            )}
          </box>
        </scrollbox>
        <text fg="#666">esc/q: close</text>
      </box>
    </box>
  );
}
