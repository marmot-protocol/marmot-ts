import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { unlockGiftWrap } from "applesauce-common/helpers";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { createPeerActor } from "./actor.js";
import { DemoRelay, type SyncMessage } from "./demo-relay.js";

afterEach(() => vi.unstubAllGlobals());

describe("clock demo relay", () => {
  it("creates a clock member and delivers encrypted time messages to the user", async () => {
    const relay = new DemoRelay({ channel: false });
    const RELAYS = relay.relays;
    const user = createPeerActor("you", relay, "aa".repeat(32));
    const clock = createPeerActor("clock", relay, "bb".repeat(32));
    const controller = new AbortController();
    try {
      await clock.client.keyPackages.create({ relays: RELAYS });
      const [keyPackage] = await relay.network("you").request(RELAYS, {
        kinds: [30443],
        authors: [clock.pubkey],
      });
      const group = await user.client.groups.create("Clock group", {
        relays: RELAYS,
        adminPubkeys: [user.pubkey],
      });
      await user.client.groups.invite(group.id, keyPackage);
      const [welcome] = await relay.network("clock").request(RELAYS, {
        kinds: [1059],
        "#p": [clock.pubkey],
      });
      const { group: clockGroup } = await clock.client.joinGroupFromWelcome({
        welcomeRumor: await unlockGiftWrap(welcome, clock.client.signer),
      });
      await user.client.groups.connect(group.id, { signal: controller.signal });
      await clock.client.groups.connect(clockGroup.id, {
        signal: controller.signal,
      });
      await clockGroup.selfUpdate();
      const content = new Date().toISOString();
      await clock.client.groups.send(
        clockGroup.id,
        createApplicationMessageIntent(
          createChatRumor({ pubkey: clock.pubkey, content }),
        ),
      );
      await expect
        .poll(
          async () =>
            (await group.history.queryRumors({ kinds: [9] }))[0]?.content,
        )
        .toBe(content);
      expect(
        relay.events
          .filter((event) => event.kind === 445)
          .every((event) => !event.content.includes(content)),
      ).toBe(true);
    } finally {
      controller.abort();
      for (const actor of [user, clock])
        for (const group of actor.client.groups.loaded) group.dispose();
      relay.close();
    }
  });

  it("defaults to SharedWorker and closes its port on cleanup", async () => {
    const posted: unknown[] = [];
    const port = {
      onmessage: undefined as
        undefined | ((event: MessageEvent<SyncMessage>) => void),
      start: vi.fn(),
      close: vi.fn(),
      postMessage: vi.fn((message: SyncMessage) => {
        posted.push(message);
        if (message.type === "hello")
          queueMicrotask(() =>
            port.onmessage?.({
              data: {
                type: "snapshot",
                to: message.from,
                events: [],
              },
            } as unknown as MessageEvent<SyncMessage>),
          );
      }),
    };
    const worker = vi.fn(function () {
      return { port };
    });
    vi.stubGlobal("SharedWorker", worker);
    const relay = new DemoRelay();
    await relay.ready;
    expect(relay.transport).toBe("SharedWorker");
    expect(worker).toHaveBeenCalledOnce();
    expect(port.start).toHaveBeenCalledOnce();
    relay.close();
    expect(posted).toContainEqual({ type: "disconnect" });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("shares cached events and live traffic between worker ports", async () => {
    vi.resetModules();
    await import("./demo-relay.worker.js");
    const connect = (
      globalThis as unknown as {
        onconnect: (event: { ports: MessagePort[] }) => void;
      }
    ).onconnect;
    const first = new MessageChannel();
    const second = new MessageChannel();
    const receive = (port: MessagePort) =>
      new Promise<SyncMessage>((resolve) => {
        port.onmessage = (event) => resolve(event.data as SyncMessage);
      });
    try {
      connect({ ports: [first.port1] });
      connect({ ports: [second.port1] });
      const event = await PrivateKeyAccount.generateNew().signer.signEvent({
        kind: 1,
        created_at: 1,
        tags: [],
        content: "worker test",
      });
      const live = receive(second.port2);
      first.port2.postMessage({ type: "event", event });
      expect(await live).toEqual({
        type: "event",
        event: structuredClone(event),
      });
      const snapshot = receive(second.port2);
      second.port2.postMessage({ type: "hello", from: "new-tab" });
      expect(await snapshot).toEqual({
        type: "snapshot",
        to: "new-tab",
        events: [structuredClone(event)],
      });
    } finally {
      for (const port of [first.port1, first.port2, second.port1, second.port2])
        port.close();
      Reflect.deleteProperty(globalThis, "onconnect");
    }
  });
});
