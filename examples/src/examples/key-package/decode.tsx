import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useMemo, useState } from "react";
import {
  KeyPackage,
  keyPackageDecoder,
  decode,
  protocolVersions,
  defaultCredentialTypes,
} from "ts-mls";
import { CredentialBasic } from "ts-mls/credential.js";

import CipherSuiteBadge from "../../components/cipher-suite-badge";
import CredentialTypeBadge from "../../components/credential-type-badge";
import ErrorBoundary from "../../components/error-boundary";
import ExtensionBadge from "../../components/extension-badge";
import KeyPackageDataView from "../../components/data-view/key-package";
import { LeafNodeCapabilitiesSection } from "../../components/key-package/leaf-node-capabilities";
import { UserAvatar, UserName } from "../../components/nostr-user";
import { getCredentialPubkey } from "../../../../src";
import { DetailsField } from "../../components/details-field";

// ============================================================================
// Helper Components
// ============================================================================

function CredentialSection({ credential }: { credential: CredentialBasic }) {
  const pubkey = getCredentialPubkey(credential);

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">Credential</h3>
        <p className="text-sm text-base-content/60">
          Identity information from the leaf node credential
        </p>
      </div>

      {/* Credential Details */}
      <div className="flex gap-3 items-start">
        <UserAvatar pubkey={pubkey} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h4 className="font-semibold">
              <UserName pubkey={pubkey} />
            </h4>
          </div>
          <code className="text-xs text-base-content/60 break-all block">
            {pubkey}
          </code>
        </div>
      </div>

      {/* Credential Type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DetailsField label="Credential Type">
          <CredentialTypeBadge credentialType={credential.credentialType} />
        </DetailsField>

        <DetailsField label="Identity (hex)">
          <p className="break-all select-all font-mono text-xs">
            {bytesToHex(credential.identity)}
          </p>
        </DetailsField>
      </div>
    </div>
  );
}

function KeyPackageTopLevelInfo({ keyPackage }: { keyPackage: KeyPackage }) {
  // cipherSuite is now always a number in ts-mls v2
  const cipherSuiteId = keyPackage.cipherSuite;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">
          Key Package Configuration
        </h3>
        <p className="text-sm text-base-content/60">
          Top-level cipher suite and extensions
        </p>
      </div>

      {/* Top-level Key Package Details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* MLS Version */}
        <DetailsField label="MLS Version">
          <span className="badge badge-outline">
            {keyPackage.version} (
            {protocolVersions.mls10 === keyPackage.version
              ? "mls10"
              : "Unknown"}
            )
          </span>
        </DetailsField>

        {/* Cipher Suite */}
        <DetailsField label="Cipher Suite">
          {cipherSuiteId !== undefined ? (
            <CipherSuiteBadge cipherSuite={cipherSuiteId} />
          ) : (
            <span className="badge badge-error badge-outline">Unknown</span>
          )}
        </DetailsField>
      </div>

      {/* Extensions - Full width */}
      <DetailsField label="Extensions">
        <div className="flex flex-wrap gap-2">
          {keyPackage.extensions && keyPackage.extensions.length > 0 ? (
            keyPackage.extensions.map((extension, idx: number) => (
              <ExtensionBadge
                key={idx}
                extensionType={extension.extensionType}
              />
            ))
          ) : (
            <span className="badge badge-error badge-outline">None</span>
          )}
        </div>
      </DetailsField>
    </div>
  );
}

// ============================================================================
// Main Decoder Component
// ============================================================================

export default function KeyPackageDecoder() {
  const [input, setInput] = useState("");
  const [keyPackage, setKeyPackage] = useState<KeyPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDecode = () => {
    setError(null);
    setKeyPackage(null);

    try {
      // Remove whitespace and validate hex
      const cleanInput = input.trim().replace(/\s+/g, "");

      if (!cleanInput) {
        setError("Please enter a hex-encoded key package");
        return;
      }

      // Convert hex to bytes
      const bytes = hexToBytes(cleanInput);

      // Decode the key package using ts-mls v2 API
      const decoded = decode(keyPackageDecoder, bytes);
      if (!decoded) {
        setError("Failed to decode key package");
        return;
      }

      setKeyPackage(decoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClear = () => {
    setInput("");
    setKeyPackage(null);
    setError(null);
  };

  const bytes = useMemo(() => {
    try {
      const cleaned = input.trim().replace(/\s+/g, "");
      if (!cleaned) return null;
      return hexToBytes(cleaned);
    } catch {
      return null;
    }
  }, [input]);

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Key Package Decoder</h1>
        <p className="text-base-content/70">
          Decode and inspect MLS key packages from raw hex-encoded binary data
        </p>
      </div>

      {/* Input Section */}
      <div className="card card-border">
        <div className="card-body">
          <h2 className="text-lg font-semibold">Hex-Encoded Key Package</h2>
          <p className="text-sm text-base-content/70 mb-4">
            Enter a hex-encoded MLS key package (with or without spaces)
          </p>
          <div>
            <textarea
              className="textarea textarea-bordered font-mono text-sm h-32 w-full"
              placeholder="Example: 0001000200030004... or 00 01 00 02 00 03 00 04..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="flex justify-between items-center text-xs text-base-content/60 mt-2 mb-4">
              <span>
                {bytes
                  ? `${bytes.length} bytes`
                  : input.trim()
                    ? "Invalid hex input"
                    : "No input"}
              </span>
              <div className="flex gap-2">
                <button
                  className="btn"
                  onClick={handleClear}
                  disabled={!input && !keyPackage}
                >
                  Clear
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleDecode}
                  disabled={!bytes}
                >
                  Decode
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="alert alert-error">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="stroke-current shrink-0 h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <div className="font-bold">Decoding Error</div>
            <div className="text-sm">{error}</div>
          </div>
        </div>
      )}

      {/* Results */}
      {keyPackage && (
        <div role="tablist" className="tabs tabs-lift">
          <input
            type="radio"
            name="result_tabs"
            className="tab"
            aria-label="Overview"
            defaultChecked
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ErrorBoundary>
              <KeyPackageTopLevelInfo keyPackage={keyPackage} />
            </ErrorBoundary>
          </div>

          <input
            type="radio"
            name="result_tabs"
            className="tab"
            aria-label="Credential"
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ErrorBoundary>
              {keyPackage.leafNode.credential.credentialType ===
              defaultCredentialTypes.basic ? (
                <CredentialSection
                  credential={keyPackage.leafNode.credential as CredentialBasic}
                />
              ) : (
                <div className="alert alert-warning">
                  <div className="text-sm">
                    Unsupported credential type:{" "}
                    {keyPackage.leafNode.credential.credentialType}
                  </div>
                </div>
              )}
            </ErrorBoundary>
          </div>

          <input
            type="radio"
            name="result_tabs"
            className="tab"
            aria-label="Capabilities"
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ErrorBoundary>
              <LeafNodeCapabilitiesSection leafNode={keyPackage.leafNode} />
            </ErrorBoundary>
          </div>

          <input
            type="radio"
            name="result_tabs"
            className="tab"
            aria-label="Raw Data"
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold mb-1">
                  Full Key Package Data
                </h3>
                <p className="text-sm text-base-content/60">
                  Complete decoded structure with all fields
                </p>
              </div>
              <ErrorBoundary>
                <KeyPackageDataView keyPackage={keyPackage} />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!keyPackage && !error && (
        <div className="card bg-base-200">
          <div className="card-body items-center text-center">
            <h3 className="text-xl font-semibold mb-2">
              Enter a hex-encoded key package above to get started
            </h3>
            <p className="text-base-content/70 mb-4">
              Paste the hex-encoded binary data from an MLS key package
            </p>
            <div className="text-sm text-base-content/60 text-left max-w-md">
              <p className="font-semibold mb-2">Where to get key packages:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  From Nostr events (kind 443) - use the "Key Package Explorer"
                  example
                </li>
                <li>Create your own using the "Create Key Package" example</li>
                <li>From the content field of a kind 443 Nostr event</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
