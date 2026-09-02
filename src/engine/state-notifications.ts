/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { getAppDataDictionary, type ClientState } from "ts-mls";

import { bytesEqual } from "../core/components/bytes.js";
import { getGroupMemberPubkeys } from "../core/group-members.js";

/**
 * A group-state change derived from an accepted commit on the selected
 * branch (`convergence.md` "Applying the selected branch"). Every variant
 * carries `commitDigest` — the identity of the commit that produced it — so
 * a rewind that supersedes the commit can withdraw exactly the notifications
 * it derived (D-10, D-11). The notification SHAPE is implementation-defined;
 * `commit_digest` attribution is the conformance requirement.
 */
export type StateNotification =
  | {
      kind: "epochAdvanced";
      commitDigest: Uint8Array;
      from: number;
      to: number;
    }
  | {
      kind: "memberAdded";
      commitDigest: Uint8Array;
      pubkey: string;
    }
  | {
      kind: "memberRemoved";
      commitDigest: Uint8Array;
      pubkey: string;
      actor?: string;
    }
  | {
      kind: "componentChanged";
      commitDigest: Uint8Array;
      componentId: number;
    }
  | {
      kind: "selfRemoved";
      commitDigest: Uint8Array;
    }
  | {
      kind: "branchRecovered";
      commitDigest: Uint8Array;
      forkEpoch: number;
    };

/**
 * Derives the {@link StateNotification}s produced by a single accepted commit
 * (`convergence.md` "Applying the selected branch") — a pure before/after diff
 * between `parentState` and `resultingState`, every entry attributed to
 * `commitDigest`. Ported from MDK's `group_state_changes.rs` split: this
 * function performs no I/O and holds no ledger; it only diffs two states.
 *
 * Emits in a fixed order so two calls over the same commit produce a
 * byte-identical result (T-03-31): `epochAdvanced`, then `memberAdded` (sorted
 * ascending by pubkey), then `memberRemoved` (sorted ascending by pubkey, no
 * `actor` — the committer is not visible to this pure diff), then
 * `componentChanged` (sorted ascending by component id), then `selfRemoved`
 * when the resulting state is the `removedFromGroup` tombstone and the parent's
 * was not.
 */
export function deriveStateNotifications(args: {
  parentState: ClientState;
  resultingState: ClientState;
  commitDigest: Uint8Array;
}): StateNotification[] {
  const { parentState, resultingState, commitDigest } = args;
  const notifications: StateNotification[] = [];

  const fromEpoch = Number(parentState.groupContext.epoch);
  const toEpoch = Number(resultingState.groupContext.epoch);
  if (toEpoch !== fromEpoch) {
    notifications.push({
      kind: "epochAdvanced",
      commitDigest,
      from: fromEpoch,
      to: toEpoch,
    });
  }

  const beforeMembers = new Set(getGroupMemberPubkeys(parentState));
  const afterMembers = new Set(getGroupMemberPubkeys(resultingState));

  const added = [...afterMembers]
    .filter((pubkey) => !beforeMembers.has(pubkey))
    .sort();
  for (const pubkey of added)
    notifications.push({ kind: "memberAdded", commitDigest, pubkey });

  const removed = [...beforeMembers]
    .filter((pubkey) => !afterMembers.has(pubkey))
    .sort();
  for (const pubkey of removed)
    notifications.push({ kind: "memberRemoved", commitDigest, pubkey });

  const beforeDict = getAppDataDictionary(parentState.groupContext.extensions);
  const afterDict = getAppDataDictionary(
    resultingState.groupContext.extensions,
  );
  const allComponentIds = new Set<number>();
  for (const entry of beforeDict ?? []) allComponentIds.add(entry.componentId);
  for (const entry of afterDict ?? []) allComponentIds.add(entry.componentId);
  const changedComponentIds = [...allComponentIds]
    .filter((componentId) => {
      const before = beforeDict?.find(
        (c) => c.componentId === componentId,
      )?.data;
      const after = afterDict?.find((c) => c.componentId === componentId)?.data;
      return !bytesEqual(before, after);
    })
    .sort((a, b) => a - b);
  for (const componentId of changedComponentIds)
    notifications.push({ kind: "componentChanged", commitDigest, componentId });

  if (
    resultingState.groupActiveState.kind === "removedFromGroup" &&
    parentState.groupActiveState.kind !== "removedFromGroup"
  ) {
    notifications.push({ kind: "selfRemoved", commitDigest });
  }

  return notifications;
}

/**
 * Groups withdrawn {@link StateNotification}s by their producing commit's hex
 * digest, so a rewind site can emit exactly one {@link
 * StateInvalidatedIngestResult} per superseded commit (D-11) instead of one
 * per notification. Preserves each group's first-seen order; iteration order
 * of groups follows first appearance in `notifications`.
 */
export function groupWithdrawnNotificationsByCommit(
  notifications: readonly StateNotification[],
): { commitDigest: Uint8Array; withdrawn: StateNotification[] }[] {
  const order: string[] = [];
  const byDigest = new Map<
    string,
    { commitDigest: Uint8Array; withdrawn: StateNotification[] }
  >();
  for (const notification of notifications) {
    const key = bytesToHex(notification.commitDigest);
    let group = byDigest.get(key);
    if (!group) {
      group = { commitDigest: notification.commitDigest, withdrawn: [] };
      byDigest.set(key, group);
      order.push(key);
    }
    group.withdrawn.push(notification);
  }
  return order.map((key) => byDigest.get(key)!);
}

/**
 * A bounded ledger of {@link StateNotification}s derived from accepted
 * commits, keyed by the producing commit's hex digest — NOT by the delivery
 * state's confirmation tag as {@link DeliveredPayloadLedger} is. CONV-03
 * attributes notifications to the commit that produced them, so the commit
 * digest (rather than a branch/state tag) is the natural withdrawal key.
 *
 * Structural sibling of `DeliveredPayloadLedger`: entries are pruned only
 * below the oldest state still named by either retained history or the fork
 * tree. A finite, pruned tree can therefore bound this ledger; with an
 * unpruned full-history tree (including `maxRewindCommits: Infinity`) the
 * correctness horizon deliberately implies unbounded retention.
 */
export class StateNotificationLedger {
  #entries = new Map<
    string,
    {
      digest: string;
      epoch: number;
      notifications: StateNotification[];
    }
  >();

  static #key(digest: Uint8Array, epoch: number): string {
    return `${bytesToHex(digest)}:${epoch}`;
  }

  /** Number of remembered commit-notification entries. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Whether a commit's notifications are already recorded for `(digest,
   * epoch)`.
   *
   * WR-14: `invalidatedByRewind` KEEPS entries whose digest is on the winning
   * chain, so every prefix link that was already ledger-recorded when it was
   * first applied in-order survives a rewind. Callers use this to avoid
   * re-reporting those links to the application as freshly-applied.
   */
  has(digest: Uint8Array, epoch: number): boolean {
    return this.#entries.has(StateNotificationLedger.#key(digest, epoch));
  }

  /**
   * Remembers the notifications derived from a commit at `epoch`. Empty
   * derivations are retained: their digest identity is still needed to make a
   * later rewind complete and idempotent even though there is nothing to emit.
   *
   * Idempotent on `(digest, epoch)` (WR-14): a rewind whose winning chain
   * includes links that were already applied and recorded in-order would
   * otherwise push a second entry with the same digest and epoch. A later
   * rewind that superseded them then withdrew each of those notifications
   * TWICE, breaking CONV-03's "withdraw exactly the notifications it derived"
   * invariant from the other direction, and compounding the ledger's
   * unbounded growth.
   */
  record(
    digest: Uint8Array,
    epoch: number,
    notifications: StateNotification[],
  ): void {
    if (this.has(digest, epoch)) return;
    this.#entries.set(StateNotificationLedger.#key(digest, epoch), {
      digest: bytesToHex(digest),
      epoch,
      notifications,
    });
  }

  /**
   * Removes and returns the notifications withdrawn by a rewind to a
   * canonical branch: those derived strictly after `forkEpoch` whose
   * producing commit digest is not in `canonicalDigests`. Notifications
   * produced on the canonical branch, and any at or below the fork epoch
   * (shared history), are retained.
   */
  invalidatedByRewind(
    forkEpoch: number,
    canonicalDigests: ReadonlySet<string>,
  ): StateNotification[] {
    const invalidated: StateNotification[] = [];
    for (const [key, entry] of this.#entries) {
      if (entry.epoch > forkEpoch && !canonicalDigests.has(entry.digest)) {
        invalidated.push(...entry.notifications);
        this.#entries.delete(key);
      }
    }
    return invalidated;
  }

  /**
   * Drops entries below the caller's tree-aware correctness horizon. The
   * engine supplies `min(retained anchor, oldest tree-node epoch)` so no commit
   * still nameable by a fork candidate loses its withdrawal record.
   */
  pruneBelow(epoch: number): void {
    for (const [key, entry] of this.#entries)
      if (entry.epoch < epoch) this.#entries.delete(key);
  }
}
