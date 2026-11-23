import type { NostrEvent } from "applesauce-core/helpers/event";
import type { RelayLogEntry } from "./demo-relay.js";
import type { RelaySubscription } from "./relay-inspector.js";

export type TabIdentity = { from: string; pubkey: string; at: number };
export const PRESENCE_TTL_MS = 120_000;

export type SyncMessage =
  | { type: "reset" }
  | { type: "subscription"; subscription: RelaySubscription; active: boolean }
  | { type: "hello"; from: string }
  | { type: "snapshot"; to: string; events: NostrEvent[] }
  | { type: "event"; event: NostrEvent }
  | { type: "log"; from: string; entry: Omit<RelayLogEntry, "id" | "tab"> }
  | { type: "presence"; from: string; pubkey?: string; at: number }
  | { type: "peers"; peers: TabIdentity[] };
