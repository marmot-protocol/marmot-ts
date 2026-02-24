import { greaseValues } from "ts-mls/grease.js";
import { extendedExtensionTypes } from "../../../src/core/protocol.js";

interface ExtensionBadgeProps {
  extensionType: number;
  className?: string;
}

/**
 * A badge component that displays an extension type ID with a tooltip showing its name
 */
export default function ExtensionBadge({
  extensionType,
  className = "",
}: ExtensionBadgeProps) {
  // Extension type is now always a number in ts-mls v2
  const extensionTypeId = extensionType;

  const isGrease = greaseValues.includes(extensionTypeId);

  // Find the extension name from the extendedExtensionTypes map
  const extensionName =
    Object.entries(extendedExtensionTypes).find(
      ([_, value]) => value === extensionTypeId,
    )?.[0] ?? (isGrease ? "GREASE" : "Unknown");

  // Format the hex ID with 0x prefix
  const hexId = `0x${extensionTypeId.toString(16).padStart(4, "0")}`;

  return (
    <span
      className={`badge badge-outline font-mono whitespace-pre ${className}`}
    >
      {extensionName} ({hexId})
    </span>
  );
}
