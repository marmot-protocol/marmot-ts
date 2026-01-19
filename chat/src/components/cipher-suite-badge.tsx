import {
  type CiphersuiteId,
  type CiphersuiteName,
  ciphersuites,
  getCiphersuiteNameFromId,
} from "ts-mls/crypto/ciphersuite.js";
import { greaseValues } from "ts-mls/grease.js";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

interface CipherSuiteBadgeProps {
  cipherSuite: CiphersuiteId | CiphersuiteName;
  className?: string;
}

/**
 * A badge component that displays a cipher suite ID with a tooltip showing its name
 */
export default function CipherSuiteBadge({
  cipherSuite,
  className,
}: CipherSuiteBadgeProps) {
  // Convert to number if needed
  const cipherSuiteId: CiphersuiteId =
    typeof cipherSuite === "number"
      ? cipherSuite
      : ciphersuites[cipherSuite] || parseInt(cipherSuite);

  const isGrease = greaseValues.includes(cipherSuiteId);

  // Get the cipher suite name
  let cipherSuiteName: string;
  try {
    cipherSuiteName = isGrease
      ? "GREASE"
      : getCiphersuiteNameFromId(cipherSuiteId);
  } catch {
    cipherSuiteName = "Unknown";
  }

  // Format the hex ID with 0x prefix
  const hexId = `0x${cipherSuiteId.toString(16).padStart(4, "0")}`;

  return (
    <Badge
      variant="outline"
      className={cn("font-mono whitespace-pre", className)}
    >
      {cipherSuiteName} ({hexId})
    </Badge>
  );
}
