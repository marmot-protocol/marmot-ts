import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useMemo, useState } from "react";
import type { KeyPackage } from "ts-mls";
import type { CredentialBasic } from "ts-mls/credential.js";
import { ciphersuites } from "ts-mls/crypto/ciphersuite.js";
import { decodeKeyPackage } from "ts-mls/keyPackage.js";
import { protocolVersions } from "ts-mls/protocolVersion.js";
import { getCredentialPubkey } from "marmot-ts";
import { AlertCircle } from "lucide-react";

import CipherSuiteBadge from "@/components/cipher-suite-badge";
import CredentialTypeBadge from "@/components/credential-type-badge";
import ErrorBoundary from "@/components/error-boundary";
import ExtensionBadge from "@/components/extension-badge";
import KeyPackageDataView from "@/components/data-view/key-package";
import { LeafNodeCapabilitiesSection } from "@/components/key-package/leaf-node-capabilities";
import { UserAvatar, UserName } from "@/components/nostr-user";
import { DetailsField } from "@/components/details-field";
import { PageHeader } from "@/components/page-header";
import { PageBody } from "@/components/page-body";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

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
        <p className="text-sm text-muted-foreground">
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
          <code className="text-xs text-muted-foreground break-all block">
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
  // Convert cipher suite to ID if it's a name
  const cipherSuiteId =
    typeof keyPackage.cipherSuite === "number"
      ? keyPackage.cipherSuite
      : ciphersuites[keyPackage.cipherSuite];

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">
          Key Package Configuration
        </h3>
        <p className="text-sm text-muted-foreground">
          Top-level cipher suite and extensions
        </p>
      </div>

      {/* Top-level Key Package Details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* MLS Version */}
        <DetailsField label="MLS Version">
          <Badge variant="outline">
            {keyPackage.version} (
            {(protocolVersions as any)[keyPackage.version] || "Unknown"})
          </Badge>
        </DetailsField>

        {/* Cipher Suite */}
        <DetailsField label="Cipher Suite">
          {cipherSuiteId !== undefined ? (
            <CipherSuiteBadge cipherSuite={cipherSuiteId} />
          ) : (
            <Badge variant="destructive">Unknown</Badge>
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
            <Badge variant="destructive">None</Badge>
          )}
        </div>
      </DetailsField>
    </div>
  );
}

// ============================================================================
// Main Decoder Component
// ============================================================================

export default function KeyPackageDecoderPage() {
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

      // Decode the key package
      const decoded = decodeKeyPackage(bytes, 0);
      if (!decoded) {
        setError("Failed to decode key package");
        return;
      }

      const [kp, _offset] = decoded;
      setKeyPackage(kp);
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
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Tools", to: "/tools" },
          { label: "Key Package Decoder" },
        ]}
      />
      <PageBody>
        {/* Input Section */}
        <Card>
          <CardHeader>
            <CardTitle>Hex-Encoded Key Package</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter a hex-encoded MLS key package (with or without spaces)
            </p>
            <div>
              <Textarea
                className="font-mono text-sm h-32"
                placeholder="Example: 0001000200030004... or 00 01 00 02 00 03 00 04..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <div className="flex justify-between items-center text-xs text-muted-foreground mt-2 mb-4">
                <span>
                  {bytes
                    ? `${bytes.length} bytes`
                    : input.trim()
                      ? "Invalid hex input"
                      : "No input"}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClear}
                    disabled={!input && !keyPackage}
                  >
                    Clear
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleDecode}
                    disabled={!bytes}
                  >
                    Decode
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Decoding Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Results */}
        {keyPackage && (
          <Tabs defaultValue="overview" className="w-full">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="credential">Credential</TabsTrigger>
              <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
              <TabsTrigger value="raw">Raw Data</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="p-6">
              <ErrorBoundary>
                <KeyPackageTopLevelInfo keyPackage={keyPackage} />
              </ErrorBoundary>
            </TabsContent>
            <TabsContent value="credential" className="p-6">
              <ErrorBoundary>
                {keyPackage.leafNode.credential.credentialType === "basic" ? (
                  <CredentialSection
                    credential={keyPackage.leafNode.credential}
                  />
                ) : (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Unsupported Credential Type</AlertTitle>
                    <AlertDescription>
                      Unsupported credential type:{" "}
                      {keyPackage.leafNode.credential.credentialType}
                    </AlertDescription>
                  </Alert>
                )}
              </ErrorBoundary>
            </TabsContent>
            <TabsContent value="capabilities" className="p-6">
              <ErrorBoundary>
                <LeafNodeCapabilitiesSection leafNode={keyPackage.leafNode} />
              </ErrorBoundary>
            </TabsContent>
            <TabsContent value="raw" className="p-6">
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold mb-1">
                    Full Key Package Data
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Complete decoded structure with all fields
                  </p>
                </div>
                <ErrorBoundary>
                  <KeyPackageDataView keyPackage={keyPackage} />
                </ErrorBoundary>
              </div>
            </TabsContent>
          </Tabs>
        )}

        {/* Empty State */}
        {!keyPackage && !error && (
          <Card>
            <CardContent className="items-center text-center py-8">
              <h3 className="text-xl font-semibold mb-2">
                Enter a hex-encoded key package above to get started
              </h3>
              <p className="text-muted-foreground mb-4">
                Paste the hex-encoded binary data from an MLS key package
              </p>
              <div className="text-sm text-muted-foreground text-left max-w-md">
                <p className="font-semibold mb-2">Where to get key packages:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    From Nostr events (kind 443) - use the "Key Package
                    Explorer" example
                  </li>
                  <li>
                    Create your own using the "Create Key Package" example
                  </li>
                  <li>From the content field of a kind 443 Nostr event</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  );
}
