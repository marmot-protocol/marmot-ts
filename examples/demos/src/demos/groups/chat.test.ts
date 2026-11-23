import { expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { DemoRelay } from "../../services/relay/demo-relay.js";
import { SessionClient } from "../../lib/session-client.js";

it("creates, invites, joins, and exchanges encrypted chat across tab transports", async () => {
  // Run the actual relay worker with separate MessagePorts, just like browser tabs.
  await import("../../services/relay/demo-relay.worker.js");
  const connect = (
    globalThis as unknown as {
      onconnect: (event: { ports: MessagePort[] }) => void;
    }
  ).onconnect;
  const ports: MessagePort[] = [];
  vi.stubGlobal(
    "SharedWorker",
    class {
      port: MessagePort;
      constructor() {
        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        connect({ ports: [channel.port1] });
        this.port = channel.port2;
      }
    },
  );
  const relays = [new DemoRelay(), new DemoRelay()];
  const sessions: SessionClient[] = [];
  const controller = new AbortController();
  try {
    for (const relay of relays) {
      const data = new Map<string, string>();
      const session = await SessionClient.create(
        PrivateKeyAccount.generateNew(),
        "local",
        relay,
        {
          getItem: (key) => data.get(key) ?? null,
          setItem: (key, value) => {
            data.set(key, value);
          },
        },
      );
      sessions.push(session);
      await session.start(true);
    }
    const [alice, bob] = sessions;
    const group = await alice.client.groups.create("Tab chat", {
      relays: relays[0].relays,
      adminPubkeys: [alice.pubkey],
    });
    await alice.client.groups.connect(group.id, { signal: controller.signal });
    await expect
      .poll(
        async () =>
          (
            await alice.client.network.request(relays[0].relays, {
              kinds: [30443],
              authors: [bob.pubkey],
            })
          ).length,
      )
      .toBe(1);
    const [keyPackage] = await alice.client.network.request(relays[0].relays, {
      kinds: [30443],
      authors: [bob.pubkey],
    });
    await alice.client.groups.invite(group.id, keyPackage);
    await expect
      .poll(async () => (await bob.client.invites.getUnread()).length)
      .toBe(1);
    const invites = bob.client.invites.watchUnread({
      signal: controller.signal,
    });
    const { value: unread } = await invites.next();
    await invites.return(undefined);
    const invite = unread![0];
    expect(invite.pubkey).toBe(alice.pubkey);

    const { group: joined } = await bob.client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await bob.client.groups.connect(joined.id, { signal: controller.signal });
    await joined.selfUpdate();
    await bob.client.invites.markAsRead(invite.id);
    expect(await bob.client.invites.getUnread()).toEqual([]);
    expect(joined.idStr).toBe(group.idStr);
    expect(joined.snapshot.members).toEqual(
      expect.arrayContaining([alice.pubkey, bob.pubkey]),
    );

    for (const [session, current, content] of [
      [alice, group, "Hello from tab A"],
      [bob, joined, "Hello from tab B"],
    ] as const) {
      await session.client.groups.send(
        current.id,
        createApplicationMessageIntent(
          createChatRumor({ pubkey: session.pubkey, content }),
        ),
      );
    }
    for (const current of [group, joined]) {
      await expect
        .poll(async () =>
          (await current.history.queryRumors({ kinds: [9] }))
            .map((message) => message.content)
            .sort(),
        )
        .toEqual(["Hello from tab A", "Hello from tab B"]);
    }
    expect(
      relays[0].events
        .filter((event) => event.kind === 445)
        .every((event) => !event.content.includes("Hello from tab")),
    ).toBe(true);
  } finally {
    controller.abort();
    for (const session of sessions) session.close();
    for (const relay of relays) relay.close();
    for (const port of ports) port.close();
    Reflect.deleteProperty(globalThis, "onconnect");
    vi.unstubAllGlobals();
  }
}, 20_000);
