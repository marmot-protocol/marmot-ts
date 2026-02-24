import { ciphersuites, CiphersuiteName } from "ts-mls";

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
    <div className={`w-full ${className}`}>
      <label className="block mb-2">
        <span className="font-semibold">
          {label}
          <span className="text-xs text-base-content/60 ml-2">
            (cryptographic algorithms)
          </span>
        </span>
      </label>
      <select
        className="select select-bordered w-full"
        value={value}
        onChange={(e) => onChange(e.target.value as CiphersuiteName)}
        disabled={disabled}
      >
        {CIPHER_SUITES.map((suite) => (
          <option key={suite} value={suite}>
            {suite} (0x{ciphersuites[suite].toString(16).padStart(4, "0")})
          </option>
        ))}
      </select>
      {helpText && (
        <div className="mt-1">
          <span className="text-sm text-base-content/60">{helpText}</span>
        </div>
      )}
    </div>
  );
}

export { CIPHER_SUITES };
export type { CipherSuitePickerProps };
