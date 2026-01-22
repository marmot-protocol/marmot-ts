import { Button } from "@/components/ui/button";
import { RelayListCreator } from "@/components/form/relay-list-creator";
import accountManager, { keyPackageRelays$, mailboxes$ } from "@/lib/accounts";
import { extraRelays$, lookupRelays$ } from "@/lib/settings";
import { relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { createKeyPackageRelayListEvent } from "marmot-ts";
import { useEffect, useState } from "react";
import { pool } from "../../lib/nostr";

function KeyPackageRelaysSection() {
  const lookupRelays = use$(lookupRelays$);
  const extraRelays = use$(extraRelays$);
  const keyPackageRelays = use$(keyPackageRelays$);
  const mailboxes = use$(mailboxes$);
  const [keyPackageRelaysList, setKeyPackageRelaysList] = useState<string[]>(
    [],
  );
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  // Sync local state with observable
  useEffect(() => {
    if (keyPackageRelays && keyPackageRelays.length > 0) {
      setKeyPackageRelaysList(keyPackageRelays);
    }
  }, [keyPackageRelays]);


  const handlePublishKeyPackageRelays = async () => {
    if (keyPackageRelaysList.length === 0) {
      setPublishError("At least one relay is required");
      return;
    }

    const account = accountManager.active;
    if (!account) {
      setPublishError("No active account");
      return;
    }

    try {
      setIsPublishing(true);
      setPublishError(null);
      setPublishSuccess(false);

      // Create unsigned event
      const unsignedEvent = createKeyPackageRelayListEvent({
        pubkey: account.pubkey,
        relays: keyPackageRelaysList,
        client: "marmot-chat",
      });

      // Sign the event
      const signedEvent = await account.signEvent(unsignedEvent);

      // Determine publishing relays: combine outbox, advertised relays, extra, and lookup
      const outboxRelays = mailboxes?.outboxes || [];
      const allPublishingRelays = relaySet(
        outboxRelays,
        keyPackageRelaysList,
        extraRelays,
        lookupRelays,
      );

      if (allPublishingRelays.length === 0) {
        throw new Error(
          "No relays available for publishing. Configure your account or add relays.",
        );
      }

      // Publish to all publishing relays
      for (const relay of allPublishingRelays) {
        try {
          await pool.publish([relay], signedEvent);
        } catch (err) {
          console.error("Failed to publish to", relay, err);
          // Continue publishing to other relays even if one fails
        }
      }

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


  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Key Package Relays</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Relays where your key packages are published for encrypted group
          messaging
        </p>
      </div>

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

      <RelayListCreator
        relays={keyPackageRelaysList}
        label="Key Package Relays"
        placeholder="wss://relay.example.com"
        disabled={isPublishing}
        emptyMessage="No key package relays configured. Add relays below to publish your relay list."
        onRelaysChange={setKeyPackageRelaysList}
      />

      <div className="flex justify-end">
        <Button
          onClick={handlePublishKeyPackageRelays}
          disabled={isPublishing || keyPackageRelaysList.length === 0}
          className="min-w-[120px]"
        >
          {isPublishing ? (
            <>
              <span className="mr-2">Publishing...</span>
              <span className="loading loading-spinner loading-sm"></span>
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}

export default function MarmotSettingsPage() {
  return (
    <div className="w-full max-w-2xl space-y-8 p-4">
      <KeyPackageRelaysSection />
    </div>
  );
}
