import { bytesToHex } from "@noble/hashes/utils.js";
import { mapEventsToTimeline } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { useMemo, useState } from "react";
import { of } from "rxjs";
import { map } from "rxjs/operators";
import {
  type CredentialBasic,
  defaultCredentialTypes,
  encode,
  KeyPackage,
  keyPackageEncoder,
} from "ts-mls";

import {
  addRelayHintsToPointer,
  getEventPointerForEvent,
  getSeenRelays,
  neventEncode,
  NostrEvent,
} from "applesauce-core/helpers";
import {
  getCredentialPubkey,
  getKeyPackage,
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
  getKeyPackageExtensions,
  getKeyPackageMLSVersion,
  getKeyPackageRelays,
  KEY_PACKAGE_KIND,
} from "../../../../src";
import CipherSuiteBadge from "../../components/cipher-suite-badge";
import CredentialTypeBadge from "../../components/credential-type-badge";
import KeyPackageDataView from "../../components/data-view/key-package";
import { DetailsField } from "../../components/details-field";
import ErrorBoundary from "../../components/error-boundary";
import ExtensionBadge from "../../components/extension-badge";
import RelayPicker from "../../components/form/relay-picker";
import JsonBlock from "../../components/json-block";
import { LeafNodeCapabilitiesSection } from "../../components/key-package/leaf-node-capabilities";
import { UserAvatar, UserName } from "../../components/nostr-user";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import { pool } from "../../lib/nostr";
import { relayConfig$ } from "../../lib/settings";

const formatDate = (timestamp: number) => {
  return new Date(timestamp * 1000).toLocaleString();
};

// ============================================================================
// Key Package Card
// ============================================================================

/** A component that renders top-level key package info from Nostr event */
function KeyPackageTopLevelInfo(props: { event: NostrEvent }) {
  const mlsVersion = getKeyPackageMLSVersion(props.event);
  const cipherSuiteId = getKeyPackageCipherSuiteId(props.event);
  const extensions = getKeyPackageExtensions(props.event);
  const relays = getKeyPackageRelays(props.event);
  const client = getKeyPackageClient(props.event);

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">
          Key Package Configuration
        </h3>
        <p className="text-sm text-base-content/60">
          Top-level cipher suite and extensions from the Nostr event
        </p>
      </div>

      {/* Top-level Key Package Details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* MLS Version */}
        <DetailsField label="MLS Version">
          <span className="badge badge-outline">
            {mlsVersion || <span className="text-warning">Not specified</span>}
          </span>
        </DetailsField>

        {/* Cipher Suite */}
        <DetailsField label="Cipher Suite">
          {cipherSuiteId !== undefined ? (
            <CipherSuiteBadge cipherSuite={cipherSuiteId} />
          ) : (
            <span className="badge badge-error badge-outline">Unknown</span>
          )}
        </DetailsField>

        {/* Client Info */}
        <DetailsField label="Client">{client?.name || "Unknown"}</DetailsField>
      </div>

      {/* Extensions - Full width */}
      <DetailsField label="Extensions">
        <div className="flex flex-wrap gap-2">
          {extensions && extensions.length > 0 ? (
            extensions.map((extension) => (
              <ExtensionBadge key={extension} extensionType={extension} />
            ))
          ) : (
            <span className="badge badge-error badge-outline">None</span>
          )}
        </div>
      </DetailsField>

      {/* Relays - Full width */}
      <DetailsField label="Relays">
        <div className="flex flex-wrap gap-2">
          {relays && relays.length > 0 ? (
            relays.map((relay) => (
              <span key={relay} className="badge badge-outline">
                {relay}
              </span>
            ))
          ) : (
            <span className="badge badge-error badge-outline">None</span>
          )}
        </div>
      </DetailsField>

      {/* Raw Nostr Event Collapsible */}
      <div className="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div className="collapse-title text-sm font-medium py-2 min-h-0">
          Raw Nostr Event
        </div>
        <div className="collapse-content">
          <JsonBlock value={props.event} />
        </div>
      </div>
    </div>
  );
}

function CredentialSection({
  credential,
  event,
}: {
  credential: CredentialBasic;
  event: NostrEvent;
}) {
  const pubkey = getCredentialPubkey(credential);
  const isValid = pubkey === event.pubkey;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">Credential</h3>
        <p className="text-sm text-base-content/60">
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
            {isValid ? (
              <span className="badge badge-success">Valid</span>
            ) : (
              <span className="badge badge-error">Invalid</span>
            )}
          </div>
          <code className="text-xs text-base-content/60 break-all block">
            {pubkey}
          </code>
          {!isValid && (
            <div className="text-xs text-error mt-2">
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
          <p className="break-all select-all font-mono text-xs">
            {bytesToHex(credential.identity)}
          </p>
        </DetailsField>
      </div>
    </div>
  );
}

/** A component that renders decoded MLS key package details */
function MLSKeyPackageContent({
  keyPackage,
  event,
}: {
  keyPackage: KeyPackage;
  event: NostrEvent;
}) {
  return (
    <div className="space-y-4">
      {/* Credential Section */}
      {keyPackage.leafNode.credential.credentialType ===
        defaultCredentialTypes.basic && (
        <ErrorBoundary>
          <CredentialSection
            credential={keyPackage.leafNode.credential as CredentialBasic}
            event={event}
          />
        </ErrorBoundary>
      )}

      {/* Divider */}
      <div className="divider" />

      {/* Leaf Node Capabilities */}
      <LeafNodeCapabilitiesSection leafNode={keyPackage.leafNode} />

      {/* Full Key Package Data Collapsible */}
      <div className="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div className="collapse-title text-sm font-medium py-2 min-h-0">
          Full Key Package Data (Advanced)
        </div>
        <div className="collapse-content">
          <KeyPackageDataView keyPackage={keyPackage} />
        </div>
      </div>

      {/* Raw Key Package Data Collapsible */}
      <div className="collapse collapse-arrow bg-base-200">
        <input type="checkbox" />
        <div className="collapse-title text-sm font-medium py-2 min-h-0">
          Raw Key Package Data (Binary)
        </div>
        <div className="collapse-content">
          <code className="text-xs break-all select-all block">
            {bytesToHex(encode(keyPackageEncoder, keyPackage))}
          </code>
        </div>
      </div>
    </div>
  );
}

/** A component that renders a key package card content */
function KeyPackageCardContent(props: { event: NostrEvent }) {
  // Parse the key package data
  const keyPackage = useMemo<KeyPackage>(
    () => getKeyPackage(props.event),
    [props.event],
  );

  const nevent = useMemo(() => {
    const seenRelays = getSeenRelays(props.event);
    const relays = seenRelays ? Array.from(seenRelays) : [];
    const pointer = addRelayHintsToPointer(
      getEventPointerForEvent(props.event),
      relays,
    );
    return neventEncode(pointer);
  }, [props.event]);

  return (
    <div className="bg-base-100 p-6 rounded-lg">
      {/* Header with user info */}
      <div className="mb-4 flex gap-3 items-start">
        <UserAvatar pubkey={props.event.pubkey} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg mb-1">
            <UserName pubkey={props.event.pubkey} />
          </h3>
          <div className="text-xs text-base-content/60 space-y-1">
            <div className="font-mono break-all">
              nevent: <span className="select-all break-all">{nevent}</span>
            </div>
            <div>{formatDate(props.event.created_at)}</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div role="tablist" className="tabs tabs-lift">
        <input
          type="radio"
          name={props.event.id}
          className="tab"
          aria-label="Nostr Event"
          defaultChecked
        />
        <div className="tab-content bg-base-100 border-base-300 p-6">
          <KeyPackageTopLevelInfo event={props.event} />
        </div>

        <input
          type="radio"
          name={props.event.id}
          className="tab"
          aria-label="MLS Key Package"
        />
        <div className="tab-content bg-base-100 border-base-300 p-6">
          <MLSKeyPackageContent keyPackage={keyPackage} event={props.event} />
        </div>
      </div>
    </div>
  );
}

function KeyPackageCard(props: { event: NostrEvent }) {
  return (
    <ErrorBoundary>
      <KeyPackageCardContent event={props.event} />
    </ErrorBoundary>
  );
}

// ============================================================================
// Main Explorer Component
// ============================================================================

export default function KeyPackageExplorer() {
  const relayConfig = useObservable(relayConfig$);
  const [selectedRelay, setSelectedRelay] = useState<string>(
    relayConfig?.lookupRelays?.[0] || "",
  );
  const [selectedUser, setSelectedUser] = useState<string>("all");

  // Subscribe to key package events from the selected relay (debug view)
  const events = useObservableMemo(() => {
    // Return empty observable if selectedRelay is empty to avoid invalid relay requests
    if (!selectedRelay) {
      return of([]);
    }

    return pool
      .subscription([selectedRelay], {
        kinds: [KEY_PACKAGE_KIND],
        limit: 100,
      })
      .pipe(
        onlyEvents(),
        mapEventsToTimeline(),
        map((arr) => [...arr]),
      );
  }, [selectedRelay]);

  // Get unique users from events with their counts
  const users = useMemo(() => {
    const allEvents = events || [];
    const userCounts = new Map<string, number>();

    allEvents.forEach((e: any) => {
      userCounts.set(e.pubkey, (userCounts.get(e.pubkey) || 0) + 1);
    });

    return userCounts;
  }, [events]);

  // Filter events based on selected user
  const filteredEvents = useMemo(() => {
    const allEvents = events || [];
    const selected = selectedUser;
    if (selected === "all") return Array.from(allEvents);

    return allEvents.filter((e: any) => e.pubkey === selected);
  }, [events, selectedUser]);

  return (
    <div className="container mx-auto p-4 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Key Package Explorer</h1>
        <p className="text-base-content/70">
          Browse and debug MLS key packages published to Nostr (kind 443 events)
        </p>
      </div>

      {/* Relay Picker */}
      <RelayPicker value={selectedRelay} onChange={setSelectedRelay} />

      {/* User Filter */}
      <div className="form-control w-full max-w-xs">
        <label className="label">
          <span className="label-text font-semibold">Filter by User</span>
        </label>
        <select
          className="select select-bordered"
          value={selectedUser}
          onChange={(e) => setSelectedUser(e.target.value)}
        >
          <option value="all">All Users ({(events || []).length})</option>
          {Array.from(users.entries()).map(([pubkey, count]) => (
            <option key={pubkey} value={pubkey}>
              <UserName pubkey={pubkey} /> ({count})
            </option>
          ))}
        </select>
      </div>

      {/* Event Count */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">
          Key Packages ({filteredEvents.length})
        </h2>
      </div>

      {/* Events List */}
      <div className="space-y-4">
        {filteredEvents.map((event: any) => (
          <KeyPackageCard key={event.id} event={event as NostrEvent} />
        ))}
      </div>
    </div>
  );
}
