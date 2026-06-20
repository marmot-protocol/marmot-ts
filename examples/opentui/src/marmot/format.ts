import { npubEncode } from "applesauce-core/helpers/pointers";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

/** A short, recognizable npub label (not copy-paste complete) for the UI. */
export function npubShort(pubkeyHex: string): string {
  return `${npubEncode(pubkeyHex).slice(0, 12)}…`;
}

export function hexShort(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex").slice(0, 8);
}

export function short(value: string): string {
  return value.slice(0, 8);
}

/** Compact "Ns/m/h/d ago" label for a unix-seconds timestamp. */
export function relativeTime(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function groupName(group: MarmotGroup): string {
  return group.groupData?.name || short(group.idStr);
}

export function groupIsAdmin(group: MarmotGroup, pubkey: string): boolean {
  return group.groupData?.adminPubkeys.includes(pubkey) ?? false;
}

export function groupEpoch(group: MarmotGroup): number {
  return Number(group.state.groupContext.epoch);
}

/** Active members are the populated leaf nodes (nodeType 1) of the tree. */
export function groupMemberCount(group: MarmotGroup): number {
  return group.state.ratchetTree.filter((n) => n?.nodeType === 1).length;
}
