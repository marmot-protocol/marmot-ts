/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";

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
 * A bounded ledger of {@link StateNotification}s derived from accepted
 * commits, keyed by the producing commit's hex digest — NOT by the delivery
 * state's confirmation tag as {@link DeliveredPayloadLedger} is. CONV-03
 * attributes notifications to the commit that produced them, so the commit
 * digest (rather than a branch/state tag) is the natural withdrawal key.
 *
 * Structural sibling of `DeliveredPayloadLedger`: entries are pruned below
 * the retained anchor so the ledger stays bounded to the rollback horizon,
 * and a rewind withdraws exactly the entries produced above the fork epoch
 * whose commit is not on the canonical branch.
 */
export class StateNotificationLedger {
  #entries: {
    digest: string;
    epoch: number;
    notifications: StateNotification[];
  }[] = [];

  /** Number of remembered commit-notification entries. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Remembers the notifications derived from a commit at `epoch`. A record
   * with an empty notification array is skipped so the ledger stays bounded.
   */
  record(
    digest: Uint8Array,
    epoch: number,
    notifications: StateNotification[],
  ): void {
    if (notifications.length === 0) return;
    this.#entries.push({ digest: bytesToHex(digest), epoch, notifications });
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
    const kept: {
      digest: string;
      epoch: number;
      notifications: StateNotification[];
    }[] = [];
    for (const entry of this.#entries) {
      if (entry.epoch > forkEpoch && !canonicalDigests.has(entry.digest)) {
        invalidated.push(...entry.notifications);
      } else {
        kept.push(entry);
      }
    }
    this.#entries = kept;
    return invalidated;
  }

  /**
   * Drops entries below `epoch`. A rewind can never reach below the retained
   * anchor, so notifications older than it can never be withdrawn and are
   * dead weight; pruning them keeps the ledger bounded to the rollback
   * horizon.
   */
  pruneBelow(epoch: number): void {
    this.#entries = this.#entries.filter((entry) => entry.epoch >= epoch);
  }
}
