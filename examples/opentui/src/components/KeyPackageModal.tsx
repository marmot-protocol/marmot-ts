import type { SelectOption } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import type {
  KeyPackageDetails,
  KeyPackageSummary,
} from "../marmot/controller.js";
import { shortHex } from "../marmot/format.js";
import { ModalOverlay, Row } from "./primitives.js";

function valueList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function capabilityRows(details: KeyPackageDetails) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg="#888">MLS capabilities</text>
      <Row label="versions" value={valueList(details.capabilities.versions)} />
      <Row
        label="ciphersuites"
        value={valueList(details.capabilities.ciphersuites)}
      />
      <Row
        label="extensions"
        value={valueList(details.capabilities.extensions)}
      />
      <Row
        label="proposals"
        value={valueList(details.capabilities.proposals)}
      />
      <Row
        label="credentials"
        value={valueList(details.capabilities.credentials)}
      />
    </box>
  );
}

function extensionRows(
  title: string,
  extensions: KeyPackageDetails["leafNodeExtensions"],
) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg="#888">{title}</text>
      {extensions.length ? (
        extensions.map((extension, index) => (
          <text key={`${title}:${index}`}>
            <span fg="#666">{extension.type}: </span>
            <span fg="#d7dde8">{shortHex(extension.dataHex)}</span>
          </text>
        ))
      ) : (
        <text fg="#666">none</text>
      )}
    </box>
  );
}

export function KeyPackageModal(props: {
  summary: KeyPackageSummary;
  onPublish: () => void;
  onRotate: () => void;
  onCancel: () => void;
}) {
  const details = props.summary.current;
  const options: SelectOption[] = [
    { name: "Publish a fresh KeyPackage", description: "" },
    { name: "Rotate this device's KeyPackage", description: "" },
  ];

  useKeyboard((key) => {
    if (key.name === "escape") props.onCancel();
  });

  return (
    <ModalOverlay
      title="key package"
      width={84}
      footer="up/down: choose | enter: select | esc: cancel"
    >
      <text fg="#FFD700">current app KeyPackage</text>
      <Row label="stored" value={props.summary.total} />
      <Row label="unused" value={props.summary.unused} />

      {details ? (
        <box flexDirection="column">
          <Row label="slot" value={details.slot ?? "none"} />
          <Row label="used" value={details.used} />
          <Row label="published events" value={details.publishedCount} />
          <Row label="ref" value={details.refHex} />
          <Row label="cipher suite" value={details.cipherSuite} />
          <Row label="init key" value={shortHex(details.initKeyHex)} />
          <Row label="signature" value={shortHex(details.signatureHex)} />

          {capabilityRows(details)}
          {extensionRows("KeyPackage extensions", details.keyPackageExtensions)}
          {extensionRows("LeafNode extensions", details.leafNodeExtensions)}

          <box flexDirection="column" marginTop={1}>
            <text fg="#888">required_capabilities extension</text>
            {details.requiredCapabilities ? (
              <box flexDirection="column">
                <Row
                  label="extension types"
                  value={valueList(details.requiredCapabilities.extensionTypes)}
                />
                <Row
                  label="proposal types"
                  value={valueList(details.requiredCapabilities.proposalTypes)}
                />
                <Row
                  label="credential types"
                  value={valueList(
                    details.requiredCapabilities.credentialTypes,
                  )}
                />
              </box>
            ) : (
              <text fg="#666">not present on this KeyPackage</text>
            )}
          </box>
        </box>
      ) : (
        <text fg="#666">no local KeyPackage found yet</text>
      )}

      <box marginTop={1} flexDirection="column">
        <text fg="#888">actions</text>
        <select
          focused
          height={options.length}
          showDescription={false}
          options={options}
          onSelect={(index: number) => {
            if (index === 0) props.onPublish();
            else props.onRotate();
          }}
        />
      </box>
    </ModalOverlay>
  );
}
