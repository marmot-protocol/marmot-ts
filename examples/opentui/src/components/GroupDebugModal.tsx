import { useKeyboard } from "@opentui/react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { hexId, shortHex } from "../marmot/format.js";
import { ModalOverlay, Row } from "./primitives.js";

function formatDecoded(value: unknown): string {
  if (value === undefined) return "not decoded";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array)
    return shortHex(Buffer.from(value).toString("hex"));
  if (Array.isArray(value)) {
    return value.map((item) => formatDecoded(item)).join(", ");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => {
      const formatted =
        item instanceof Uint8Array
          ? Buffer.from(item).toString("hex")
          : formatDecoded(item);
      return `${key}=${formatted}`;
    });
    return entries.join("; ");
  }
  return String(value);
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
    <ModalOverlay
      title="group debug info"
      width={112}
      height="86%"
      footer="esc/q: close"
    >
      <scrollbox flexGrow={1} paddingX={1}>
        <box flexDirection="column">
          <text fg="#FFD700">MLS</text>
          <Row label="group id" value={info.mls.groupIdHex} />
          <Row label="epoch" value={info.mls.epochString} />
          <Row
            label="cipher suite"
            value={info.mls.cipherSuiteName ?? hexId(info.mls.cipherSuite)}
          />
          <Row label="lifecycle" value={props.group.lifecycle} />
          <Row label="member count" value={info.mls.memberCount} />
          <Row label="pending proposals" value={info.mls.proposalCount} />
          <Row label="tree hash" value={shortHex(info.mls.treeHashHex)} />
          <Row
            label="transcript hash"
            value={shortHex(info.mls.confirmedTranscriptHashHex)}
          />
          <Row
            label="confirmation tag"
            value={shortHex(info.mls.confirmationTagHex ?? "")}
          />
          <Row
            label="historical epochs"
            value={info.mls.historicalEpochs.join(", ") || "none"}
          />

          <text fg="#666"> </text>
          <text fg="#FFD700">Nostr Transport</text>
          <Row label="routing present" value={info.nostr.hasRouting} />
          <Row label="nostr group id" value={info.nostr.groupIdHex ?? "none"} />
          <Row label="relay count" value={info.nostr.relayCount} />
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
          <Row label="component count" value={info.app.componentCount} />
          <Row
            label="required ids"
            value={
              info.app.requiredComponentIds.map(hexId).join(", ") || "none"
            }
          />
          {info.app.decodeError && (
            <Row label="dictionary decode error" value={info.app.decodeError} />
          )}
          {info.app.components.map((component) => (
            <box
              key={`${component.idHex}:${component.name}`}
              flexDirection="column"
              marginTop={1}
            >
              <text fg="#9aa9b8">
                {component.idHex} {component.name}
              </text>
              <Row label="bytes" value={component.dataLength} />
              <Row label="raw" value={shortHex(component.dataHex)} />
              {component.decodeError ? (
                <Row label="decode error" value={component.decodeError} />
              ) : (
                <Row
                  label="decoded"
                  value={shortHex(formatDecoded(component.decoded), 180)}
                />
              )}
            </box>
          ))}
        </box>
      </scrollbox>
    </ModalOverlay>
  );
}
