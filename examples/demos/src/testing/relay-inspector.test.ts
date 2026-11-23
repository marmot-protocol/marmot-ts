import { afterEach, expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type {
  InspectorResponse,
  RelaySubscription,
} from "../services/internal/relay/relay-inspector.js";
import type { SyncMessage } from "../services/internal/relay/relay-protocol.js";
import { DemoRelay } from "../services/internal/relay/demo-relay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "onconnect");
});

it("inspects historical traffic, events, subscriptions and resets every connected tab", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  await import("../services/internal/relay/demo-relay.worker.js");
  const connect = (
    globalThis as unknown as {
      onconnect: (event: { ports: MessagePort[] }) => void;
    }
  ).onconnect;
  const makePort = () => {
    const messages: unknown[] = [];
    const port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (data: unknown) => messages.push(structuredClone(data)),
      start: vi.fn(),
      close: vi.fn(),
    };
    connect({ ports: [port as unknown as MessagePort] });
    return {
      messages,
      send: (data: unknown) => port.onmessage!({ data }),
    };
  };
  const demo = makePort();
  demo.send({ type: "hello", from: "tab-a" });
  const event = await PrivateKeyAccount.generateNew().signer.signEvent({
    kind: 1,
    created_at: 1,
    tags: [],
    content: "inspect me",
  });
  demo.send({ type: "event", event });
  demo.send({
    type: "log",
    from: "tab-a",
    entry: {
      actor: "you",
      op: "publish",
      at: 1,
      event,
    },
  });
  const subscription: RelaySubscription = {
    id: "sub-a",
    tab: "tab-a",
    actor: "you",
    filters: [{ kinds: [1] }],
    at: 2,
  };
  demo.send({ type: "subscription", subscription, active: true });
  // A late inspector gets a complete snapshot, not just future traffic.
  const inspector = makePort();
  const snapshot = () => (inspector.messages.at(-1) as InspectorResponse).state;
  inspector.send({ type: "inspect" });
  expect(snapshot().connections).toEqual(["tab-a"]);
  expect(snapshot().events).toEqual([structuredClone(event)]);
  expect(snapshot().log).toMatchObject([
    { actor: "you", tab: "tab-a", op: "publish" },
  ]);
  expect(snapshot().subscriptions).toEqual([subscription]);
  demo.send({ type: "subscription", subscription, active: false });
  expect(snapshot().subscriptions).toEqual([]);
  demo.send({ type: "subscription", subscription, active: true });
  inspector.send({ type: "reset" });
  expect(snapshot().events).toEqual([]);
  expect(snapshot().log).toEqual([]);
  expect(snapshot().subscriptions).toEqual([subscription]);
  expect(demo.messages).toContainEqual({ type: "reset" });
  // No stale event is served to a newly connected demo after resetting.
  const late = makePort();
  late.send({ type: "hello", from: "late" });
  expect(late.messages).toContainEqual({
    type: "snapshot",
    to: "late",
    events: [],
  });
  demo.send({ type: "disconnect" });
  expect(snapshot().connections).toEqual(["late"]);
  expect(snapshot().subscriptions).toEqual([]);
  // Clearing also clears deduplication, so the same event can be stored again.
  late.send({ type: "event", event });
  expect(snapshot().events).toEqual([structuredClone(event)]);
});

it("clears demo caches and held publishes without dropping active observers", async () => {
  const ports: {
    onmessage?: (message: { data: SyncMessage }) => void;
    postMessage: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "SharedWorker",
    vi.fn(function () {
      const port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() };
      ports.push(port);
      return { port };
    }),
  );
  const relay = new DemoRelay();
  const port = ports[0];
  const event = await PrivateKeyAccount.generateNew().signer.signEvent({
    kind: 1,
    created_at: 1,
    tags: [],
    content: "reset me",
  });
  const next = vi.fn();
  const network = relay.network("test");
  const subscription = network
    .subscription(relay.relays, {})
    .subscribe({ next });
  try {
    await network.publish(relay.relays, event);
    relay.paused = true;
    await network.publish(relay.relays, event);
    expect(relay.queue).toHaveLength(1);
    port.onmessage!({ data: { type: "reset" } });
    expect(relay.events).toEqual([]);
    expect(relay.log).toEqual([]);
    expect(relay.queue).toEqual([]);
    relay.paused = false;
    await network.publish(relay.relays, event);
    expect(next).toHaveBeenCalledTimes(2);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscription",
        active: true,
      }),
    );
  } finally {
    subscription.unsubscribe();
    relay.close();
  }
});
