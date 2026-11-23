import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { RelayLogEntry } from "../services/relay/demo-relay.js";

export type TransportMode = "local" | "live";

export interface DemoTransport {
  readonly relays: string[];
  readonly ready: Promise<void>;
  readonly transport: string;
  readonly shared: boolean;
  readonly tab: string;
  readonly events: NostrEvent[];
  readonly log: RelayLogEntry[];
  readonly version: number;
  network(actor: string): NostrNetworkInterface;
  onChange(listener: () => void): () => void;
  close(): void;
}
