import { greaseValues } from "ts-mls/grease.js";
import { getCiphersuiteNameFromId } from "../lib/ciphersuite";
import { CiphersuiteId } from "ts-mls";

interface CipherSuiteBadgeProps {
  cipherSuite: CiphersuiteId | number;
  className?: string;
}

/**
 * A badge component that displays a cipher suite ID with a tooltip showing its name
 */
export default function CipherSuiteBadge({
  cipherSuite,
  className = "",
}: CipherSuiteBadgeProps) {
  const isGrease = greaseValues.includes(cipherSuite);

  // Get the cipher suite name
  const cipherSuiteName = isGrease
    ? "GREASE"
    : (getCiphersuiteNameFromId(cipherSuite) ?? "Unknown");

  // Format the hex ID with 0x prefix
  const hexId = `0x${cipherSuite.toString(16).padStart(4, "0")}`;

  return (
    <span
      className={`badge badge-outline font-mono whitespace-pre ${className}`}
    >
      {cipherSuiteName} ({hexId})
    </span>
  );
}
