import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "applesauce-core/helpers";
import {
  getCredentialPubkey,
  getKeyPackage,
  getKeyPackageClient,
  getKeyPackageExtensions,
  getKeyPackageMLSVersion,
  getKeyPackageRelays,
} from "marmot-ts";
import { useMemo, useState } from "react";
import type { KeyPackage } from "ts-mls";
import type { CredentialBasic } from "ts-mls/credential.js";
import { ciphersuites } from "ts-mls/crypto/ciphersuite.js";
import { encodeKeyPackage } from "ts-mls/keyPackage.js";
import { protocolVersions } from "ts-mls/protocolVersion.js";

import CipherSuiteBadge from "@/components/cipher-suite-badge";
import CredentialTypeBadge from "@/components/credential-type-badge";
import KeyPackageDataView from "@/components/data-view/key-package";
import { DetailsField } from "@/components/details-field";
import ErrorBoundary from "@/components/error-boundary";
import ExtensionBadge from "@/components/extension-badge";
import JsonBlock from "@/components/json-block";
import { LeafNodeCapabilitiesSection } from "@/components/key-package/leaf-node-capabilities";
import { UserAvatar, UserName } from "@/components/nostr-user";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ============================================================================
// Props Interface
// ============================================================================

interface KeyPackageDetailsModalProps {
  /** Direct key package object */
  keyPackage?: KeyPackage;
  /** Nostr event (kind 443) from which to extract key package */
  event?: NostrEvent;
  /** Control modal visibility */
  open: boolean;
  /** Callback when modal closes */
  onClose: () => void;
}

// ============================================================================
// Helper Components
// ============================================================================

function CredentialSection({
  credential,
  event,
}: {
  credential: CredentialBasic;
  event?: NostrEvent;
}) {
  const pubkey = getCredentialPubkey(credential);
  const isValid = event ? pubkey === event.pubkey : undefined;

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
            {isValid !== undefined &&
              (isValid ? (
                <Badge variant="default">Valid</Badge>
              ) : (
                <Badge variant="destructive">Invalid</Badge>
              ))}
          </div>
          <code className="text-muted-foreground break-all block">
            {pubkey}
          </code>
          {isValid === false && (
            <div className="text-xs text-destructive mt-2">
              ⚠️ Credential pubkey does not match event publisher
            </div>
          )}
        </div>
      </div>

      {/* Credential Type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DetailsField label="Credential Type">
          <CredentialTypeBadge credentialType={credential.credentialType} />
        </DetailsField>

        <DetailsField label="Identity (hex)">
          <p className="break-all select-all font-mono">
            {bytesToHex(credential.identity)}
          </p>
        </DetailsField>
      </div>
    </div>
  );
}

function KeyPackageTopLevelInfo({
  keyPackage,
  event,
}: {
  keyPackage: KeyPackage;
  event?: NostrEvent;
}) {
  // Convert cipher suite to ID if it's a name
  const cipherSuiteId =
    typeof keyPackage.cipherSuite === "number"
      ? keyPackage.cipherSuite
      : ciphersuites[keyPackage.cipherSuite];

  // Get event-specific info if available
  const mlsVersion = event ? getKeyPackageMLSVersion(event) : undefined;
  const eventExtensions = event ? getKeyPackageExtensions(event) : undefined;
  const client = event ? getKeyPackageClient(event) : undefined;
  const relays = event ? getKeyPackageRelays(event) : undefined;

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
            {mlsVersion || keyPackage.version} (
            {(protocolVersions as any)[mlsVersion || keyPackage.version] ||
              "Unknown"}
            )
          </Badge>
        </DetailsField>

        {/* Cipher Suite */}
        <DetailsField label="Cipher Suite">
          {cipherSuiteId !== undefined ? (
            <CipherSuiteBadge cipherSuite={cipherSuiteId} />
          ) : (
            <Badge variant="destructive" className="border">
              Unknown
            </Badge>
          )}
        </DetailsField>

        {/* Client Info (if from event) */}
        {client && (
          <DetailsField label="Client">
            <Badge variant="outline">{client.name}</Badge>
          </DetailsField>
        )}
      </div>

      {/* Extensions - Full width */}
      <DetailsField label="Extensions">
        <div className="flex flex-wrap gap-2">
          {(eventExtensions && eventExtensions.length > 0) ||
          (keyPackage.extensions && keyPackage.extensions.length > 0) ? (
            (eventExtensions || keyPackage.extensions || []).map(
              (extension, idx: number) => {
                const extensionType =
                  typeof extension === "number"
                    ? extension
                    : (extension as any).extensionType || extension;
                return (
                  <ExtensionBadge key={idx} extensionType={extensionType} />
                );
              },
            )
          ) : (
            <Badge variant="destructive" className="border">
              None
            </Badge>
          )}
        </div>
      </DetailsField>

      {/* Relays (if from event) */}
      {relays && relays.length > 0 && (
        <DetailsField label="Relays">
          <div className="flex flex-wrap gap-2">
            {relays.map((relay) => (
              <Badge key={relay} variant="outline">
                {relay}
              </Badge>
            ))}
          </div>
        </DetailsField>
      )}

      {/* Raw Nostr Event Collapsible (if from event) */}
      {event && (
        <div className="collapse collapse-arrow bg-muted">
          <input type="checkbox" />
          <div className="collapse-title text-sm font-medium py-2 min-h-0">
            Raw Nostr Event
          </div>
          <div className="collapse-content">
            <JsonBlock value={event} />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Modal Component
// ============================================================================

export default function KeyPackageDetailsModal({
  keyPackage: keyPackageProp,
  event,
  open,
  onClose,
}: KeyPackageDetailsModalProps) {
  const [activeTab, setActiveTab] = useState("overview");

  // Extract key package from event or use prop
  const keyPackage = useMemo(() => {
    if (keyPackageProp) return keyPackageProp;
    if (event) return getKeyPackage(event);
    throw new Error("No key package provided");
  }, [keyPackageProp, event]);

  // Encode key package for raw hex display
  const rawHexData = useMemo(() => {
    try {
      const encoded = encodeKeyPackage(keyPackage);
      return bytesToHex(encoded);
    } catch (error) {
      console.error("Failed to encode key package:", error);
      return null;
    }
  }, [keyPackage]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        showCloseButton
        className="w-full max-w-6xl max-h-[90vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Key Package Details</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="credential">Credential</TabsTrigger>
            <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
            <TabsTrigger value="raw">Raw Data</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="p-6">
            <ErrorBoundary>
              <KeyPackageTopLevelInfo keyPackage={keyPackage} event={event} />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="credential" className="p-6">
            <ErrorBoundary>
              {keyPackage.leafNode.credential.credentialType === "basic" ? (
                <CredentialSection
                  credential={keyPackage.leafNode.credential}
                  event={event}
                />
              ) : (
                <Alert variant="destructive">
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

              {/* Raw Hex Data */}
              <div className="collapse collapse-arrow bg-muted">
                <input type="checkbox" />
                <div className="collapse-title text-sm font-medium py-2 min-h-0">
                  Raw Key Package Data (Binary Hex)
                </div>
                <div className="collapse-content">
                  {rawHexData ? (
                    <code className="break-all select-all block">
                      {rawHexData}
                    </code>
                  ) : (
                    <Alert variant="destructive">
                      <AlertDescription>
                        Failed to encode key package to hex
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
