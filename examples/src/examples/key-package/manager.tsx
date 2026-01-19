import { getSeenRelays, NostrEvent, relaySet } from "applesauce-core/helpers";
import { useEffect, useMemo, useState } from "react";
import {
  combineLatest,
  EMPTY,
  filter,
  map,
  of,
  startWith,
  switchMap,
} from "rxjs";
import { KeyPackage } from "ts-mls";
import {
  CiphersuiteId,
  getCiphersuiteNameFromId,
} from "ts-mls/crypto/ciphersuite.js";
import {
  createDeleteKeyPackageEvent,
  getKeyPackage,
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
  KEY_PACKAGE_KIND,
} from "../../../../src";
import CipherSuiteBadge from "../../components/cipher-suite-badge";
import KeyPackageDataView from "../../components/data-view/key-package";
import ErrorBoundary from "../../components/error-boundary";
import JsonBlock from "../../components/json-block";
import { withSignIn } from "../../components/with-signIn";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import accounts, { keyPackageRelays$, mailboxes$ } from "../../lib/accounts";
import { keyPackageStore$ } from "../../lib/key-package-store";
import { eventStore, pool } from "../../lib/nostr";
import { extraRelays$ } from "../../lib/settings";

// ============================================================================
// Observables
// ============================================================================

/** Observable of all available relays */
const relays$ = combineLatest([
  mailboxes$,
  keyPackageRelays$,
  extraRelays$,
]).pipe(
  map(([mailboxes, keyPackageRelays, extraRelays]) =>
    relaySet(mailboxes?.outboxes, keyPackageRelays, extraRelays),
  ),
);

/** Observable of current user's key packages from all available relays */
const keyPackageSubscription$ = combineLatest([accounts.active$, relays$]).pipe(
  switchMap(([account, relays]) => {
    if (!account) return EMPTY;

    return pool.subscription(
      relays,
      {
        kinds: [KEY_PACKAGE_KIND],
        authors: [account.pubkey],
      },
      { eventStore },
    );
  }),
);

/** An observable of the key packages events from the event store, use this so deletes are handled automatically in the UI */
const keyPackageTimeline$ = accounts.active$.pipe(
  switchMap((account) =>
    account
      ? eventStore.timeline({
          kinds: [KEY_PACKAGE_KIND],
          authors: [account.pubkey],
        })
      : of([]),
  ),
);

// ============================================================================
// Utility Functions
// ============================================================================

/** Format timestamp to relative time (e.g., "2 hours ago") */
function formatTimeAgo(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)} weeks ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// ============================================================================
// Debug Modal Component
// ============================================================================

interface DebugModalProps {
  event: NostrEvent;
  isOpen: boolean;
  onClose: () => void;
}

function DebugModal({ event, isOpen, onClose }: DebugModalProps) {
  const [keyPackage, setKeyPackage] = useState<KeyPackage | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      try {
        const pkg = getKeyPackage(event);
        setKeyPackage(pkg);
        setParseError(null);
      } catch (error) {
        setParseError(error instanceof Error ? error.message : String(error));
        setKeyPackage(null);
      }
    }
  }, [event, isOpen]);

  if (!isOpen) return null;

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-4xl">
        <h3 className="font-bold text-lg mb-4">Debug: Key Package Data</h3>

        <div className="space-y-4">
          {/* Raw Nostr Event */}
          <div>
            <h4 className="font-semibold mb-2">Raw Nostr Event</h4>
            <div className="bg-base-200 p-4 rounded-lg overflow-auto max-h-96 font-mono text-sm">
              <JsonBlock value={event} />
            </div>
          </div>

          {/* Raw Key Package Data */}
          <div>
            <h4 className="font-semibold mb-2">Raw Key Package Data</h4>
            {parseError ? (
              <div className="alert alert-error">
                <span>Parse Error: {parseError}</span>
              </div>
            ) : keyPackage ? (
              <div className="bg-base-200 p-4 rounded-lg overflow-auto max-h-96">
                <KeyPackageDataView keyPackage={keyPackage} />
              </div>
            ) : (
              <div className="flex justify-center p-4">
                <span className="loading loading-spinner"></span>
              </div>
            )}
          </div>
        </div>

        <div className="modal-action">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}

// ============================================================================
// Key Package Card Component
// ============================================================================

interface KeyPackageCardProps {
  event: NostrEvent;
  isSelected: boolean;
  onToggleSelect: (eventId: string) => void;
  onDelete: (event: NostrEvent) => void;
}

function KeyPackageCard({
  event,
  isSelected,
  onToggleSelect,
  onDelete,
}: KeyPackageCardProps) {
  const keyPackageStore = useObservable(keyPackageStore$);
  // Subscribe to event updates so that seen relays are updated
  const seenRelays = useObservableMemo(
    () =>
      eventStore.update$.pipe(
        filter((e) => e.id === event.id),
        startWith(event),
        map((event) => getSeenRelays(event)),
      ),
    [event.id],
  );

  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [checkingPrivateKey, setCheckingPrivateKey] = useState(true);
  const [debugModalOpen, setDebugModalOpen] = useState(false);

  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const client = getKeyPackageClient(event);
  const timeAgo = formatTimeAgo(event.created_at);

  // Check if private key exists in local storage
  useEffect(() => {
    if (!keyPackageStore) return;

    const checkPrivateKey = async () => {
      try {
        const keyPackage = getKeyPackage(event);
        const exists = await keyPackageStore.has(keyPackage);
        setHasPrivateKey(exists);
      } catch (error) {
        console.error("Error checking private key:", error);
        setHasPrivateKey(false);
      } finally {
        setCheckingPrivateKey(false);
      }
    };
    checkPrivateKey();
  }, [event, keyPackageStore]);

  return (
    <div
      className={`card bg-base-100 border ${
        isSelected ? "border-primary border-2" : "border-base-300"
      } shadow-sm`}
    >
      <div className="card-body p-4">
        <div className="flex items-start gap-3">
          {/* Selection Checkbox */}
          <input
            type="checkbox"
            className="checkbox checkbox-primary mt-1"
            checked={isSelected}
            onChange={() => onToggleSelect(event.id)}
          />

          {/* Main Content */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Header Row */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-mono truncate opacity-60">{event.id}</div>
                <div className="opacity-40 mt-1">{timeAgo}</div>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDebugModalOpen(true)}
                  title="Debug"
                >
                  View
                </button>
                <button
                  className="btn btn-error btn-sm"
                  onClick={() => onDelete(event)}
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-2 gap-3">
              {/* Client */}
              <div>
                <div className="label-text opacity-60 mb-1">Client</div>
                <span className="badge badge-outline">
                  {client?.name || "Unknown"}
                </span>
              </div>

              {/* Cipher Suite */}
              <div>
                <div className="label-text opacity-60 mb-1">Cipher Suite</div>
                {cipherSuiteId !== undefined ? (
                  <CipherSuiteBadge cipherSuite={cipherSuiteId} />
                ) : (
                  <span className="badge badge-error badge-outline">
                    Unknown
                  </span>
                )}
              </div>

              {/* Private Key Status */}
              <div className="col-span-2">
                <div className="label-text opacity-60 mb-1">Private Key</div>
                {checkingPrivateKey ? (
                  <span className="loading loading-spinner loading-xs"></span>
                ) : hasPrivateKey ? (
                  <span className="badge badge-success">Stored Locally</span>
                ) : (
                  <span className="badge badge-ghost">Not Stored</span>
                )}
              </div>

              {/* Relay Sources */}
              {seenRelays && seenRelays.size > 0 && (
                <div className="col-span-2">
                  <div className="label-text opacity-60 mb-1">
                    Received From ({seenRelays.size} relay
                    {seenRelays.size !== 1 ? "s" : ""})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Array.from(seenRelays).map((relay) => (
                      <span
                        key={relay}
                        className="badge badge-sm badge-outline"
                      >
                        {relay.replace(/^wss?:\/\//, "").replace(/\/$/, "")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Debug Modal */}
      <DebugModal
        event={event}
        isOpen={debugModalOpen}
        onClose={() => setDebugModalOpen(false)}
      />
    </div>
  );
}

// ============================================================================
// Filter Controls Component
// ============================================================================

interface FilterControlsProps {
  cipherSuiteFilter: CiphersuiteId | "all";
  onCipherSuiteFilterChange: (value: CiphersuiteId | "all") => void;
  clientFilter: string;
  onClientFilterChange: (value: string) => void;
  afterDate: string;
  onAfterDateChange: (value: string) => void;
  beforeDate: string;
  onBeforeDateChange: (value: string) => void;
  onClearFilters: () => void;
  availableCipherSuites: CiphersuiteId[];
  availableClients: string[];
}

function FilterControls({
  cipherSuiteFilter,
  onCipherSuiteFilterChange,
  clientFilter,
  onClientFilterChange,
  afterDate,
  onAfterDateChange,
  beforeDate,
  onBeforeDateChange,
  onClearFilters,
  availableCipherSuites,
  availableClients,
}: FilterControlsProps) {
  return (
    <div className="card bg-base-200">
      <div className="card-body">
        <div className="flex items-center justify-between">
          <h3 className="card-title">Filters</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClearFilters}>
            Clear All
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Cipher Suite Filter */}
          <div>
            <label className="label">
              <span className="label-text">Cipher Suite</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={cipherSuiteFilter}
              onChange={(e) =>
                onCipherSuiteFilterChange(
                  e.target.value === "all"
                    ? "all"
                    : (parseInt(e.target.value) as CiphersuiteId),
                )
              }
            >
              <option value="all">All</option>
              {availableCipherSuites.map((suite) => (
                <option key={suite} value={suite}>
                  {getCiphersuiteNameFromId(suite) || "Unknown"}
                </option>
              ))}
            </select>
          </div>

          {/* Client Filter */}
          <div>
            <label className="label">
              <span className="label-text">Client</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={clientFilter}
              onChange={(e) => onClientFilterChange(e.target.value)}
            >
              <option value="all">All</option>
              {availableClients.map((client) => (
                <option key={client} value={client}>
                  {client}
                </option>
              ))}
            </select>
          </div>

          {/* After Date Filter */}
          <div>
            <label className="label">
              <span className="label-text">After Date</span>
            </label>
            <input
              type="date"
              className="input input-bordered w-full"
              value={afterDate}
              onChange={(e) => onAfterDateChange(e.target.value)}
            />
          </div>

          {/* Before Date Filter */}
          <div>
            <label className="label">
              <span className="label-text">Before Date</span>
            </label>
            <input
              type="date"
              className="input input-bordered w-full"
              value={beforeDate}
              onChange={(e) => onBeforeDateChange(e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Bulk Action Toolbar Component
// ============================================================================

interface BulkActionToolbarProps {
  selectedCount: number;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
}

function BulkActionToolbar({
  selectedCount,
  onDeleteSelected,
  onClearSelection,
}: BulkActionToolbarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="alert alert-info">
      <div className="flex-1">
        <span>
          {selectedCount} key package{selectedCount !== 1 ? "s" : ""} selected
        </span>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onClearSelection}>
          Clear Selection
        </button>
        <button className="btn btn-error btn-sm" onClick={onDeleteSelected}>
          Delete Selected
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Confirmation Dialog Component
// ============================================================================

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

function ConfirmationDialog({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  isLoading = false,
}: ConfirmationDialogProps) {
  if (!isOpen) return null;

  return (
    <dialog className="modal modal-open">
      <div className="modal-box">
        <h3 className="text-lg font-bold">{title}</h3>
        <p className="py-4">{message}</p>
        <div className="modal-action">
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            className="btn btn-error"
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <span className="loading loading-spinner"></span>
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onCancel} disabled={isLoading}>
          close
        </button>
      </form>
    </dialog>
  );
}

// ============================================================================
// Main Component
// ============================================================================

function KeyPackageManager() {
  // Observables
  const keyPackages = useObservable(keyPackageTimeline$);
  const keyPackageStore = useObservable(keyPackageStore$);

  // Fetch key packages from relays
  useObservable(keyPackageSubscription$);

  // Filter state
  const [cipherSuiteFilter, setCipherSuiteFilter] = useState<
    CiphersuiteId | "all"
  >("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [afterDate, setAfterDate] = useState<string>("");
  const [beforeDate, setBeforeDate] = useState<string>("");

  const relays = useObservable(relays$);

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Deletion state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    events: NostrEvent[];
  }>({ isOpen: false, events: [] });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Get unique cipher suites and clients from packages
  const { availableCipherSuites, availableClients } = useMemo(() => {
    const suites = new Set<CiphersuiteId>();
    const clients = new Set<string>();

    keyPackages?.forEach((pkg) => {
      const suite = getKeyPackageCipherSuiteId(pkg);
      if (suite !== undefined) suites.add(suite);

      const client = getKeyPackageClient(pkg);
      if (client?.name) clients.add(client.name);
    });

    return {
      availableCipherSuites: Array.from(suites).sort((a, b) => a - b),
      availableClients: Array.from(clients).sort(),
    };
  }, [keyPackages]);

  // Filter packages
  const filteredPackages = useMemo(() => {
    let filtered = keyPackages || [];

    // Filter by cipher suite
    if (cipherSuiteFilter !== "all") {
      filtered = filtered.filter(
        (pkg) => getKeyPackageCipherSuiteId(pkg) === cipherSuiteFilter,
      );
    }

    // Filter by client
    if (clientFilter !== "all") {
      filtered = filtered.filter(
        (pkg) => getKeyPackageClient(pkg)?.name === clientFilter,
      );
    }

    // Filter by date range
    if (afterDate) {
      const afterTimestamp = new Date(afterDate).getTime() / 1000;
      filtered = filtered.filter((pkg) => pkg.created_at >= afterTimestamp);
    }
    if (beforeDate) {
      const beforeTimestamp = new Date(beforeDate).getTime() / 1000;
      filtered = filtered.filter((pkg) => pkg.created_at <= beforeTimestamp);
    }

    return filtered;
  }, [keyPackages, cipherSuiteFilter, clientFilter, afterDate, beforeDate]);

  // Handlers
  const handleToggleSelect = (eventId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleClearFilters = () => {
    setCipherSuiteFilter("all");
    setClientFilter("all");
    setAfterDate("");
    setBeforeDate("");
  };

  const handleDeleteSingle = (event: NostrEvent) => {
    setConfirmDialog({ isOpen: true, events: [event] });
  };

  const handleDeleteSelected = () => {
    const eventsToDelete = filteredPackages.filter((pkg) =>
      selectedIds.has(pkg.id),
    );
    setConfirmDialog({ isOpen: true, events: eventsToDelete });
  };

  const handleConfirmDelete = async () => {
    const account = accounts.active;
    if (!account) {
      setDeleteError("No active account");
      return;
    }

    try {
      setIsDeleting(true);
      setDeleteError(null);

      if (!relays || relays.length === 0)
        throw new Error(
          "No relays available for publishing deletion event. Please configure your relay list or add manual relays.",
        );

      const eventsToDelete = confirmDialog.events;

      // 1. Create deletion event
      const draft = createDeleteKeyPackageEvent({
        pubkey: account.pubkey,
        events: eventsToDelete,
      });

      // 2. Sign the event
      const signed = await account.signEvent(draft);

      // 4. Add to event store so UI can update
      eventStore.add(signed);

      // 5. Publish deletion event to relays
      const results = await pool.publish(relays, signed);
      for (const result of results) {
        if (result.ok) {
          console.log("Published deletion to", result.from);
        } else {
          console.error(
            "Failed to publish deletion to",
            result.from,
            result.message,
          );
        }
      }

      // 6. Remove from local storage
      for (const event of eventsToDelete) {
        try {
          const keyPackage = getKeyPackage(event);
          await keyPackageStore?.remove(keyPackage);
          console.log("Removed from local storage:", event.id);
        } catch (err) {
          console.error("Failed to remove from local storage:", event.id, err);
        }
      }

      // Clear selection
      setSelectedIds(new Set());
      setConfirmDialog({ isOpen: false, events: [] });
    } catch (error) {
      console.error("Error deleting key packages:", error);
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Failed to delete key packages",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancelDelete = () => {
    setConfirmDialog({ isOpen: false, events: [] });
    setDeleteError(null);
  };

  return (
    <div className="container mx-auto p-4 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Key Package Manager</h1>
        <p className="opacity-70">
          View and manage your published key packages. Delete individual
          packages or select multiple for bulk deletion.
        </p>
      </div>

      {/* Relay Configuration */}
      <div className="space-y-4">
        {/* Relay List Info */}
        {relays && relays.length > 0 ? (
          <div className="alert alert-info">
            <div>
              <div className="font-semibold">
                Monitoring {relays.length} relay
                {relays.length !== 1 ? "s" : ""}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {relays.map((relay) => (
                  <span key={relay} className="badge">
                    {relay.replace(/^wss?:\/\//, "").replace(/\/$/, "")}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="alert alert-warning">
            <span>
              No key package relay list found. Please configure your relay list
              (kind 10051) or add a manual relay to see your key packages.
            </span>
          </div>
        )}
      </div>

      {/* Filter Controls */}
      {keyPackages && keyPackages.length > 0 && (
        <FilterControls
          cipherSuiteFilter={cipherSuiteFilter}
          onCipherSuiteFilterChange={setCipherSuiteFilter}
          clientFilter={clientFilter}
          onClientFilterChange={setClientFilter}
          afterDate={afterDate}
          onAfterDateChange={setAfterDate}
          beforeDate={beforeDate}
          onBeforeDateChange={setBeforeDate}
          onClearFilters={handleClearFilters}
          availableCipherSuites={availableCipherSuites}
          availableClients={availableClients}
        />
      )}

      {/* Bulk Action Toolbar */}
      <BulkActionToolbar
        selectedCount={selectedIds.size}
        onDeleteSelected={handleDeleteSelected}
        onClearSelection={handleClearSelection}
      />

      {/* Error Display */}
      {deleteError && (
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
          <span>Error: {deleteError}</span>
        </div>
      )}

      {/* Key Packages List */}
      <div className="space-y-3">
        <h2 className="text-2xl font-bold">
          Key Packages ({filteredPackages.length})
        </h2>

        {keyPackages === undefined ? (
          <div className="flex justify-center p-8">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        ) : filteredPackages.length > 0 ? (
          <div className="space-y-3">
            {filteredPackages.map((event) => (
              <ErrorBoundary key={event.id}>
                <KeyPackageCard
                  event={event as NostrEvent}
                  isSelected={selectedIds.has(event.id)}
                  onToggleSelect={handleToggleSelect}
                  onDelete={handleDeleteSingle}
                />
              </ErrorBoundary>
            ))}
          </div>
        ) : keyPackages.length === 0 ? (
          <div className="alert alert-info">
            <span>
              No key packages found. Create a new key package to get started.
            </span>
          </div>
        ) : (
          <div className="alert alert-info">
            <span>No key packages match the current filters.</span>
          </div>
        )}
      </div>

      {/* Confirmation Dialog */}
      <ConfirmationDialog
        isOpen={confirmDialog.isOpen}
        title="Delete Key Packages"
        message={`Are you sure you want to delete ${confirmDialog.events.length} key package${confirmDialog.events.length !== 1 ? "s" : ""}? This will remove them from relays and local storage.`}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
        isLoading={isDeleting}
      />
    </div>
  );
}

export default withSignIn(KeyPackageManager);
