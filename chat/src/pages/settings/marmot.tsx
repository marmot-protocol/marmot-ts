import { relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import {
  KEY_PACKAGE_RELAY_LIST_KIND,
  createKeyPackageRelayListEvent,
} from "marmot-ts";
import { useState } from "react";
import { combineLatest, of, switchMap } from "rxjs";

import { EventStatusButton } from "@/components/event-status-button";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { user$, accounts } from "@/lib/accounts";
import { keyPackageRelays$ } from "@/lib/lifecycle";
import { pool } from "@/lib/nostr";
import { extraRelays$, lookupRelays$ } from "@/lib/settings";
import { NewRelayForm, RelayItem } from "./relays";

// Observable of current user's key package relay list event
const keyPackageRelayListEvent$ = combineLatest([user$, user$.outboxes$]).pipe(
  switchMap(([user, outboxes]) =>
    user
      ? user.replaceable(KEY_PACKAGE_RELAY_LIST_KIND, undefined, outboxes)
      : of(undefined),
  ),
);

function KeyPackageRelaysSection() {
  const lookupRelays = use$(lookupRelays$);
  const extraRelays = use$(extraRelays$);
  const keyPackageRelays = use$(keyPackageRelays$);
  const mailboxes = use$(user$.mailboxes$);

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  const handlePublishKeyPackageRelays = async (relays: string[]) => {
    const account = accounts.active;
    if (!account) return setPublishError("No active account");

    try {
      setIsPublishing(true);
      setPublishError(null);
      setPublishSuccess(false);

      // Create unsigned event
      const unsignedEvent = createKeyPackageRelayListEvent({
        pubkey: account.pubkey,
        relays: relays,
        client: "marmot-chat",
      });

      // Sign the event
      const signedEvent = await account.signEvent(unsignedEvent);

      // Determine publishing relays: combine outbox, advertised relays, extra, and lookup
      const outboxRelays = mailboxes?.outboxes || [];
      const allPublishingRelays = relaySet(
        outboxRelays,
        relays,
        extraRelays,
        lookupRelays,
      );

      if (allPublishingRelays.length === 0)
        throw new Error(
          "No relays available for publishing. Configure your account or add relays.",
        );

      // Publish to all publishing relays in parallel
      await pool.publish(allPublishingRelays, signedEvent);

      setPublishSuccess(true);
      // Clear success message after 3 seconds
      setTimeout(() => setPublishSuccess(false), 3000);
    } catch (err) {
      console.error("Error publishing key package relay list:", err);
      setPublishError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPublishing(false);
    }
  };

  const handleAddRelay = async (relay: string) => {
    // Treat undefined as empty array to bootstrap the relay list
    const current = keyPackageRelays ?? [];
    await handlePublishKeyPackageRelays(relaySet(current, relay));
  };

  const handleRemoveRelay = async (relay: string) => {
    // Treat undefined as empty array (nothing to remove if no relays exist)
    const current = keyPackageRelays ?? [];
    await handlePublishKeyPackageRelays(current.filter((r) => r !== relay));
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Key Package Relays</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Relays where your key packages are published for encrypted group
          messaging
        </p>
      </div>

      <div className="space-y-2">
        {keyPackageRelays && keyPackageRelays.length > 0 ? (
          keyPackageRelays.map((relay, index) => (
            <RelayItem
              key={index}
              relay={relay}
              onRemove={() => handleRemoveRelay(relay)}
            />
          ))
        ) : (
          <div className="text-sm text-muted-foreground p-3 bg-muted/50 rounded-md">
            {keyPackageRelays === undefined
              ? "No key package relay list published yet. Add your first relay below to publish it."
              : "No relays configured. Add a relay to publish your key package relay list."}
          </div>
        )}
      </div>

      <NewRelayForm onAdd={handleAddRelay} />

      {/* Error Message */}
      {publishError && (
        <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
          Error: {publishError}
        </div>
      )}

      {/* Success Message */}
      {publishSuccess && (
        <div className="bg-green-500/15 text-green-600 text-sm p-3 rounded-md">
          Key package relay list published successfully!
        </div>
      )}

      {/* Publishing indicator */}
      {isPublishing && (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <span className="loading loading-spinner loading-sm"></span>
          <span>Publishing changes...</span>
        </div>
      )}
    </div>
  );
}

export default function MarmotSettingsPage() {
  const keyPackageRelayListEvent = use$(keyPackageRelayListEvent$);

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Settings", to: "/settings" },
          { label: "Marmot" },
        ]}
        actions={
          keyPackageRelayListEvent && (
            <EventStatusButton event={keyPackageRelayListEvent} />
          )
        }
      />
      <PageBody>
        <KeyPackageRelaysSection />
      </PageBody>
    </>
  );
}
