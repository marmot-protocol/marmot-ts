import { bytesToHex } from "@noble/hashes/utils.js";
import { defined, mapEventsToTimeline } from "applesauce-core";
import { NostrEvent, relaySet } from "applesauce-core/helpers";
import {
  BehaviorSubject,
  combineLatest,
  from,
  of,
  shareReplay,
  startWith,
  switchMap,
} from "rxjs";
import { map } from "rxjs/operators";
import { ClientState } from "ts-mls/clientState.js";
import { getCiphersuiteNameFromId } from "ts-mls/crypto/ciphersuite.js";
import { getKeyPackageCipherSuiteId } from "../../../../src";
import { MarmotGroup } from "../../../../src/client/group/marmot-group";
import { proposeInviteUser } from "../../../../src/client/group/proposals/invite-user.js";
import {
  extractMarmotGroupData,
  getMemberCount,
} from "../../../../src/core/client-state";
import {
  KEY_PACKAGE_KIND,
  MarmotGroupData,
} from "../../../../src/core/protocol.js";
import CipherSuiteBadge from "../../components/cipher-suite-badge";
import UserSearch from "../../components/form/user-search";
import { withSignIn } from "../../components/with-signIn";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import accounts, { keyPackageRelays$ } from "../../lib/accounts";
import { groupStore$ } from "../../lib/group-store";
import { marmotClient$ } from "../../lib/marmot-client";
import { pool } from "../../lib/nostr";
import { extraRelays$ } from "../../lib/settings";

// ============================================================================
// State Subjects
// ============================================================================

const selectedGroupKey$ = new BehaviorSubject<string>("");
const selectedUserPubkey$ = new BehaviorSubject<string | null>(null);
const selectedKeyPackage$ = new BehaviorSubject<NostrEvent | null>(null);
const error$ = new BehaviorSubject<string | null>(null);
const result$ = new BehaviorSubject<{
  state: ClientState;
  actionType: "propose" | "commit" | "invite";
} | null>(null);
const isAdding$ = new BehaviorSubject<boolean>(false);

// Observable for the currently selected group
// Derives the MarmotGroup from the selectedGroupKey$ and marmotClient$
const group$ = combineLatest([
  selectedGroupKey$,
  marmotClient$.pipe(defined()),
]).pipe(
  switchMap(([groupId, client]) => {
    if (!groupId) {
      return of<MarmotGroup | null>(null);
    }
    return from(client.getGroup(groupId));
  }),
  startWith<MarmotGroup | null>(null),
  shareReplay(1),
);

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
// Component: KeyPackageListItem
// ============================================================================

function KeyPackageListItem({
  event,
  isSelected,
  onSelect,
}: {
  event: NostrEvent;
  isSelected: boolean;
  onSelect: (event: NostrEvent) => void;
}) {
  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const cipherSuiteName = cipherSuiteId
    ? getCiphersuiteNameFromId(cipherSuiteId)
    : "Unknown";

  return (
    <div
      className={`card bg-base-100 border-2 cursor-pointer transition-all ${
        isSelected
          ? "border-primary shadow-lg"
          : "border-base-300 hover:border-base-content/20"
      }`}
      onClick={() => onSelect(event)}
    >
      <div className="card-body p-4">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              {cipherSuiteId && (
                <CipherSuiteBadge cipherSuite={cipherSuiteId} />
              )}
              <span className="text-sm text-base-content/60">
                {cipherSuiteName}
              </span>
            </div>
            <div className="text-xs font-mono text-base-content/60">
              {event.id.slice(0, 16)}...
            </div>
            <div className="text-xs text-base-content/60 mt-1">
              Created: {new Date(event.created_at * 1000).toLocaleString()}
            </div>
          </div>
          {isSelected && (
            <div className="text-primary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Component: ConfigurationForm
// ============================================================================

interface GroupOption {
  groupId: string;
  name: string;
  epoch: number;
  memberCount: number;
  state: ClientState;
  marmotData: MarmotGroupData | null;
}

interface ConfigurationFormProps {
  groups: GroupOption[];
  selectedGroupKey: string;
  selectedUserPubkey: string | null;
  keyPackages: NostrEvent[];
  selectedKeyPackage: NostrEvent | null;
  isAdding: boolean;
  onGroupSelect: (key: string) => void;
  onUserSelect: (pubkey: string) => void;
  onKeyPackageSelect: (event: NostrEvent) => void;
  onPropose: () => void;
  onCommit: () => void;
  onInvite: () => void;
}

function ConfigurationForm({
  groups,
  selectedGroupKey,
  selectedUserPubkey,
  keyPackages,
  selectedKeyPackage,
  isAdding,
  onGroupSelect,
  onUserSelect,
  onKeyPackageSelect,
  onPropose,
  onCommit,
  onInvite,
}: ConfigurationFormProps) {
  const selectedGroup = groups.find((g) => g.groupId === selectedGroupKey);

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body">
        <h2 className="card-title">Configuration</h2>
        <p className="text-base-content/70 mb-4">
          Add a new member to an existing MLS group
        </p>

        <div className="space-y-4">
          {/* Group Selection */}
          <div className="form-control">
            <label className="label">
              <span className="label-text font-semibold">Select Group</span>
            </label>
            {groups.length === 0 ? (
              <div className="alert alert-warning">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6 shrink-0 stroke-current"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <span>No groups available. Create a group first.</span>
              </div>
            ) : (
              <select
                className="select select-bordered w-full"
                value={selectedGroupKey}
                onChange={(e) => onGroupSelect(e.target.value)}
                disabled={isAdding}
              >
                <option value="">Select a group...</option>
                {groups.map((group) => (
                  <option key={group.groupId} value={group.groupId}>
                    {group.name} (Epoch {group.epoch}, {group.memberCount}{" "}
                    members)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Selected Group Details */}
          {selectedGroup && (
            <div className="card bg-base-200">
              <div className="card-body p-4">
                <h3 className="font-semibold mb-2">Selected Group Details</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="font-medium">Name:</span>{" "}
                    {selectedGroup.name}
                  </div>
                  <div>
                    <span className="font-medium">Epoch:</span>{" "}
                    {selectedGroup.epoch}
                  </div>
                  <div>
                    <span className="font-medium">Members:</span>{" "}
                    {selectedGroup.memberCount}
                  </div>
                  <div>
                    <span className="font-medium">Group ID:</span>{" "}
                    {selectedGroup.groupId.slice(0, 16)}...
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* User Search */}
          <div className="form-control">
            <label className="label">
              <span className="label-text font-semibold">Select User</span>
            </label>
            <UserSearch
              onSelect={onUserSelect}
              placeholder="Search for a user to invite..."
            />
          </div>

          {/* Key Packages List */}
          {selectedUserPubkey && (
            <div className="form-control">
              <label className="label">
                <span className="label-text font-semibold">
                  Select Key Package
                </span>
              </label>
              {keyPackages.length === 0 ? (
                <div className="alert alert-info">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-6 w-6 shrink-0 stroke-current"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>Loading key packages...</span>
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {keyPackages.map((event) => (
                    <KeyPackageListItem
                      key={event.id}
                      event={event}
                      isSelected={selectedKeyPackage?.id === event.id}
                      onSelect={onKeyPackageSelect}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          {selectedKeyPackage && selectedGroupKey && (
            <div className="card-actions justify-end mt-6 gap-2">
              <button
                className="btn btn-outline btn-lg"
                onClick={onPropose}
                disabled={isAdding}
              >
                {isAdding ? (
                  <>
                    <span className="loading loading-spinner"></span>
                    Proposing...
                  </>
                ) : (
                  "Propose"
                )}
              </button>
              <button
                className="btn btn-primary btn-lg"
                onClick={onCommit}
                disabled={isAdding}
              >
                {isAdding ? (
                  <>
                    <span className="loading loading-spinner"></span>
                    Committing...
                  </>
                ) : (
                  "Commit"
                )}
              </button>
              <button
                className="btn btn-secondary btn-lg"
                onClick={onInvite}
                disabled={isAdding}
              >
                {isAdding ? (
                  <>
                    <span className="loading loading-spinner"></span>
                    Inviting...
                  </>
                ) : (
                  "Invite (with Welcome)"
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Component: ResultsDisplay
// ============================================================================

interface ResultsDisplayProps {
  result: { state: ClientState };
  actionType: "propose" | "commit" | "invite";
  onReset: () => void;
}

function ResultsDisplay({ result, actionType, onReset }: ResultsDisplayProps) {
  return (
    <div className="space-y-4">
      {/* Success Alert */}
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
          <div className="font-bold">
            {actionType === "propose"
              ? "Proposal sent successfully!"
              : actionType === "invite"
                ? "Invitation sent successfully!"
                : "Member added successfully!"}
          </div>
          <div className="text-sm">
            {(actionType === "commit" || actionType === "invite") &&
              `Group epoch advanced to ${result.state.groupContext.epoch}`}
          </div>
          {actionType === "invite" && (
            <div className="text-sm text-base-content/70 mt-1">
              A Welcome message has been sent to the invitee via NIP-59 gift
              wrap.
            </div>
          )}
        </div>
      </div>

      {/* Updated Group Details */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Updated Group</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="stat bg-base-100 rounded">
              <div className="stat-title">Members</div>
              <div className="stat-value">{getMemberCount(result.state)}</div>
            </div>

            <div className="stat bg-base-100 rounded">
              <div className="stat-title">Epoch</div>
              <div className="stat-value">
                {result.state.groupContext.epoch}
              </div>
            </div>
          </div>

          <div className="divider"></div>

          <div className="space-y-2">
            {(() => {
              const marmotData = extractMarmotGroupData(result.state);
              if (!marmotData)
                return <div>Error: MarmotGroupData not found</div>;

              return (
                <>
                  <div>
                    <span className="font-semibold">Group Name:</span>{" "}
                    {marmotData.name}
                  </div>
                  {marmotData.description && (
                    <div>
                      <span className="font-semibold">Description:</span>{" "}
                      {marmotData.description}
                    </div>
                  )}
                  <div>
                    <span className="font-semibold">Nostr Group ID:</span>{" "}
                    <span className="font-mono text-sm">
                      {bytesToHex(marmotData.nostrGroupId).slice(0, 16)}...
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Reset Button */}
      <div className="flex justify-end">
        <button className="btn btn-outline" onClick={onReset}>
          Add Another Member
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Actions
// ============================================================================

async function proposeMember(
  group: MarmotGroup,
  selectedKeyPackageEvent: NostrEvent,
) {
  try {
    isAdding$.next(true);
    error$.next(null);
    result$.next(null);

    const proposalAction = proposeInviteUser(selectedKeyPackageEvent);
    await group.propose(proposalAction);

    result$.next({ state: group.state, actionType: "propose" });
    console.log("✅ Proposal sent successfully!");
  } catch (err) {
    console.error("Error proposing member:", err);
    error$.next(err instanceof Error ? err.message : String(err));
  } finally {
    isAdding$.next(false);
  }
}

async function commitMember(
  group: MarmotGroup,
  selectedKeyPackageEvent: NostrEvent,
) {
  try {
    isAdding$.next(true);
    error$.next(null);
    result$.next(null);

    const proposalAction = proposeInviteUser(selectedKeyPackageEvent);
    await group.commit({ extraProposals: [proposalAction] });

    result$.next({ state: group.state, actionType: "commit" });
    console.log("✅ Member added successfully!");
  } catch (err) {
    console.error("Error committing member:", err);
    error$.next(err instanceof Error ? err.message : String(err));
  } finally {
    isAdding$.next(false);
  }
}

async function inviteMember(
  group: MarmotGroup,
  selectedKeyPackageEvent: NostrEvent,
) {
  try {
    isAdding$.next(true);
    error$.next(null);
    result$.next(null);

    // Use the new inviteByKeyPackageEvent method
    await group.inviteByKeyPackageEvent(selectedKeyPackageEvent);

    result$.next({ state: group.state, actionType: "invite" });
    console.log("✅ Invitation sent successfully!");
  } catch (err) {
    console.error("Error inviting member:", err);
    error$.next(err instanceof Error ? err.message : String(err));
  } finally {
    isAdding$.next(false);
  }
}

function reset() {
  result$.next(null);
  error$.next(null);
  selectedUserPubkey$.next(null);
  selectedKeyPackage$.next(null);
}

// ============================================================================
// Main Component
// ============================================================================

export default withSignIn(function AddMember() {
  const clientStates =
    useObservableMemo(
      () =>
        groupStore$.pipe(
          switchMap((store) => (store ? store.list() : Promise.resolve([]))),
        ),
      [],
    ) ?? [];

  const groups = clientStates.map((state, index) => {
    const marmotData = extractMarmotGroupData(state);
    const groupIdHex = bytesToHex(state.groupContext.groupId);
    const epoch = Number(state.groupContext.epoch);
    const memberCount = getMemberCount(state);
    const name = marmotData?.name || `Group #${index + 1}`;

    return {
      groupId: groupIdHex,
      name,
      epoch,
      memberCount,
      state,
      marmotData,
    };
  });

  const selectedGroupKey = useObservable(selectedGroupKey$) as string;
  const selectedGroup = useObservable(group$) as MarmotGroup | null;
  const selectedUserPubkey = useObservable(selectedUserPubkey$) as
    | string
    | null;
  const selectedKeyPackage = useObservable(
    selectedKeyPackage$,
  ) as NostrEvent | null;
  const isAdding = useObservable(isAdding$) as boolean;
  const error = useObservable(error$) as string | null;
  const result = useObservable(result$) as {
    state: ClientState;
    actionType: "propose" | "commit" | "invite";
  } | null;

  // Fetch key packages for the selected user
  const keyPackages =
    useObservableMemo(
      () =>
        combineLatest([
          selectedUserPubkey$,
          keyPackageRelays$,
          extraRelays$,
        ]).pipe(
          switchMap(([pubkey, keyPackageRelays, extraRelays]) => {
            if (!pubkey) return of([]);

            const relays = relaySet(
              keyPackageRelays && keyPackageRelays.length > 0
                ? keyPackageRelays
                : [],
              extraRelays,
            );

            return pool
              .request(relays, {
                kinds: [KEY_PACKAGE_KIND],
                authors: [pubkey],
                limit: 50,
              })
              .pipe(
                mapEventsToTimeline(),
                map((arr) => [...arr]),
              );
          }),
        ),
      [],
    ) ?? [];

  const handleGroupSelect = (key: string) => {
    selectedGroupKey$.next(key);
  };

  const handleUserSelect = (pubkey: string) => {
    selectedUserPubkey$.next(pubkey);
    selectedKeyPackage$.next(null);
  };

  const handleKeyPackageSelect = (event: NostrEvent) => {
    selectedKeyPackage$.next(event);
  };

  const handlePropose = async () => {
    if (!selectedGroupKey || !selectedKeyPackage || !selectedGroup) {
      console.error("Please select a group and key package");
      return;
    }

    const selectedGroupData = groups.find(
      (g) => g.groupId === selectedGroupKey,
    );
    if (!selectedGroupData) {
      console.error("Selected group not found");
      return;
    }

    const account = accounts.active;
    if (!account) {
      error$.next("No active account");
      return;
    }

    const currentUserPubkey = await account.signer.getPublicKey();
    const isAdmin =
      selectedGroupData.marmotData?.adminPubkeys?.includes(currentUserPubkey) ||
      false;

    if (!isAdmin) {
      error$.next(
        "You must be an admin to propose adding members to this group",
      );
      return;
    }

    await proposeMember(selectedGroup, selectedKeyPackage);
  };

  const handleCommit = async () => {
    if (!selectedGroupKey || !selectedKeyPackage || !selectedGroup) {
      console.error("Please select a group and key package");
      return;
    }

    const selectedGroupData = groups.find(
      (g) => g.groupId === selectedGroupKey,
    );
    if (!selectedGroupData) {
      console.error("Selected group not found");
      return;
    }

    const account = accounts.active;
    if (!account) {
      error$.next("No active account");
      return;
    }

    const currentUserPubkey = await account.signer.getPublicKey();
    const isAdmin =
      selectedGroupData.marmotData?.adminPubkeys?.includes(currentUserPubkey) ||
      false;

    if (!isAdmin) {
      error$.next(
        "You must be an admin to commit adding members to this group",
      );
      return;
    }

    await commitMember(selectedGroup, selectedKeyPackage);
  };

  const handleInvite = async () => {
    if (!selectedGroupKey || !selectedKeyPackage || !selectedGroup) {
      console.error("Please select a group and key package");
      return;
    }

    const selectedGroupData = groups.find(
      (g) => g.groupId === selectedGroupKey,
    );
    if (!selectedGroupData) {
      console.error("Selected group not found");
      return;
    }

    const account = accounts.active;
    if (!account) {
      error$.next("No active account");
      return;
    }

    const currentUserPubkey = await account.signer.getPublicKey();
    const isAdmin =
      selectedGroupData.marmotData?.adminPubkeys?.includes(currentUserPubkey) ||
      false;

    if (!isAdmin) {
      error$.next("You must be an admin to invite members to this group");
      return;
    }

    await inviteMember(selectedGroup, selectedKeyPackage);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Add Member</h1>
        <p className="text-base-content/70">
          Add a new member to an existing MLS group with Nostr integration
        </p>
      </div>

      {/* Configuration Form */}
      {!result && (
        <ConfigurationForm
          groups={groups}
          selectedGroupKey={selectedGroupKey}
          selectedUserPubkey={selectedUserPubkey}
          keyPackages={keyPackages}
          selectedKeyPackage={selectedKeyPackage}
          isAdding={isAdding}
          onGroupSelect={handleGroupSelect}
          onUserSelect={handleUserSelect}
          onKeyPackageSelect={handleKeyPackageSelect}
          onPropose={handlePropose}
          onCommit={handleCommit}
          onInvite={handleInvite}
        />
      )}

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Results Display */}
      {result && (
        <ResultsDisplay
          result={result}
          actionType={result.actionType}
          onReset={reset}
        />
      )}
    </div>
  );
});
