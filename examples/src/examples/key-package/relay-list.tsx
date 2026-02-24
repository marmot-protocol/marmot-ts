import { NostrEvent, relaySet, UnsignedEvent } from "applesauce-core/helpers";
import { useEffect, useState } from "react";

import {
  createKeyPackageRelayListEvent,
  getKeyPackageRelayList,
} from "../../../../src/core/key-package-relay-list";
import { RelayListCreator } from "../../components/form/relay-list-creator";
import JsonBlock from "../../components/json-block";
import RelayAvatar from "../../components/relay-avatar";
import { withSignIn } from "../../components/with-signIn";
import { useObservable } from "../../hooks/use-observable";
import accounts, { keyPackageRelays$, mailboxes$ } from "../../lib/accounts";
import { eventStore, pool } from "../../lib/nostr";

// ============================================================================
// Component: RelayListForm
// ============================================================================

interface RelayListFormProps {
  relays: string[];
  isCreating: boolean;
  onRelaysChange: (relays: string[]) => void;
  onSubmit: () => void;
}

function RelayListForm({
  relays,
  isCreating,
  onRelaysChange,
  onSubmit,
}: RelayListFormProps) {
  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body">
        <h2 className="card-title">Relay List Configuration</h2>
        <p className="mb-4">
          Configure the relays where your key packages will be published. Users
          can discover these relays from your kind 10051 relay list event.
        </p>

        {/* Relays Configuration */}
        <div className="form-control">
          <RelayListCreator
            relays={relays}
            label="Relays"
            placeholder="wss://relay.example.com"
            disabled={isCreating}
            emptyMessage="No relays configured. Add relays below to create your relay list."
            onRelaysChange={onRelaysChange}
          />
        </div>

        {/* Create Button */}
        <div className="card-actions justify-end mt-4">
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={isCreating || relays.length === 0}
          >
            {isCreating ? (
              <>
                <span className="loading loading-spinner"></span>
                Creating...
              </>
            ) : (
              "Create Draft Event"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Component: ErrorAlert
// ============================================================================

function ErrorAlert({ error }: { error: string | null }) {
  if (!error) return null;

  return (
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
      <span>Error: {error}</span>
    </div>
  );
}

// ============================================================================
// Component: DraftDisplay
// ============================================================================

interface DraftDisplayProps {
  event: UnsignedEvent | NostrEvent;
  publishingRelays: string[];
  isPublishing: boolean;
  onPublish: () => void;
  onReset: () => void;
}

function DraftDisplay({
  event,
  publishingRelays,
  isPublishing,
  onPublish,
  onReset,
}: DraftDisplayProps) {
  const advertisedRelays = getKeyPackageRelayList(event as NostrEvent);

  return (
    <div className="space-y-4">
      {/* Draft Event */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Draft Event (Unsigned)</h2>
          <div className="alert alert-info mb-4">
            <div>
              <div className="font-semibold">Relay Publishing Strategy</div>
              <div className="text-sm">
                This event will be published to {publishingRelays.length} relay
                {publishingRelays.length !== 1 ? "s" : ""}.
              </div>
            </div>
          </div>

          {/* Advertised Relays */}
          <div className="mb-4">
            <h3 className="font-semibold mb-2">
              Advertised Key Package Relays
            </h3>
            <div className="text-sm mb-2">
              These relays will be listed in the event for others to discover
              your key packages:
            </div>
            <div className="space-y-1">
              {advertisedRelays.map((relay, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 font-mono text-sm p-2 bg-base-100 rounded"
                >
                  <RelayAvatar relay={relay} size="sm" />
                  {relay}
                </div>
              ))}
            </div>
          </div>

          {/* Publishing Relays */}
          <div className="mb-4">
            <h3 className="font-semibold mb-2">Publishing Relays</h3>
            <div className="text-sm mb-2">
              This event will be published to these relays (outbox +
              advertised):
            </div>
            <div className="space-y-1">
              {publishingRelays.map((relay, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 font-mono text-sm p-2 bg-base-100 rounded"
                >
                  <RelayAvatar relay={relay} size="sm" />
                  {relay}
                </div>
              ))}
            </div>
          </div>

          <JsonBlock value={event} />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-between">
        <button
          className="btn btn-outline"
          onClick={onReset}
          disabled={isPublishing}
        >
          Reset
        </button>
        <button
          className="btn btn-success btn-lg"
          onClick={onPublish}
          disabled={isPublishing}
        >
          {isPublishing ? (
            <>
              <span className="loading loading-spinner"></span>
              Publishing...
            </>
          ) : (
            "Publish Relay List"
          )}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Component: SuccessDisplay
// ============================================================================

interface SuccessDisplayProps {
  event: NostrEvent;
  relayList: string[];
}

function SuccessDisplay({ event, relayList }: SuccessDisplayProps) {
  return (
    <div className="space-y-4">
      <div className="alert alert-success">
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
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div>
          <div className="font-bold">Relay list published successfully!</div>
          <div className="text-sm">
            Event ID: {event.id}
            <br />
            Published to {relayList.length} relay
            {relayList.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* Event Details */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Published Event</h2>
          <div className="divider my-1"></div>
          <JsonBlock value={event} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Hook: useRelayListManagement
// ============================================================================

function useRelayListManagement() {
  const [isCreating, setIsCreating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [createdEvent, setCreatedEvent] = useState<NostrEvent | null>(null);
  const [draftEvent, setDraftEvent] = useState<
    UnsignedEvent | NostrEvent | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  // Get account mailboxes for relay selection
  const mailboxes = useObservable(mailboxes$);
  const account = accounts.active;

  const createDraft = async (relays: string[]) => {
    try {
      setIsCreating(true);
      setError(null);
      setDraftEvent(null);
      setCreatedEvent(null);

      if (!account) {
        throw new Error("No active account");
      }

      // Create the unsigned event using the library function
      console.log("Creating key package relay list event...");
      const unsignedEvent = createKeyPackageRelayListEvent({
        pubkey: account.pubkey,
        relays,
        client: "marmot-examples",
      });

      setDraftEvent(unsignedEvent);
      console.log("✅ Relay list draft created!");
    } catch (err) {
      console.error("Error creating relay list:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const publishRelayList = async () => {
    if (!draftEvent) {
      setError("No draft event to publish");
      return;
    }

    try {
      setIsPublishing(true);
      setError(null);

      if (!account) {
        throw new Error("No active account");
      }

      // Sign the event
      console.log("Signing relay list event...");
      const signedEvent = await account.signEvent(draftEvent);
      console.log("Signed event:", signedEvent);

      // Publish replaceable metadata (kind 10051) to the user's NIP-65 outboxes.
      const allPublishingRelays = relaySet(mailboxes?.outboxes);

      if (allPublishingRelays.length === 0) {
        throw new Error(
          "No NIP-65 outbox relays configured. Configure kind 10002 (NIP-65) before publishing.",
        );
      }

      // Publish to combined relay list
      console.log("Publishing to relays:", allPublishingRelays);
      for (const relay of allPublishingRelays) {
        try {
          await pool.publish([relay], signedEvent);
          console.log("Published to", relay);
        } catch (err) {
          console.error("Failed to publish to", relay, err);
        }
      }

      // Add to local eventStore so other screens (create key package, banners, etc)
      // see the updated replaceable event immediately.
      eventStore.add(signedEvent);

      setCreatedEvent(signedEvent);
      setDraftEvent(null);
      console.log("✅ Relay list published successfully!");
    } catch (err) {
      console.error("Error publishing relay list:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPublishing(false);
    }
  };

  const reset = () => {
    setDraftEvent(null);
    setCreatedEvent(null);
    setError(null);
  };

  return {
    isCreating,
    isPublishing,
    createdEvent,
    draftEvent,
    error,
    createDraft,
    publishRelayList,
    reset,
  };
}

// ============================================================================
// Main Component
// ============================================================================

export default withSignIn(function KeyPackageRelays() {
  // Subscribe to the user's current relay list (kind 10051)
  const currentRelayList = useObservable(keyPackageRelays$);
  const mailboxes = useObservable(mailboxes$);

  const [relays, setRelays] = useState<string[]>([]);

  // Update relays when existing relay list changes
  useEffect(() => {
    if (Array.isArray(currentRelayList) && currentRelayList.length > 0) {
      setRelays(currentRelayList);
    }
  }, [currentRelayList]);

  const {
    isCreating,
    isPublishing,
    createdEvent,
    draftEvent,
    error,
    createDraft,
    publishRelayList,
    reset,
  } = useRelayListManagement();

  const handleCreateDraft = () => {
    createDraft(relays);
  };

  const relaysForSuccess = createdEvent
    ? getKeyPackageRelayList(createdEvent)
    : [];

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Key Package Relay List</h1>
        <p>
          Manage your key package relay list (kind 10051 event) to tell other
          users where to find your key packages for encrypted group messaging.
        </p>
      </div>

      {/* Current Status - Show when we have a relay list */}
      {currentRelayList &&
        currentRelayList.length > 0 &&
        !draftEvent &&
        !createdEvent && (
          <div className="alert alert-info">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              className="stroke-current shrink-0 w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              ></path>
            </svg>
            <span>
              You currently have a relay list with {currentRelayList.length}{" "}
              relay{currentRelayList.length !== 1 ? "s" : ""}. Modifying it will
              create a new version.
            </span>
          </div>
        )}

      {/* Configuration Form */}
      {!draftEvent && !createdEvent && (
        <RelayListForm
          relays={relays}
          isCreating={isCreating}
          onRelaysChange={setRelays}
          onSubmit={handleCreateDraft}
        />
      )}

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Draft Display */}
      {draftEvent && !createdEvent && (
        <DraftDisplay
          event={draftEvent}
          publishingRelays={[
            ...new Set([
              ...(mailboxes?.outboxes || []),
              ...getKeyPackageRelayList(draftEvent as NostrEvent),
            ]),
          ]}
          isPublishing={isPublishing}
          onPublish={publishRelayList}
          onReset={reset}
        />
      )}

      {/* Success Display */}
      {createdEvent && (
        <SuccessDisplay event={createdEvent} relayList={relaysForSuccess} />
      )}
    </div>
  );
});
