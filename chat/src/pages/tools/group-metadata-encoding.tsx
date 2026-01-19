import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useState, useEffect, useRef } from "react";
import {
  createMarmotGroupData,
  decodeMarmotGroupData,
} from "../../../../src/core/marmot-group-data";
import { extraRelays$ } from "@/lib/settings";
import { use$ } from "applesauce-react/hooks";
import { AlertCircle, Copy } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { PageBody } from "@/components/page-body";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";

// ============================================================================
// Main Component
// ============================================================================

export default function GroupMetadataEncodingPage() {
  const extraRelays = use$(extraRelays$);

  // Form state
  const [name, setName] = useState("My Marmot Group");
  const [description, setDescription] = useState(
    "A secure messaging group using MLS and Nostr",
  );
  const [adminPubkeys, setAdminPubkeys] = useState(
    "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
  );
  const [relays, setRelays] = useState("");

  // Hex encoding state
  const [hexEncoding, setHexEncoding] = useState<string>("");

  // Error state
  const [error, setError] = useState<string>("");

  // Track which side was last modified to avoid infinite loops
  const lastModifiedRef = useRef<"form" | "hex" | null>(null);
  const isUpdatingFromHexRef = useRef(false);
  const isUpdatingFromFormRef = useRef(false);

  // Initialize relays from settings
  useEffect(() => {
    if (extraRelays && extraRelays.length > 0 && !relays) {
      setRelays(extraRelays.join("\n"));
    }
  }, [extraRelays]);

  // Decode hex to form data
  const decodeHexToForm = (hex: string) => {
    if (isUpdatingFromFormRef.current) return;

    try {
      setError("");
      isUpdatingFromHexRef.current = true;
      lastModifiedRef.current = "hex";

      const cleanHex = hex.trim().replace(/\s+/g, "");
      if (!cleanHex) {
        // Empty hex - clear form but don't show error
        setName("");
        setDescription("");
        setAdminPubkeys("");
        setRelays("");
        return;
      }

      const bytes = hexToBytes(cleanHex);
      const groupData = decodeMarmotGroupData(bytes);

      // Update form fields
      setName(groupData.name || "");
      setDescription(groupData.description || "");
      setAdminPubkeys(groupData.adminPubkeys.join("\n"));
      setRelays(groupData.relays.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Don't clear form on decode error
    } finally {
      isUpdatingFromHexRef.current = false;
    }
  };

  // Update hex when form changes
  useEffect(() => {
    if (isUpdatingFromHexRef.current) return;

    try {
      setError("");
      isUpdatingFromFormRef.current = true;
      lastModifiedRef.current = "form";

      const adminPubkeysArray = adminPubkeys
        .split("\n")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const relaysArray = relays
        .split("\n")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);

      const extensionData = createMarmotGroupData({
        name,
        description,
        adminPubkeys: adminPubkeysArray,
        relays: relaysArray,
      });

      const newHex = bytesToHex(extensionData);
      setHexEncoding(newHex);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHexEncoding("");
    } finally {
      isUpdatingFromFormRef.current = false;
    }
  }, [name, description, adminPubkeys, relays]);

  // Update form when hex changes
  const handleHexChange = (newHex: string) => {
    setHexEncoding(newHex);
    decodeHexToForm(newHex);
  };

  const handleCopy = () => {
    if (hexEncoding) {
      navigator.clipboard.writeText(hexEncoding);
    }
  };

  const handleClear = () => {
    setName("");
    setDescription("");
    setAdminPubkeys("");
    setRelays("");
    setHexEncoding("");
    setError("");
  };

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Tools", to: "/tools" },
          { label: "Group Metadata Encode/Decode" },
        ]}
      />
      <PageBody>
        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>
              {lastModifiedRef.current === "form" ? "Encoding" : "Decoding"}{" "}
              Error
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Top Section: Group Metadata Form */}
        <Card>
          <CardHeader>
            <CardTitle>Group Information</CardTitle>
            <CardDescription>
              Enter the group metadata. Changes will automatically update the
              hex encoding below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldGroup>
              {/* Group Name */}
              <Field>
                <FieldLabel htmlFor="group-name">Group Name</FieldLabel>
                <Input
                  id="group-name"
                  placeholder="Enter group name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>

              {/* Group Description */}
              <Field>
                <FieldLabel htmlFor="group-description">Description</FieldLabel>
                <Textarea
                  id="group-description"
                  placeholder="Enter group description"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>

              {/* Admin Pubkeys */}
              <Field>
                <FieldLabel htmlFor="admin-pubkeys">
                  Admin Public Keys (one per line)
                </FieldLabel>
                <Textarea
                  id="admin-pubkeys"
                  placeholder="Enter admin pubkeys (64 hex chars each, one per line)"
                  className="font-mono"
                  rows={3}
                  value={adminPubkeys}
                  onChange={(e) => setAdminPubkeys(e.target.value)}
                />
                <p className="text-muted-foreground">
                  Example:
                  3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d
                </p>
              </Field>

              {/* Relays */}
              <Field>
                <FieldLabel htmlFor="relays">
                  Relay URLs (one per line)
                </FieldLabel>
                <Textarea
                  id="relays"
                  placeholder="Enter relay URLs (one per line)"
                  className="font-mono"
                  rows={3}
                  value={relays}
                  onChange={(e) => setRelays(e.target.value)}
                />
                <p className="text-muted-foreground">
                  Must start with ws:// or wss://
                </p>
              </Field>
            </FieldGroup>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleClear}>
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Bottom Section: Hex Encoding */}
        <Card>
          <CardHeader>
            <CardTitle>Hex Encoding</CardTitle>
            <CardDescription>
              The hex-encoded Marmot Group Data extension. Edit this to decode
              and update the form above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field>
              <FieldLabel htmlFor="hex-encoding">
                Extension Data (Hex)
              </FieldLabel>
              <Textarea
                id="hex-encoding"
                placeholder="Hex-encoded extension data will appear here..."
                className="font-mono text-xs"
                rows={8}
                value={hexEncoding}
                onChange={(e) => handleHexChange(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!hexEncoding}
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy to Clipboard
              </Button>
            </div>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
