import { mapEventsToTimeline } from "applesauce-core";
import { type NostrEvent } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { onlyEvents } from "applesauce-relay";
import {
  KEY_PACKAGE_KIND,
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
} from "marmot-ts";
import { useState } from "react";
import { of } from "rxjs";
import { map } from "rxjs/operators";

import CipherSuiteBadge from "@/components/cipher-suite-badge";
import KeyPackageDetailsModal from "@/components/key-package/details-modal";
import { UserAvatar, UserName } from "@/components/nostr-user";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pool } from "@/lib/nostr";
import { relayConfig$ } from "@/lib/settings";
import { formatTimeAgo } from "@/lib/time";

function KeyPackageItem({ event }: { event: NostrEvent }) {
  const [modalOpen, setModalOpen] = useState(false);
  const client = getKeyPackageClient(event);
  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const timeAgo = formatTimeAgo(event.created_at);

  return (
    <>
      <Card>
        <CardContent>
          <div className="flex items-start gap-3">
            <UserAvatar pubkey={event.pubkey} size="sm" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">
                  <UserName pubkey={event.pubkey} />
                </span>
                <span className="text-xs text-muted-foreground">{timeAgo}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {cipherSuiteId !== undefined ? (
                  <CipherSuiteBadge cipherSuite={cipherSuiteId} />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Unknown cipher suite
                  </span>
                )}
                {client?.name && (
                  <span className="text-xs text-muted-foreground">
                    Client: {client.name}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs text-muted-foreground break-all font-mono">
                  {event.id}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModalOpen(true)}
                >
                  Details
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <KeyPackageDetailsModal
        event={event}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}

export default function KeyPackageFeedPage() {
  const relayConfig = use$(relayConfig$);
  const [selectedRelay, setSelectedRelay] = useState<string>(
    relayConfig?.extraRelays?.[0] || relayConfig?.commonRelays?.[0] || "",
  );

  // Subscribe to key package events from relay (always include extra relays)
  const events = use$(() => {
    // Return empty observable if selectedRelay is empty to avoid invalid relay requests
    if (!selectedRelay) return of([]);

    return pool
      .relay(selectedRelay)
      .subscription({
        kinds: [KEY_PACKAGE_KIND],
        limit: 50,
      })
      .pipe(
        onlyEvents(),
        mapEventsToTimeline(),
        map((arr) => [...arr]),
      );
  }, [selectedRelay]);

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Tools", to: "/tools" },
          { label: "Key Package Feed" },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          {/* Header */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold">Key Package Feed</h1>
            <p className="text-muted-foreground">
              Browse recent key packages published to a Nostr relay (kind 443
              events)
            </p>
          </div>

          {/* Relay Selector */}
          <div className="space-y-2">
            <Label htmlFor="relay-input">Relay URL</Label>
            <Input
              id="relay-input"
              type="text"
              placeholder="wss://relay.example.com"
              value={selectedRelay}
              onChange={(e) => setSelectedRelay(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Enter a relay URL to fetch key packages from. Extra relays will
              also be queried.
            </p>
          </div>

          {/* Event Count */}
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">
              Key Packages {events ? `(${events.length})` : ""}
            </h2>
          </div>

          {/* Events List */}
          <div className="space-y-4">
            {events === undefined ? (
              <div className="text-center text-muted-foreground py-8">
                Loading...
              </div>
            ) : events.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                {selectedRelay
                  ? "No key packages found on this relay"
                  : "Please enter a relay URL to fetch key packages"}
              </div>
            ) : (
              events.map((event) => (
                <KeyPackageItem key={event.id} event={event as NostrEvent} />
              ))
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
