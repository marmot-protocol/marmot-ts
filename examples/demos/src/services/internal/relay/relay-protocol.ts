import type { NostrEvent } from "applesauce-core/helpers/event";
import type { RelayLogEntry } from "./relay-inspector.js";
import type { RelaySubscription } from "./relay-inspector.js";

export type SyncMessage =
  | { type: "reset" }
  | { type: "subscription"; subscription: RelaySubscription; active: boolean }
  | { type: "hello"; from: string }
  | { type: "snapshot"; to: string; events: NostrEvent[] }
  | { type: "event"; event: NostrEvent }
  | { type: "log"; from: string; entry: Omit<RelayLogEntry, "id" | "tab"> };
