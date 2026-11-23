import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { RelayLogEntry } from "./demo-relay.js";
import type { TabIdentity } from "./relay-protocol.js";

export type RelaySubscription = {
  id: string;
  tab: string;
  actor: string;
  filters: Filter[];
  at: number;
};

export type RelayState = {
  startedAt: number;
  at: number;
  connections: string[];
  peers: TabIdentity[];
  events: NostrEvent[];
  log: RelayLogEntry[];
  subscriptions: RelaySubscription[];
};

export type InspectorRequest = { type: "inspect" } | { type: "reset" };
export type InspectorResponse = { type: "relay-state"; state: RelayState };
