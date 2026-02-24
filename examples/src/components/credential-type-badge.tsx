import { defaultCredentialTypes, type DefaultCredentialTypeName } from "ts-mls";
import { greaseValues } from "ts-mls/grease.js";

interface CredentialTypeBadgeProps {
  credentialType: DefaultCredentialTypeName | number;
  className?: string;
}

/**
 * A badge component that displays a credential type with its name and hex ID
 */
export default function CredentialTypeBadge({
  credentialType,
  className = "",
}: CredentialTypeBadgeProps) {
  // Handle both string names and numeric IDs
  let credentialTypeId =
    typeof credentialType === "number"
      ? credentialType
      : defaultCredentialTypes[credentialType];
  const isGrease = greaseValues.includes(credentialTypeId);

  let credentialTypeName = isGrease
    ? "GREASE"
    : typeof credentialType === "string"
      ? credentialType
      : (Object.entries(defaultCredentialTypes).find(
          ([_, value]) => value === credentialTypeId,
        )?.[0] ?? "Unknown");

  // Format the hex ID with 0x prefix
  const hexId = `0x${credentialTypeId.toString(16).padStart(4, "0")}`;

  return (
    <span
      className={`badge badge-outline font-mono whitespace-pre ${className}`}
    >
      {credentialTypeName} ({hexId})
    </span>
  );
}
