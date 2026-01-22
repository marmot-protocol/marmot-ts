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

  // Calculate which key package relays have the event and which don't
  const relayStatus = useMemo(() => {
    if (!keyPackageRelays || !event) {
      return { seen: [], notSeen: [] };
    }

    const seenSet = seenRelays || new Set<string>();
    const seen: string[] = [];
    const notSeen: string[] = [];

    for (const relay of keyPackageRelays) {
      if (seenSet.has(relay)) {
        seen.push(relay);
      } else {
        notSeen.push(relay);
      }
    }

    return { seen, notSeen };
  }, [keyPackageRelays, seenRelays, event]);
  if (event && keyPackageRelays && keyPackageRelays.length > 0) {
    return (
      <div>
        <Label className="text-muted-foreground/60 mb-1 text-xs">
          Key Package Relays Status
        </Label>
        <div className="space-y-2">
          {relayStatus.seen.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Found on ({relayStatus.seen.length}):
              </p>
              <div className="flex flex-wrap gap-1">
                {relayStatus.seen.map((relay) => (
                  <Badge
                    key={relay}
                    variant="secondary"
                    className="text-xs font-mono"
                  >
                    {relay}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {relayStatus.notSeen.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Not found on ({relayStatus.notSeen.length}):
              </p>
              <div className="flex flex-wrap gap-1">
                {relayStatus.notSeen.map((relay) => (
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

  if (event && (!keyPackageRelays || keyPackageRelays.length === 0)) {
    return (
      <div>
        <Label className="text-muted-foreground/60 mb-1 text-xs">
          Found on Relays
        </Label>
        <div className="space-y-1">
          {!seenRelays || seenRelays.size === 0 ? (
            <p className="text-xs text-muted-foreground">
              No relays found with this event
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {Array.from(seenRelays).map((relay) => (
                <Badge
                  key={relay}
                  variant="secondary"
                  className="text-xs font-mono"
                >
                  {relay}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div>
        <Label className="text-muted-foreground/60 mb-1 text-xs">Status</Label>
        <Badge variant="outline">Unpublished</Badge>
      </div>
    );
  }

  return null;
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
}: {
  event?: NostrEvent;
  keyPackage: KeyPackage;
}) {
  const keyPackageRelays = use$(keyPackageRelays$);
  const navigate = useNavigate();

  const [deleting, setDeleting] = useState(false);
  const handleDeleteKeyPackage = async () => {
    if (!event) return;
    if (!keyPackageRelays) return;

    try {
      setDeleting(true);

      // TODO: implement deleting key package and cleaning up published event
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
      {deleting ? "Deleting..." : "Delete key package"}{" "}
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

  const handleBroadcast = async () => {
    if (!event) return;

    try {
      if (!keyPackageRelays || keyPackageRelays.length === 0)
        throw new Error("No key package relays configured");
      setIsBroadcasting(true);
      await pool.publish(keyPackageRelays, event);
    } catch (err) {
      console.error("Error broadcasting event:", err);
    } finally {
      setIsBroadcasting(false);
    }
  };

  if (!event) return null;

  return (
    <Button
      onClick={handleBroadcast}
      disabled={isBroadcasting}
      variant="outline"
    >
      {isBroadcasting ? "Broadcasting..." : "Broadcast event"}
    </Button>
  );
}

function KeyPackageDetailBody({
  keyPackage,
}: {
  keyPackage: StoredKeyPackage;
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
                <div>
                  <Badge variant="outline">
                    {clientInfo.name || "Unknown"}
                  </Badge>
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
              keyPackage={keyPackage.publicPackage}
            />
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
  const keyPackage = use$(
    () =>
      client && ref
        ? from(client.keyPackageStore.getKeyPackage(ref))
        : undefined,
    [client, ref],
  );

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

  if (!keyPackage) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Key package not found</p>
        </div>
      </div>
    );
  }

  return <KeyPackageDetailBody keyPackage={keyPackage} />;
}
