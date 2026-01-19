import { bytesToHex } from "@noble/hashes/utils.js";
import { mapEventsToTimeline } from "applesauce-core";
import { NostrEvent, relaySet } from "applesauce-core/helpers";
import { BehaviorSubject, of, from } from "rxjs";
import { map } from "rxjs/operators";
import { getMemberCount } from "../../../../src/core/client-state";
import { extractMarmotGroupData } from "../../../../src/core/client-state";
import { getWelcome } from "../../../../src/core/welcome";
import { withSignIn } from "../../components/with-signIn";
import { useObservable, useObservableMemo } from "../../hooks/use-observable";
import accounts from "../../lib/accounts";
import { marmotClient$ } from "../../lib/marmot-client";
import { pool } from "../../lib/nostr";
import { extraRelays$ } from "../../lib/settings";
import { Rumor, unlockGiftWrap } from "applesauce-common/helpers";

// ============================================================================
// Types
// ============================================================================

interface WelcomeMessage {
  giftWrapEvent: NostrEvent;
  welcomeRumor: Rumor;
  relays: string[];
  keyPackageEventId?: string;
  cipherSuite?: string;
  timestamp: number;
}

// ============================================================================
// State Subjects
// ============================================================================

const selectedWelcome$ = new BehaviorSubject<WelcomeMessage | null>(null);
const isJoining$ = new BehaviorSubject<boolean>(false);
const error$ = new BehaviorSubject<string | null>(null);
const result$ = new BehaviorSubject<{
  groupId: string;
  groupName: string;
  epoch: number;
  memberCount: number;
} | null>(null);

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
// Component: WelcomeListItem
// ============================================================================

function WelcomeListItem({
  welcome,
  isSelected,
  onSelect,
}: {
  welcome: WelcomeMessage;
  isSelected: boolean;
  onSelect: (welcome: WelcomeMessage) => void;
}) {
  return (
    <div
      className={`card bg-base-100 border-2 cursor-pointer transition-all ${
        isSelected
          ? "border-primary shadow-lg"
          : "border-base-300 hover:border-base-content/20"
      }`}
      onClick={() => onSelect(welcome)}
    >
      <div className="card-body p-4">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="text-sm text-base-content/70 mb-2">
              {welcome.cipherSuite
                ? `CipherSuite: ${welcome.cipherSuite}`
                : "Welcome (kind 444)"}
            </div>
            <div className="text-xs text-base-content/60">
              Received: {new Date(welcome.timestamp * 1000).toLocaleString()}
            </div>
            {welcome.relays.length > 0 && (
              <div className="text-xs text-base-content/60 mt-1">
                Relays: {welcome.relays.slice(0, 2).join(", ")}
                {welcome.relays.length > 2 && ` +${welcome.relays.length - 2}`}
              </div>
            )}
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
// Component: WelcomeDetails
// ============================================================================

function WelcomeDetails({ welcome }: { welcome: WelcomeMessage }) {
  return (
    <div className="card bg-base-200">
      <div className="card-body">
        <h2 className="card-title">Welcome Details</h2>
        <div className="divider my-1"></div>
        <div className="space-y-2">
          <div>
            <span className="font-semibold">CipherSuite:</span>{" "}
            {welcome.cipherSuite ?? "Unknown"}
          </div>
          <div>
            <span className="font-semibold">Relays:</span>{" "}
            {welcome.relays.join(", ") || "None"}
          </div>
          {welcome.keyPackageEventId && (
            <div>
              <span className="font-semibold">KeyPackage Event ID:</span>{" "}
              <span className="font-mono text-sm">
                {welcome.keyPackageEventId.slice(0, 16)}...
              </span>
            </div>
          )}
          <div>
            <span className="font-semibold">Received:</span>{" "}
            {new Date(welcome.timestamp * 1000).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Component: ResultsDisplay
// ============================================================================

function ResultsDisplay({
  result,
  onReset,
}: {
  result: {
    groupId: string;
    groupName: string;
    epoch: number;
    memberCount: number;
  };
  onReset: () => void;
}) {
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
          <div className="font-bold">Successfully joined group!</div>
          <div className="text-sm">
            You are now a member of "{result.groupName}"
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body">
          <h2 className="card-title">Joined Group</h2>
          <div className="space-y-2">
            <div>
              <span className="font-semibold">Group Name:</span>{" "}
              {result.groupName}
            </div>
            <div>
              <span className="font-semibold">Group ID:</span>{" "}
              <span className="font-mono text-sm">
                {result.groupId.slice(0, 32)}...
              </span>
            </div>
            <div>
              <span className="font-semibold">Epoch:</span> {result.epoch}
            </div>
            <div>
              <span className="font-semibold">Members:</span>{" "}
              {result.memberCount}
            </div>
          </div>
        </div>
      </div>

      <div className="alert alert-info">
        <span>
          ℹ️ The group has been added to your local store. You can now send and
          receive messages in this group.
        </span>
      </div>

      <div className="flex justify-end">
        <button className="btn btn-outline" onClick={onReset}>
          Join Another Group
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default withSignIn(function JoinGroup() {
  const client = useObservable(marmotClient$);
  const account = accounts.active;

  // Subscribe to gift-wrapped events (kind 1059) for the current user
  const giftWraps =
    useObservableMemo(() => {
      if (!account) return of([]);

      const relays = relaySet([], extraRelays$.value);

      return pool
        .request(relays, {
          kinds: [1059], // NIP-59 gift wrap
          limit: 50,
        })
        .pipe(
          mapEventsToTimeline(),
          map((arr) => [...arr]),
        );
    }, [account]) ?? [];

  // Process gift wraps to extract Welcome messages
  const welcomeMessages =
    useObservableMemo(
      () =>
        from(
          (async () => {
            if (!account || !Array.isArray(giftWraps)) return [];

            const welcomes: WelcomeMessage[] = [];

            for (const giftWrap of giftWraps) {
              try {
                // Unwrap the gift wrap to get the inner rumor
                const rumor = await unlockGiftWrap(giftWrap, account.signer);

                // Check if it's a Welcome message (kind 444)
                if (rumor.kind === 444) {
                  // Option A (simple): only use Nostr tags for preview.
                  // We can also decode the Welcome to show ciphersuite, but we do NOT attempt
                  // to extract GroupInfo / MarmotGroupData until we actually join.
                  let cipherSuite: string | undefined;
                  try {
                    cipherSuite = getWelcome(rumor).cipherSuite;
                  } catch {
                    cipherSuite = undefined;
                  }

                  welcomes.push({
                    giftWrapEvent: giftWrap,
                    welcomeRumor: rumor,
                    relays: rumor.tags
                      .filter((t) => t[0] === "relays")
                      .flatMap((t) => t.slice(1)),
                    keyPackageEventId: rumor.tags.find(
                      (t) => t[0] === "e",
                    )?.[1],
                    cipherSuite,
                    timestamp: giftWrap.created_at,
                  });
                }
              } catch (err) {
                // Skip gift wraps that can't be unwrapped (not for us)
                console.debug("Failed to unwrap gift wrap:", err);
              }
            }

            // Sort by timestamp, newest first
            return welcomes.sort((a, b) => b.timestamp - a.timestamp);
          })(),
        ),
      [giftWraps, account],
    ) ?? [];

  const selectedWelcome = useObservable(
    selectedWelcome$,
  ) as WelcomeMessage | null;
  const isJoining = useObservable(isJoining$) as boolean;
  const error = useObservable(error$) as string | null;
  const result = useObservable(result$) as {
    groupId: string;
    groupName: string;
    epoch: number;
    memberCount: number;
  } | null;

  const handleWelcomeSelect = (welcome: WelcomeMessage) => {
    selectedWelcome$.next(welcome);
    error$.next(null);
  };

  const handleJoin = async () => {
    if (!selectedWelcome || !client) {
      return;
    }

    try {
      isJoining$.next(true);
      error$.next(null);
      result$.next(null);

      // Join the group from the Welcome message
      const group = await client.joinGroupFromWelcome({
        welcomeRumor: selectedWelcome.welcomeRumor,
        keyPackageEventId: selectedWelcome.keyPackageEventId,
      });

      const marmotData = extractMarmotGroupData(group.state);
      const groupName = marmotData?.name ?? "(unknown group name)";
      const groupId = bytesToHex(group.state.groupContext.groupId);

      result$.next({
        groupId,
        groupName,
        epoch: Number(group.state.groupContext.epoch),
        memberCount: getMemberCount(group.state),
      });
    } catch (err) {
      console.error("Error joining group:", err);
      error$.next(err instanceof Error ? err.message : String(err));
    } finally {
      isJoining$.next(false);
    }
  };

  const reset = () => {
    result$.next(null);
    error$.next(null);
    selectedWelcome$.next(null);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Join Group from Welcome</h1>
        <p className="text-base-content/70">
          Join a group by accepting a Welcome message received via NIP-59 gift
          wrap
        </p>
      </div>

      {/* Welcome Messages List */}
      {!result && (
        <>
          {welcomeMessages.length === 0 ? (
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
              <span>
                No Welcome messages found. Ask a group admin to invite you to a
                group.
              </span>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="card bg-base-100 border border-base-300">
                <div className="card-body">
                  <h2 className="card-title">Received Welcome Messages</h2>
                  <p className="text-base-content/70">
                    Select a Welcome message to view details and join the group
                  </p>
                </div>
              </div>

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {welcomeMessages.map((welcome, index) => (
                  <WelcomeListItem
                    key={`${welcome.giftWrapEvent.id}-${index}`}
                    welcome={welcome}
                    isSelected={
                      selectedWelcome?.giftWrapEvent.id ===
                      welcome.giftWrapEvent.id
                    }
                    onSelect={handleWelcomeSelect}
                  />
                ))}
              </div>

              {/* Selected Welcome Details */}
              {selectedWelcome && (
                <>
                  <WelcomeDetails welcome={selectedWelcome} />

                  {/* Join Button */}
                  <div className="card-actions justify-end">
                    <button
                      className="btn btn-primary btn-lg"
                      onClick={handleJoin}
                      disabled={isJoining}
                    >
                      {isJoining ? (
                        <>
                          <span className="loading loading-spinner"></span>
                          Joining...
                        </>
                      ) : (
                        "Join Group"
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Error Display */}
      <ErrorAlert error={error} />

      {/* Results Display */}
      {result && <ResultsDisplay result={result} onReset={reset} />}
    </div>
  );
});
