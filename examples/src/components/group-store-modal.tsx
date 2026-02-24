import { useRef, useState } from "react";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MarmotGroup } from "../../../src/client/group/marmot-group";

import { useObservable } from "../hooks/use-observable";
import { destroyGroup, groups$, groupSummaries$ } from "../lib/groups";
import ClientStateDataView from "./data-view/client-state";
import { extractMarmotGroupData, getMemberCount } from "../../../src/core";

interface StoredGroupDetailsProps {
  group: MarmotGroup;
  index: number;
}

function StoredGroupDetails({ group, index }: StoredGroupDetailsProps) {
  const clientState = group.state;
  // Extract metadata from the ClientState
  const marmotData = extractMarmotGroupData(clientState);
  const groupIdHex = bytesToHex(clientState.groupContext.groupId);
  const epoch = Number(clientState.groupContext.epoch);
  const memberCount = getMemberCount(clientState);
  const name = marmotData?.name || `Group #${index + 1}`;

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `Delete group "${name}"? This will remove it from local storage.`,
    );
    if (!confirmed) return;
    await destroyGroup(groupIdHex);
  };

  // Helper function to format MarmotGroupData values for display
  const formatMarmotDataValue = (value: any): string => {
    if (value instanceof Uint8Array) {
      return bytesToHex(value);
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Map) {
      return JSON.stringify(Object.fromEntries(value));
    }
    return JSON.stringify(value);
  };

  return (
    <details className="collapse bg-base-100 border-base-300 border">
      <summary className="collapse-title font-semibold">
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm">{name}</span>
          <span className="font-mono text-xs opacity-60 truncate ml-2">
            {groupIdHex.slice(0, 16)}...
          </span>
        </div>
      </summary>

      <div className="collapse-content text-sm space-y-4">
        {/* Group ID */}
        <div>
          <div className="font-semibold mb-1">Group ID</div>
          <code className="text-xs break-all select-all bg-base-200 p-2 rounded block">
            {groupIdHex}
          </code>
        </div>

        {/* Basic Info */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="font-semibold mb-1">Epoch</div>
            <div className="bg-base-200 p-2 rounded">{epoch}</div>
          </div>
          <div>
            <div className="font-semibold mb-1">Members</div>
            <div className="bg-base-200 p-2 rounded">{memberCount}</div>
          </div>
        </div>

        {/* Marmot Group Data */}
        {marmotData && (
          <div>
            <div className="font-semibold mb-2">Marmot Group Data</div>
            <div className="bg-base-200 p-4 rounded-lg space-y-2">
              {Object.entries(marmotData).map(([key, value]) => (
                <div key={key}>
                  <span className="font-semibold capitalize">{key}:</span>
                  <code className="text-xs ml-2 break-all">
                    {formatMarmotDataValue(value)}
                  </code>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Full Group Data */}
        <details className="collapse bg-base-200 border-base-300 border">
          <summary className="collapse-title font-semibold">
            Full Client State Data
          </summary>
          <div className="collapse-content">
            <div className="bg-base-300 p-4 rounded-lg overflow-auto max-h-96">
              <ClientStateDataView clientState={clientState} />
            </div>
          </div>
        </details>

        {/* Delete Button */}
        <div className="flex justify-end pt-2">
          <button
            className="btn btn-outline btn-error btn-sm"
            onClick={handleDelete}
          >
            Delete Group
          </button>
        </div>
      </div>
    </details>
  );
}

export default function GroupStoreModal() {
  const ref = useRef<HTMLDialogElement>(null);
  const groups = useObservable(groups$);
  const summaries = useObservable(groupSummaries$);
  const entries = groups ?? [];
  const summaryCount = summaries?.length ?? entries.length;
  const [clearing, setClearing] = useState(false);

  const handleClearAll = async () => {
    const confirmed = window.confirm(
      `Are you sure you want to clear all ${summaryCount} group${summaryCount !== 1 ? "s" : ""}? This action cannot be undone.`,
    );

    if (!confirmed) return;

    setClearing(true);
    try {
      await Promise.all(
        entries.map((g) =>
          destroyGroup(bytesToHex(g.state.groupContext.groupId)),
        ),
      );
    } catch (error) {
      console.error("Failed to clear groups:", error);
      alert("Failed to clear groups. Check console for details.");
    } finally {
      setClearing(false);
    }
  };

  return (
    <dialog id="group_store_modal" className="modal" ref={ref}>
      <div className="modal-box max-w-4xl">
        <form method="dialog">
          <button className="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">
            ✕
          </button>
        </form>

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Local Group Store</h3>
          {entries && entries.length > 0 && (
            <button
              className="btn btn-error btn-sm"
              onClick={handleClearAll}
              disabled={clearing}
            >
              {clearing ? (
                <>
                  <span className="loading loading-spinner loading-xs"></span>
                  Clearing...
                </>
              ) : (
                "Clear All"
              )}
            </button>
          )}
        </div>

        <p className="text-sm opacity-70 mb-4">
          These are the groups stored locally in your browser for the current
          account.
        </p>

        {/* Content */}
        <div className="space-y-3">
          {groups === undefined ? (
            <div className="flex justify-center p-8">
              <span className="loading loading-spinner loading-lg"></span>
            </div>
          ) : entries.length === 0 ? (
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
              <span>No groups stored locally.</span>
            </div>
          ) : (
            <>
              <div className="text-sm opacity-70 mb-2">
                {entries.length} group{entries.length !== 1 ? "s" : ""} stored
              </div>

              {entries.map((group, index) => (
                <StoredGroupDetails key={index} group={group} index={index} />
              ))}
            </>
          )}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
