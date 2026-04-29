import { NostrEvent } from "applesauce-core/helpers";
import { useEffect, useState } from "react";
import type { CiphersuiteName, KeyPackage } from "ts-mls";

import { getKeyPackage } from "../../../../src";
import KeyPackageDataView from "../../components/data-view/key-package";
import { CipherSuitePicker } from "../../components/form/cipher-suite-picker";
import { RelayListCreator } from "../../components/form/relay-list-creator";
import JsonBlock from "../../components/json-block";
import { withSignIn } from "../../components/with-signIn";
import { useObservable } from "../../hooks/use-observable";
import { keyPackageRelays$ } from "../../lib/accounts";
import { marmotClient$ } from "../../lib/marmot-client";

// ============================================================================
// Component: ConfigurationForm
// ============================================================================

interface ConfigurationFormProps {
  relays: string[];
  cipherSuite: CiphersuiteName;
  isCreating: boolean;
  hasKeyPackageRelayList: boolean;
  onRelaysChange: (relays: string[]) => void;
  onCipherSuiteChange: (suite: CiphersuiteName) => void;
  onSubmit: () => void;
}

function ConfigurationForm({
  relays,
  cipherSuite,
  isCreating,
  hasKeyPackageRelayList,
  onRelaysChange,
  onCipherSuiteChange,
  onSubmit,
}: ConfigurationFormProps) {
  const isDisabled = isCreating || !hasKeyPackageRelayList;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body">
        <h2 className="card-title">Configuration</h2>

        {/* Cipher Suite Selector */}
        <CipherSuitePicker
          value={cipherSuite}
          onChange={onCipherSuiteChange}
          disabled={isDisabled}
        />

        {/* Relays Configuration */}
        <div className="form-control">
          <RelayListCreator
            relays={relays}
            label="Relays"
            placeholder="wss://relay.example.com"
            disabled={isDisabled}
            emptyMessage={
              hasKeyPackageRelayList
                ? "No relays configured. Configure your key package relay list (10051) first."
                : "Key package relay list (10051) is missing. Configure it to publish key packages."
            }
            onRelaysChange={onRelaysChange}
          />
        </div>

        {/* Create Button */}
        <div className="card-actions justify-end mt-4">
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={isDisabled || relays.length === 0}
          >
            {isCreating ? (
              <>
                <span className="loading loading-spinner"></span>
                Creating...
              </>
            ) : (
              "Create & Publish Key Package"
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
// Component: SuccessDisplay
// ============================================================================

interface SuccessDisplayProps {
  publishedEvent: NostrEvent;
  keyPackage: KeyPackage;
}

function SuccessDisplay({ publishedEvent, keyPackage }: SuccessDisplayProps) {
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
          <div className="font-bold">Key package published successfully!</div>
          <div className="text-sm">Event ID: {publishedEvent.id}</div>
        </div>
      </div>

      {/* Key Package */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Key Package</h2>
          <KeyPackageDataView keyPackage={keyPackage} />
        </div>
      </div>

      {/* Published Event */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Published Event</h2>
          <div className="divider my-1"></div>
          <JsonBlock value={publishedEvent} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Hook: useKeyPackageCreation
// ============================================================================

function useKeyPackageCreation() {
  const client = useObservable(marmotClient$);
  const [isCreating, setIsCreating] = useState(false);
  const [publishedEvent, setPublishedEvent] = useState<NostrEvent | null>(null);
  const [publishedKeyPackage, setPublishedKeyPackage] =
    useState<KeyPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createAndPublish = async ({
    relays,
    cipherSuite,
  }: {
    relays: string[];
    cipherSuite: CiphersuiteName;
  }) => {
    if (!client) {
      setError("No active client. Please sign in first.");
      return;
    }

    try {
      setIsCreating(true);
      setError(null);
      setPublishedEvent(null);
      setPublishedKeyPackage(null);

      // KeyPackageManager.create() handles everything:
      // credential creation, key package generation, signing, publishing to relays,
      // and storing local private material.
      const listed = await client.keyPackages.create({
        relays,
        ciphersuite: cipherSuite,
        client: "marmot-examples",
      });

      // Retrieve the published event from the store to show in the UI
      const stored = await client.keyPackages.get(listed.keyPackageRef);
      const lastPublished = stored?.published?.[stored.published.length - 1];
      if (lastPublished) {
        setPublishedEvent(lastPublished);
        try {
          setPublishedKeyPackage(getKeyPackage(lastPublished));
        } catch {
          // Non-fatal: published event may not be decodable locally
        }
      }
    } catch (err) {
      console.error("Error creating key package:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const reset = () => {
    setPublishedEvent(null);
    setPublishedKeyPackage(null);
    setError(null);
  };

  return {
    isCreating,
    publishedEvent,
    publishedKeyPackage,
    error,
    createAndPublish,
    reset,
  };
}

// ============================================================================
// Main Component
// ============================================================================

export default withSignIn(function KeyPackageCreate() {
  // Subscribe to the user's key package relays
  const keyPackageRelays = useObservable(keyPackageRelays$);

  const hasKeyPackageRelayList =
    Array.isArray(keyPackageRelays) && keyPackageRelays.length > 0;

  const [relays, setRelays] = useState<string[]>([]);
  const [cipherSuite, setCipherSuite] = useState<CiphersuiteName>(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  );

  // Update relays when saved relays change
  useEffect(() => {
    if (Array.isArray(keyPackageRelays) && keyPackageRelays.length > 0) {
      setRelays(keyPackageRelays);
    } else {
      setRelays([]);
    }
  }, [keyPackageRelays]);

  const {
    isCreating,
    publishedEvent,
    publishedKeyPackage,
    error,
    createAndPublish,
    reset,
  } = useKeyPackageCreation();

  const handleSubmit = () => {
    createAndPublish({ relays, cipherSuite });
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Create Key Package</h1>
        <p className="text-base-content/70">
          Generate and publish a new MLS key package to enable encrypted group
          messaging.
        </p>
      </div>

      {/* Configuration Form */}
      {!publishedEvent && (
        <>
          {!hasKeyPackageRelayList && (
            <div className="alert alert-warning">
              <span>
                Key package relay list (kind 10051) is missing. Configure it to
                publish key packages:{" "}
                <a href="#key-package/relay-list">open relay list settings</a>.
              </span>
            </div>
          )}

          <ConfigurationForm
            relays={relays}
            cipherSuite={cipherSuite}
            isCreating={isCreating}
            hasKeyPackageRelayList={hasKeyPackageRelayList}
            onRelaysChange={setRelays}
            onCipherSuiteChange={setCipherSuite}
            onSubmit={handleSubmit}
          />
        </>
      )}

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Success Display */}
      {publishedEvent && publishedKeyPackage && (
        <>
          <SuccessDisplay
            publishedEvent={publishedEvent}
            keyPackage={publishedKeyPackage}
          />
          <div className="flex justify-start">
            <button className="btn btn-outline" onClick={reset}>
              Create Another
            </button>
          </div>
        </>
      )}
    </div>
  );
});
