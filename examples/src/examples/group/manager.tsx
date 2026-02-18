import { bytesToHex } from "@noble/hashes/utils.js";
import { useEffect, useState } from "react";
import { ClientState } from "ts-mls/clientState.js";
import {
  extractMarmotGroupData,
  getEpoch,
  getGroupIdHex,
  getNostrGroupIdHex,
  getMemberCount,
} from "../../../../src/core";
import ClientStateDataView from "../../components/data-view/client-state";
import { withSignIn } from "../../components/with-signIn";
import { useObservable } from "../../hooks/use-observable";
import { destroyGroup, groupCount$, groups$ } from "../../lib/groups";

// ============================================================================
// Component: GroupCard
// ============================================================================

interface GroupCardProps {
  clientState: ClientState;
  onDelete: (groupId: string) => Promise<void>;
}

function GroupCard({ clientState, onDelete }: GroupCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Extract metadata from the client state
  const marmotData = extractMarmotGroupData(clientState);
  const groupIdHex = getGroupIdHex(clientState);
  const epoch = getEpoch(clientState);
  const memberCount = getMemberCount(clientState);
  const name = marmotData?.name || "Unnamed Group";
  // MIP-01 v2: nostr_group_id lives in MarmotGroupData and is bytes, not hex.
  // Prefer the validated helper, but fall back to raw bytes-to-hex when needed.
  let nostrGroupIdHex = groupIdHex;
  try {
    nostrGroupIdHex = getNostrGroupIdHex(clientState);
  } catch {
    if (marmotData?.nostrGroupId) {
      nostrGroupIdHex = bytesToHex(marmotData.nostrGroupId);
    }
  }

  const handleDelete = async () => {
    if (
      !confirm(
        "Are you sure you want to delete this group? This action cannot be undone.",
      )
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete(groupIdHex);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body">
        {/* Header */}
        <div className="flex justify-between items-start mb-4">
          <div className="flex-1">
            <h3 className="card-title text-lg mb-1">{name}</h3>
          </div>
          <button
            className="btn btn-sm btn-outline btn-error"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <span className="loading loading-spinner loading-xs"></span>
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </button>
        </div>

        {/* Group Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <div className="stat p-2 bg-base-200 rounded">
            <div className="stat-title text-xs">Epoch</div>
            <div className="stat-value text-lg">{epoch}</div>
          </div>

          <div className="stat p-2 bg-base-200 rounded">
            <div className="stat-title text-xs">Members</div>
            <div className="stat-value text-lg">{memberCount}</div>
          </div>

          <div className="stat p-2 bg-base-200 rounded">
            <div className="stat-title text-xs">Group ID</div>
            <div className="stat-value text-xs font-mono">
              {groupIdHex.slice(0, 16)}...
            </div>
          </div>

          <div className="stat p-2 bg-base-200 rounded">
            <div className="stat-title text-xs">Nostr Group ID</div>
            <div className="stat-value text-xs font-mono">
              {nostrGroupIdHex.slice(0, 16)}...
            </div>
          </div>
        </div>

        {/* Details Toggle */}
        <div className="card-actions justify-between">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? "Hide Details" : "View Details"}
          </button>
        </div>

        {/* Client State Details */}
        {showDetails && (
          <div className="mt-4 bg-base-200 p-4 rounded-lg overflow-auto max-h-96">
            <ClientStateDataView clientState={clientState} />
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Component: EmptyState
// ============================================================================

function EmptyState() {
  return (
    <div className="text-center py-12">
      <div className="max-w-md mx-auto">
        <svg
          className="mx-auto h-12 w-12 text-base-content/30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <h3 className="mt-4 text-lg font-medium">No groups found</h3>
        <p className="mt-2 text-base-content/70">
          Create your first group to get started with MLS messaging.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Component: LoadingState
// ============================================================================

function LoadingState() {
  return (
    <div className="flex justify-center items-center py-12">
      <span className="loading loading-spinner loading-lg"></span>
      <span className="ml-2">Loading groups...</span>
    </div>
  );
}

// ============================================================================
// Main Component: GroupManager
// ============================================================================

function GroupManager() {
  const hydratedGroups = useObservable(groups$) ?? [];
  const groupCount = useObservable(groupCount$);
  const [groups, setGroups] = useState<ClientState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadGroups = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setGroups(hydratedGroups.map((g) => g.state));
      } catch (err) {
        console.error("Failed to load groups:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    };

    loadGroups();
  }, [hydratedGroups, groupCount]);

  const handleDelete = async (groupId: string) => {
    try {
      await destroyGroup(groupId);
      setError(null);
    } catch (err) {
      console.error("Failed to delete group:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Group Manager</h1>
        <p className="text-base-content/70">
          View and manage your locally stored MLS groups
        </p>
      </div>

      {/* Error Display */}
      {error && (
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
      )}

      {/* Loading State */}
      {isLoading && <LoadingState />}

      {/* Empty State */}
      {!isLoading && groups.length === 0 && <EmptyState />}

      {/* Groups Grid */}
      {!isLoading && groups.length > 0 && (
        <div className="grid grid-cols-1 gap-6">
          {groups.map((clientState, index) => {
            const groupIdHex = getGroupIdHex(clientState);

            return (
              <GroupCard
                key={groupIdHex || index}
                clientState={clientState}
                onDelete={handleDelete}
              />
            );
          })}
        </div>
      )}

      {/* Groups Count */}
      {!isLoading && groups.length > 0 && (
        <div className="text-center text-base-content/70">
          Showing {groups.length} group{groups.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

export default withSignIn(GroupManager);
