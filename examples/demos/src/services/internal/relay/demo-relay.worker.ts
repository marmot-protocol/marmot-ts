import { EventStore } from "applesauce-core";
import type { SyncMessage } from "./relay-protocol.js";
import type {
  InspectorRequest,
  InspectorResponse,
  RelaySubscription,
  RelayLogEntry,
} from "./relay-inspector.js";

// One event store per named worker, shared by every connected demo tab.
let events = new EventStore();
const ports = new Set<MessagePort>();
const connections = new Map<MessagePort, string>();
const inspectors = new Set<MessagePort>();
const subscriptions = new Map<MessagePort, Map<string, RelaySubscription>>();
const log: RelayLogEntry[] = [];
const startedAt = Date.now();
let nextId = 1;
const inspect = (port: MessagePort) =>
  port.postMessage({
    type: "relay-state",
    state: {
      startedAt,
      at: Date.now(),
      connections: [...connections.values()],
      events: [...events.getByFilters({})],
      log,
      subscriptions: [...subscriptions.values()].flatMap((subs) => [
        ...subs.values(),
      ]),
    },
  } satisfies InspectorResponse);
const updateInspectors = () => {
  for (const port of inspectors) inspect(port);
};
const scope = globalThis as unknown as {
  onconnect: (event: MessageEvent) => void;
};

scope.onconnect = ({ ports: [port] }) => {
  ports.add(port);
  port.onmessage = ({
    data,
  }: MessageEvent<SyncMessage | InspectorRequest | { type: "disconnect" }>) => {
    if (data.type === "inspect") {
      inspectors.add(port);
      inspect(port);
      return;
    }
    if (data.type === "reset") {
      // Keep connections/subscriptions alive; discard only relay data.
      events.dispose();
      events = new EventStore();
      log.length = 0;
      for (const peer of ports)
        peer.postMessage({ type: "reset" } satisfies SyncMessage);
      updateInspectors();
      return;
    }
    if (data.type === "disconnect") {
      ports.delete(port);
      connections.delete(port);
      subscriptions.delete(port);
      inspectors.delete(port);
      updateInspectors();
      port.close();
      return;
    }
    if (data.type === "hello") {
      connections.set(port, data.from);
      port.postMessage({
        type: "snapshot",
        to: data.from,
        events: [...events.getByFilters({})],
      } satisfies SyncMessage);
      updateInspectors();
      return;
    }
    if (data.type === "subscription") {
      let subs = subscriptions.get(port);
      if (!subs) subscriptions.set(port, (subs = new Map()));
      if (data.active) subs.set(data.subscription.id, data.subscription);
      else subs.delete(data.subscription.id);
      updateInspectors();
      return;
    }
    if (data.type === "log")
      log.push({ ...data.entry, tab: data.from, id: nextId++ });
    if (data.type === "event") {
      if (events.hasEvent(data.event.id)) return;
      if (!events.add(data.event)) return;
    }
    for (const peer of ports) {
      if (peer !== port) peer.postMessage(data);
    }
    updateInspectors();
  };
  port.start();
};
