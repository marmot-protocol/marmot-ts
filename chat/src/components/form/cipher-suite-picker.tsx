import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CiphersuiteName,
  ciphersuites,
} from "ts-mls/crypto/ciphersuite.js";
import { cn } from "../../lib/utils";

// Available cipher suites
const CIPHER_SUITES = Object.keys(ciphersuites) as CiphersuiteName[];

interface CipherSuitePickerProps {
  value: CiphersuiteName;
  onChange: (suite: CiphersuiteName) => void;
  disabled?: boolean;
  label?: string;
  helpText?: string;
  className?: string;
}

export function CipherSuitePicker({
  value,
  onChange,
  disabled = false,
  label = "MLS Cipher Suite",
  helpText = "Encryption and signing algorithms for the key package",
  className = "",
}: CipherSuitePickerProps) {
  return (
    <div className={cn(`w-full space-y-2`, className)}>
      <Label>
        {label}
        <span className="text-muted-foreground ml-2 text-xs">
          (cryptographic algorithms)
        </span>
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CIPHER_SUITES.map((suite) => (
            <SelectItem key={suite} value={suite}>
              {suite} (0x{ciphersuites[suite].toString(16).padStart(4, "0")})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
    </div>
  );
}

export { CIPHER_SUITES };
export type { CipherSuitePickerProps };
