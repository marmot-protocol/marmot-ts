import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { watchEventUpdates } from "applesauce-core";
import { getSeenRelays, NostrEvent, relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import {
  createKeyPackageEvent,
  getKeyPackageClient,
  StoredKeyPackage,
} from "marmot-ts";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { from, map } from "rxjs";

import CipherSuiteBadge from "@/components/cipher-suite-badge";
import KeyPackageDataView from "@/components/data-view/key-package";
import { EventStatusButton } from "@/components/event-status-button";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { keyPackageRelays$, publishedKeyPackages$ } from "@/lib/lifecycle";
import { marmotClient$ } from "@/lib/marmot-client";
import { eventStore, pool } from "@/lib/nostr";
import { formatTimeAgo } from "@/lib/time";
import { KeyPackage } from "ts-mls";
import accounts, { publish, user$ } from "../../lib/accounts";

/** A key package that is not stored locally but read from an event */
type RemoteKeyPackage = Omit<StoredKeyPackage, "privatePackage"> & {
  privatePackage: null;
};

function KeyPackageRelayStatus({ event }: { event: NostrEvent | undefined }) {
  const keyPackageRelays = use$(keyPackageRelays$);
  const seenRelays = use$(
    () =>
      event &&
      eventStore.event(event.id).pipe(
        // Watch for updates to seen relays
        watchEventUpdates(eventStore),
        map((e) => e && getSeenRelays(e)),
      ),
    [event?.id],
  );

  // Calculate relay status
  const relayStatus = useMemo(() => {
    if (!event) {
      return { found: [], notInConfigured: [] };
    }

    const seenSet = seenRelays || new Set<string>();
    const found: string[] = [];

    // All relays where the event was found
    for (const relay of seenSet) {
      found.push(relay);
    }

    // Configured relays that don't have the event yet
    const notInConfigured: string[] = [];
    if (keyPackageRelays) {
      for (const relay of keyPackageRelays) {
        if (!seenSet.has(relay)) {
          notInConfigured.push(relay);
        }
      }
    }

    return { found, notInConfigured };
  }, [keyPackageRelays, seenRelays, event]);

  if (!event) {
    return (
      <div>
        <Label className="text-muted-foreground/60 mb-1 text-xs">Status</Label>
        <Badge variant="outline">Unpublished</Badge>
      </div>
    );
  }

  return (
    <div>
      <Label className="text-muted-foreground/60 mb-1 text-xs">
        Found on Relays
      </Label>
      <div className="space-y-2">
        {/* All relays where the event was found */}
        {relayStatus.found.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {relayStatus.found.map((relay) => (
              <Badge
                key={relay}
                variant="secondary"
                className="text-xs font-mono"
              >
                {relay}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No relays found with this event yet
          </p>
        )}

        {/* Configured relays that don't have the event */}
        {keyPackageRelays &&
          keyPackageRelays.length > 0 &&
          relayStatus.notInConfigured.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Not found on configured relays (
                {relayStatus.notInConfigured.length}):
              </p>
              <div className="flex flex-wrap gap-1">
                {relayStatus.notInConfigured.map((relay) => (
                  <Badge
                    key={relay}
                    variant="outline"
                    className="text-xs font-mono"
                  >
                    {relay}
                  </Badge>
                ))}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

function PublishKeyPackageButton({
  event,
  keyPackage,
}: {
  event?: NostrEvent;
  keyPackage: KeyPackage;
}) {
  const keyPackageRelays = use$(keyPackageRelays$);
  const outboxes = use$(user$.outboxes$);
  const account = use$(accounts.active$);

  const [isPublishing, setIsPublishing] = useState(false);
  const handlePublishKeyPackage = async () => {
    try {
      if (event) throw new Error("Event already published");
      if (!keyPackageRelays || keyPackageRelays.length === 0)
        throw new Error("No key package relays configured");
      if (!account) throw new Error("No active account");

      setIsPublishing(true);
      const unsignedEvent = createKeyPackageEvent({
        keyPackage: keyPackage,
        pubkey: account.pubkey,
        relays: keyPackageRelays,
        client: "marmot-chat",
      });
      const signed = await account.signEvent(unsignedEvent);
      await publish(signed, relaySet(outboxes, keyPackageRelays));
    } catch (err) {
      console.error("Error publishing key package:", err);
    } finally {
      setIsPublishing(false);
    }
  };

  if (event) return null;

  return (
    <Button onClick={handlePublishKeyPackage} disabled={isPublishing}>
      {isPublishing ? "Publishing..." : "Publish key package"}
    </Button>
  );
}

function DeleteKeyPackageButton({
  event,
  keyPackageRef,
}: {
  event?: NostrEvent;
  keyPackageRef: Uint8Array;
}) {
  const client = use$(marmotClient$);
  const navigate = useNavigate();

  const [deleting, setDeleting] = useState(false);
  const handleDeleteKeyPackage = async () => {
    if (!event) return;

    try {
      setDeleting(true);

      // Remove from local store
      if (client) {
        await client.keyPackageStore.remove(keyPackageRef);
      }

      // TODO: Implement deletion from relays (requires NIP-09 or similar)
      // For now, just navigate back
    } catch (err) {
      console.error("Error deleting key package:", err);
    } finally {
      setDeleting(false);
      navigate("/key-packages");
    }
  };

  return (
    <Button
      onClick={handleDeleteKeyPackage}
      disabled={deleting}
      variant="destructive"
    >
      {deleting ? "Deleting..." : "Delete key package"}
    </Button>
  );
}

function BroadcastKeyPackageButton({
  event,
}: {
  event?: NostrEvent;
  keyPackage: KeyPackage;
}) {
  const keyPackageRelays = use$(keyPackageRelays$);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [broadcastStatus, setBroadcastStatus] = useState<
    "idle" | "success" | "error"
  >("idle");

  const handleBroadcast = async () => {
    if (!event) return;

    try {
      if (!keyPackageRelays || keyPackageRelays.length === 0) {
        setBroadcastStatus("error");
        return;
      }
      setIsBroadcasting(true);
      setBroadcastStatus("idle");
      await pool.publish(keyPackageRelays, event);
      setBroadcastStatus("success");
    } catch (err) {
      console.error("Error broadcasting event:", err);
      setBroadcastStatus("error");
    } finally {
      setIsBroadcasting(false);
    }
  };

  if (!event) return null;

  return (
    <div className="flex flex-col gap-1">
      <Button
        onClick={handleBroadcast}
        disabled={isBroadcasting}
        variant="outline"
      >
        {isBroadcasting ? "Broadcasting..." : "Broadcast event"}
      </Button>
      {broadcastStatus === "success" && (
        <span className="text-xs text-green-600">Event broadcasted</span>
      )}
      {broadcastStatus === "error" && !isBroadcasting && (
        <span className="text-xs text-red-600">
          No key package relays configured
        </span>
      )}
    </div>
  );
}

function KeyPackageDetailBody({
  keyPackage,
}: {
  keyPackage: StoredKeyPackage | RemoteKeyPackage;
}) {
  const refString = useMemo(
    () => bytesToHex(keyPackage.keyPackageRef),
    [keyPackage.keyPackageRef],
  );

  // Get published key packages from event store and match by keyPackageRef
  const publishedKeyPackages = use$(publishedKeyPackages$);

  const event = publishedKeyPackages?.find(
    (pkg) => bytesToHex(pkg.keyPackageRef) === refString,
  )?.event;
  const cipherSuiteId = keyPackage.publicPackage.cipherSuite;
  const clientInfo = event ? getKeyPackageClient(event) : undefined;
  const timeAgo = event ? formatTimeAgo(event.created_at) : "Unpublished";
  const isLocal = "privatePackage" in keyPackage;

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Key Packages", to: "/key-packages" },
          { label: refString.slice(0, 16) + "..." },
        ]}
        actions={event ? <EventStatusButton event={event} /> : undefined}
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle>Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground/60 mb-1 text-xs">
                Key Package Ref
              </Label>
              <div className="font-mono text-xs text-muted-foreground break-all">
                {refString}
              </div>
            </div>

            {event && (
              <div>
                <Label className="text-muted-foreground/60 mb-1 text-xs">
                  Event ID
                </Label>
                <div className="font-mono text-xs text-muted-foreground break-all">
                  {event.id}
                </div>
              </div>
            )}

            <KeyPackageRelayStatus event={event} />

            <div>
              <Label className="text-muted-foreground/60 mb-1 text-xs">
                Created
              </Label>
              <div className="text-sm">{timeAgo}</div>
            </div>

            {clientInfo && (
              <div>
                <Label className="text-muted-foreground/60 mb-1 text-xs">
                  Client
                </Label>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {clientInfo.name || "Unknown"}
                  </Badge>
                  {!isLocal && (
                    <Badge variant="outline" className="text-xs">
                      Not stored locally
                    </Badge>
                  )}
                </div>
              </div>
            )}

            <div>
              <Label className="text-muted-foreground/60 mb-1 text-xs">
                Cipher Suite
              </Label>
              <div>
                {cipherSuiteId !== undefined ? (
                  <CipherSuiteBadge cipherSuite={cipherSuiteId} />
                ) : (
                  <Badge variant="destructive" className="outline">
                    Unknown
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex gap-2">
            {isLocal ? (
              <>
                <PublishKeyPackageButton
                  event={event}
                  keyPackage={keyPackage.publicPackage}
                />
                <BroadcastKeyPackageButton
                  event={event}
                  keyPackage={keyPackage.publicPackage}
                />
                <DeleteKeyPackageButton
                  event={event}
                  keyPackageRef={keyPackage.keyPackageRef}
                />
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                This key package is published on relays but not stored locally.
                Private key material is not available.
              </div>
            )}
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Key Package Data</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted p-4 rounded-lg overflow-auto">
              <KeyPackageDataView keyPackage={keyPackage.publicPackage} />
            </div>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

export default function KeyPackageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const ref = useMemo(() => (id ? hexToBytes(id) : undefined), [id]);
  const client = use$(marmotClient$);
  const publishedKeyPackages = use$(publishedKeyPackages$);

  const keyPackage = use$(
    () =>
      client && ref
        ? from(client.keyPackageStore.getKeyPackage(ref))
        : undefined,
    [client, ref],
  );

  // Try to find the published key package if not found locally
  const publishedKeyPackage = useMemo(() => {
    if (!ref || !publishedKeyPackages) return undefined;
    return publishedKeyPackages.find(
      (pkg) => bytesToHex(pkg.keyPackageRef) === bytesToHex(ref),
    );
  }, [ref, publishedKeyPackages]);

  if (!ref) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid key package identifier</p>
        </div>
      </div>
    );
  }

  if (keyPackage === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Loading key package...</p>
        </div>
      </div>
    );
  }

  if (!keyPackage && !publishedKeyPackage) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Key package not found</p>
        </div>
      </div>
    );
  }

  // If not stored locally but published, create a minimal StoredKeyPackage
  const displayKeyPackage = keyPackage || {
    keyPackageRef: publishedKeyPackage!.keyPackageRef,
    publicPackage: publishedKeyPackage!.keyPackage,
    privatePackage: null, // No private package available
  };

  return <KeyPackageDetailBody keyPackage={displayKeyPackage} />;
}
