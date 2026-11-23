import { describe, expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";
import { DemoRelay } from "./demo-relay.js";
import { SessionClient } from "./session-client.js";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

describe("session key packages and clock invitations", () => {
  it("makes publication optional for existing identities", async () => {
    const relay = new DemoRelay({ channel: false });
    const session = await SessionClient.create(
      PrivateKeyAccount.generateNew(),
      "local",
      relay,
      memoryStorage(),
    );
    try {
      await session.start(false);
      expect(session.state$.value.enabled).toBe(false);
      expect(relay.events).toEqual([]);
      await session.publish();
      expect(session.state$.value.current).toBeDefined();
      expect(relay.events.some((event) => event.kind === 30443)).toBe(true);
    } finally {
      session.close();
      relay.close();
    }
  });

  it("accepts a pending invite after rotation and reload, then receives the host's clock feed", async () => {
    const relay = new DemoRelay({ channel: false });
    const hostAccount = PrivateKeyAccount.generateNew();
    const receiverAccount = PrivateKeyAccount.generateNew();
    const storage = memoryStorage();
    const host = await SessionClient.create(
      hostAccount,
      "local",
      relay,
      storage,
    );
    let receiver = await SessionClient.create(
      receiverAccount,
      "local",
      relay,
      storage,
    );
    try {
      await host.start(false);
      await receiver.start(true);
      const old = receiver.state$.value.current!;
      const slot = receiver.clientId;
      const group = await host.client.groups.create("Clock feed", {
        relays: relay.relays,
        adminPubkeys: [hostAccount.pubkey],
      });
      await host.client.groups.connect(group.id, { signal: host.signal });
      await host.client.groups.invite(group.id, old.published![0]);
      await expect
        .poll(async () => (await receiver.client.invites.getUnread()).length)
        .toBe(1);
      await receiver.rotate();
      const replacement = receiver.state$.value.current!;
      expect(replacement.keyPackageRef).not.toEqual(old.keyPackageRef);
      expect(replacement.identifier).toBe(slot);
      expect(
        await receiver.client.keyPackages.getPrivateKey(old.keyPackageRef),
      ).toBeTruthy();

      receiver.close();
      receiver = await SessionClient.create(
        receiverAccount,
        "local",
        relay,
        storage,
      );
      await receiver.start(false);
      expect(receiver.clientId).toBe(slot);
      expect(receiver.state$.value.current!.keyPackageRef).toEqual(
        replacement.keyPackageRef,
      );
      await expect
        .poll(async () => (await receiver.client.invites.getUnread()).length)
        .toBe(1);
      const [invite] = await receiver.client.invites.getUnread();
      const { group: receivingGroup } =
        await receiver.client.joinGroupFromWelcome({ welcomeRumor: invite });
      await receiver.client.groups.connect(receivingGroup.id, {
        signal: receiver.signal,
      });
      await receivingGroup.selfUpdate();
      await receiver.client.invites.markAsRead(invite.id);
      expect(await receiver.client.invites.getUnread()).toEqual([]);

      const ticks = [
        "2026-11-23T12:00:00.000Z",
        "2026-11-23T12:00:01.000Z",
        "2026-11-23T12:00:02.000Z",
      ];
      for (const content of ticks) {
        await host.client.groups.send(
          group.id,
          createApplicationMessageIntent(
            createChatRumor({ pubkey: hostAccount.pubkey, content }),
          ),
        );
      }
      await expect
        .poll(async () =>
          (await receivingGroup.history.queryRumors({ kinds: [9] }))
            .map((rumor) => rumor.content)
            .sort(),
        )
        .toEqual(ticks);
      expect(
        relay.events
          .filter((event) => event.kind === 445)
          .every((event) => !event.content.includes(ticks[0])),
      ).toBe(true);
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 86_402_000);
      try {
        await receiver.publish();
        expect(
          await receiver.client.keyPackages.getPrivateKey(old.keyPackageRef),
        ).toBeNull();
        expect(
          await receiver.client.keyPackages.getPrivateKey(
            replacement.keyPackageRef,
          ),
        ).toBeTruthy();
      } finally {
        clock.mockRestore();
      }
    } finally {
      receiver.close();
      host.close();
      relay.close();
    }
  });
});
