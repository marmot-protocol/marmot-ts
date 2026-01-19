import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import accountManager, { keyPackageRelays$, mailboxes$ } from "@/lib/accounts";
import { extraRelays$, lookupRelays$ } from "@/lib/settings";
import { relaySet } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { createKeyPackageRelayListEvent } from "marmot-ts";
import { useEffect, useState } from "react";
import { pool } from "../../lib/nostr";
import { RelayItem } from "./relays";

function KeyPackageRelaysSection() {
  const lookupRelays = use$(lookupRelays$);
  const extraRelays = use$(extraRelays$);
  const keyPackageRelays = use$(keyPackageRelays$);
  const mailboxes = use$(mailboxes$);
  const [keyPackageRelaysList, setKeyPackageRelaysList] = useState<string[]>(
    [],
  );
  const [newKeyPackageRelay, setNewKeyPackageRelay] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  // Sync local state with observable
  useEffect(() => {
    if (keyPackageRelays && keyPackageRelays.length > 0) {
      setKeyPackageRelaysList(keyPackageRelays);
    }
  }, [keyPackageRelays]);

  const handleAddKeyPackageRelay = () => {
    if (newKeyPackageRelay.trim()) {
      const newRelays = [
        ...new Set([...keyPackageRelaysList, newKeyPackageRelay.trim()]),
      ];
      setKeyPackageRelaysList(newRelays);
      setNewKeyPackageRelay("");
    }
  };

  const handleRemoveKeyPackageRelay = (relay: string) => {
    const newRelays = keyPackageRelaysList.filter((r) => r !== relay);
    setKeyPackageRelaysList(newRelays);
  };

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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddKeyPackageRelay();
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

      <div className="space-y-2">
        {keyPackageRelaysList.length === 0 ? (
          <div className="text-muted-foreground text-sm text-center py-4">
            No key package relays configured. Add relays below to publish your
            relay list.
          </div>
        ) : (
          keyPackageRelaysList.map((relay) => (
            <RelayItem
              key={relay}
              relay={relay}
              onRemove={() => handleRemoveKeyPackageRelay(relay)}
            />
          ))
        )}
      </div>

      <div className="flex gap-2 w-full">
        <Input
          type="text"
          placeholder="wss://relay.example.com"
          value={newKeyPackageRelay}
          onChange={(e) => setNewKeyPackageRelay(e.target.value)}
          onKeyDown={handleKeyPress}
          className="flex-1"
          disabled={isPublishing}
        />
        <Button
          onClick={handleAddKeyPackageRelay}
          disabled={!newKeyPackageRelay.trim() || isPublishing}
        >
          Add
        </Button>
      </div>

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
