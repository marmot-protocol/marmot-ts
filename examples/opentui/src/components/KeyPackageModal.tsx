import type { SelectOption } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import type {
  KeyPackageDetails,
  KeyPackageSummary,
} from "../marmot/controller.js";

function valueList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function shortHex(value: string, max = 96): string {
  if (value.length <= max) return value || "empty";
  return `${value.slice(0, max)}...`;
}

function row(label: string, value: string | number | boolean) {
  return (
    <text>
      <span fg="#666">{label}: </span>
      <span fg="#d7dde8">{String(value)}</span>
    </text>
  );
}

function capabilityRows(details: KeyPackageDetails) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg="#888">MLS capabilities</text>
      {row("versions", valueList(details.capabilities.versions))}
      {row("ciphersuites", valueList(details.capabilities.ciphersuites))}
      {row("extensions", valueList(details.capabilities.extensions))}
      {row("proposals", valueList(details.capabilities.proposals))}
      {row("credentials", valueList(details.capabilities.credentials))}
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
        width={84}
        flexDirection="column"
        title=" key package "
      >
        <text fg="#FFD700">current app KeyPackage</text>
        {row("stored", props.summary.total)}
        {row("unused", props.summary.unused)}

        {details ? (
          <box flexDirection="column">
            {row("slot", details.slot ?? "none")}
            {row("used", details.used)}
            {row("published events", details.publishedCount)}
            {row("ref", details.refHex)}
            {row("cipher suite", details.cipherSuite)}
            {row("init key", shortHex(details.initKeyHex))}
            {row("signature", shortHex(details.signatureHex))}

            {capabilityRows(details)}
            {extensionRows(
              "KeyPackage extensions",
              details.keyPackageExtensions,
            )}
            {extensionRows("LeafNode extensions", details.leafNodeExtensions)}

            <box flexDirection="column" marginTop={1}>
              <text fg="#888">required_capabilities extension</text>
              {details.requiredCapabilities ? (
                <box flexDirection="column">
                  {row(
                    "extension types",
                    valueList(details.requiredCapabilities.extensionTypes),
                  )}
                  {row(
                    "proposal types",
                    valueList(details.requiredCapabilities.proposalTypes),
                  )}
                  {row(
                    "credential types",
                    valueList(details.requiredCapabilities.credentialTypes),
                  )}
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
        <text fg="#666">up/down: choose | enter: select | esc: cancel</text>
      </box>
    </box>
  );
}
