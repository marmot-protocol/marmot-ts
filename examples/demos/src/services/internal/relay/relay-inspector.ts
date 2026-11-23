import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

export type RelayLogEntry = {
  id: number;
  at: number;
  tab?: string;
  op: "publish" | "request" | "subscribe" | "unsubscribe";
  event?: NostrEvent;
  filters?: Filter[];
  results?: number;
};

export type RelaySubscription = {
  id: string;
  tab: string;
  filters: Filter[];
  at: number;
};

export type RelayState = {
  startedAt: number;
  at: number;
  connections: string[];
  events: NostrEvent[];
  log: RelayLogEntry[];
  subscriptions: RelaySubscription[];
};

export type InspectorRequest = { type: "inspect" } | { type: "reset" };
export type InspectorResponse = { type: "relay-state"; state: RelayState };
