import type { CredentialTypeName } from "ts-mls/credentialType.js";
import { greaseValues } from "ts-mls/grease.js";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

// Credential types from ts-mls
const credentialTypes = {
  basic: 1,
  x509: 2,
} as const;

interface CredentialTypeBadgeProps {
  credentialType: CredentialTypeName | number;
  className?: string;
}

/**
 * A badge component that displays a credential type with its name and hex ID
 */
export default function CredentialTypeBadge({
  credentialType,
  className,
}: CredentialTypeBadgeProps) {
  // Handle both string names and numeric IDs
  let credentialTypeId =
    typeof credentialType === "number"
      ? credentialType
      : credentialTypes[credentialType] || parseInt(credentialType);
  const isGrease = greaseValues.includes(credentialTypeId);

  let credentialTypeName = isGrease
    ? "GREASE"
    : typeof credentialType === "string"
      ? credentialType
      : (Object.entries(credentialTypes).find(
          ([_, value]) => value === credentialTypeId,
        )?.[0] ?? "Unknown");

  // Format the hex ID with 0x prefix
  const hexId = `0x${credentialTypeId.toString(16).padStart(4, "0")}`;

  return (
    <Badge
      variant="outline"
      className={cn("font-mono whitespace-pre", className)}
    >
      {credentialTypeName} ({hexId})
    </Badge>
  );
}
