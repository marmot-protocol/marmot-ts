import { expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  MarmotClient,
  Proposals,
  memoryDatabase,
  createApplicationMessageIntent,
  createChatRumor,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts/client";
import { DemoRelay } from "../services/internal/relay/demo-relay.js";
import { KeyPackagePublication } from "../services/internal/key-package-publication.js";

it("advances the clock epoch, notifies a banned receiver, and keeps other receivers ticking", async () => {
  await import("../services/internal/relay/demo-relay.worker.js");
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
  const relays = [new DemoRelay(), new DemoRelay(), new DemoRelay()];
  const sessions: KeyPackagePublication[] = [];
  const controller = new AbortController();
  try {
    for (const relay of relays) {
      const account = PrivateKeyAccount.generateNew();
      const client = new MarmotClient({
        signer: account.signer,
        database: memoryDatabase(),
        network: relay.network("you"),
        clientId: account.pubkey,
      });
      const session = new KeyPackagePublication(client, relay, account.pubkey);
      sessions.push(session);
      await session.start(true);
    }
    const [host, banned, remaining] = sessions;
    const group = await host.client.groups.create("Clock feed", {
      relays: relays[0].relays,
      adminPubkeys: [host.pubkey],
    });
    await host.client.groups.connect(group.id, { signal: controller.signal });
    const receivers: MarmotGroup[] = [];
    for (const receiver of [banned, remaining]) {
      const [keyPackage] = await host.client.network.request(relays[0].relays, {
        kinds: [30443],
        authors: [receiver.pubkey],
      });
      await host.client.groups.invite(group.id, keyPackage);
      await expect
        .poll(async () => (await receiver.client.invites.getUnread()).length)
        .toBe(1);
      const [invite] = await receiver.client.invites.getUnread();
      const { group: joined } = await receiver.client.joinGroupFromWelcome({
        welcomeRumor: invite,
      });
      await receiver.client.groups.connect(joined.id, {
        signal: controller.signal,
      });
      await joined.selfUpdate();
      receivers.push(joined);
      for (const current of [group, ...receivers]) {
        await expect
          .poll(() => current.snapshot.epoch)
          .toBe(joined.snapshot.epoch);
        await expect
          .poll(() => current.snapshot.convergenceStatus)
          .toBe("Settled");
      }
    }
    const [removedGroup, remainingGroup] = receivers;
    for (const current of [group, ...receivers]) {
      await expect.poll(() => current.snapshot.members.length).toBe(3);
    }

    async function tick(content: string) {
      await host.client.groups.send(
        group.id,
        createApplicationMessageIntent(
          createChatRumor({ pubkey: host.pubkey, content }),
        ),
      );
    }
    const before = "2026-11-23T12:00:00.000Z";
    await tick(before);
    for (const current of receivers) {
      await expect
        .poll(async () =>
          (await current.history.queryRumors({ kinds: [9] })).map(
            (message) => message.content,
          ),
        )
        .toEqual([before]);
    }

    const epoch = group.snapshot.epoch;
    const rejected = vi
      .spyOn(host.client.network, "publish")
      .mockImplementationOnce(async (urls) =>
        Object.fromEntries(
          urls.map((from) => [
            from,
            { from, ok: false, message: "Removal rejected" },
          ]),
        ),
      );
    await expect(
      host.client.groups.commit(group.id, {
        extraProposals: [Proposals.proposeRemoveUser(banned.pubkey)],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    rejected.mockRestore();
    expect(group.snapshot.epoch).toBe(epoch);
    expect(group.snapshot.members).toContain(banned.pubkey);
    expect(removedGroup.snapshot.status).toBe("active");

    const watcher = removedGroup.watch({ signal: controller.signal });
    expect((await watcher.next()).value?.status).toBe("active");
    const removedSnapshot = (async () => {
      for await (const snapshot of watcher)
        if (snapshot.status === "removed") return snapshot;
      throw new Error("Watcher ended without reporting removal");
    })();
    const responses = await host.client.groups.commit(group.id, {
      extraProposals: [Proposals.proposeRemoveUser(banned.pubkey)],
      signal: controller.signal,
    });
    expect(Object.values(responses).some((response) => response.ok)).toBe(true);
    expect(group.snapshot.epoch).toBeGreaterThan(epoch);
    expect(group.snapshot.members).not.toContain(banned.pubkey);
    await expect(removedSnapshot).resolves.toMatchObject({ status: "removed" });

    const after = "2026-11-23T12:00:01.000Z";
    await tick(after);
    await expect
      .poll(async () =>
        (await remainingGroup.history.queryRumors({ kinds: [9] }))
          .map((message) => message.content)
          .sort(),
      )
      .toEqual([before, after]);
    expect(
      (await removedGroup.history.queryRumors({ kinds: [9] })).map(
        (message) => message.content,
      ),
    ).toEqual([before]);
    await expect(removedGroup.selfUpdate()).rejects.toThrow();
  } finally {
    controller.abort();
    for (const session of sessions) {
      session.close();
      for (const group of session.client.groups.loaded) group.dispose();
    }
    for (const relay of relays) relay.close();
    for (const port of ports) port.close();
    Reflect.deleteProperty(globalThis, "onconnect");
    vi.unstubAllGlobals();
  }
}, 30_000);
