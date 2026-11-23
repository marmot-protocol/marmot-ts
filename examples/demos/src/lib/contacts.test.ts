import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { EventStore } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { Observer } from "@internet-privacy/marmot-ts/client";
import { ContactsService } from "./contacts.js";
import { DemoRelay } from "./demo-relay.js";
import { LIVE_RELAYS } from "./live-transport.js";
import type { DemoTransport } from "./transport.js";

afterEach(() => vi.unstubAllGlobals());

describe("shared contacts", () => {
  it("tracks other local tabs, identity switches, and departures without WebSockets", async () => {
    const websocket = vi.fn(() => {
      throw new Error("Local mode must not connect");
    });
    vi.stubGlobal("WebSocket", websocket);
    const channel = `contacts-${crypto.randomUUID()}`;
    const first = new DemoRelay({ channel });
    const second = new DemoRelay({ channel });
    const alice = PrivateKeyAccount.generateNew().pubkey;
    const bob = PrivateKeyAccount.generateNew().pubkey;
    const carol = PrivateKeyAccount.generateNew().pubkey;
    const store = new EventStore();
    const contacts = new ContactsService(alice, first, store);
    try {
      first.setIdentity(alice);
      second.setIdentity(bob);
      await expect
        .poll(() => contacts.contacts$.value.map((user) => user.pubkey))
        .toEqual([bob]);
      second.setIdentity(carol);
      await expect
        .poll(() => contacts.contacts$.value.map((user) => user.pubkey))
        .toEqual([carol]);
      second.setIdentity(alice);
      await expect.poll(() => contacts.contacts$.value).toEqual([]);
      second.setIdentity(bob);
      await expect.poll(() => contacts.contacts$.value.length).toBe(1);
      second.close();
      await expect.poll(() => contacts.contacts$.value).toEqual([]);
      expect(websocket).not.toHaveBeenCalled();
    } finally {
      contacts.close();
      first.close();
      second.close();
      store.dispose();
    }
  });

  it("uses account outboxes for live follows and reacts to updated lists", async () => {
    const account = PrivateKeyAccount.generateNew();
    const friend = PrivateKeyAccount.generateNew();
    const store = new EventStore();
    const subscriptions: {
      relays: string[];
      filters: Filter;
      observer: Partial<Observer<NostrEvent>>;
      closed: boolean;
    }[] = [];
    const transport: DemoTransport = {
      relays: LIVE_RELAYS,
      ready: Promise.resolve(),
      transport: "test",
      shared: false,
      tab: "",
      events: [],
      log: [],
      version: 0,
      onChange: () => () => {},
      close: () => {},
      network: () => ({
        publish: async () => ({}),
        request: async () => [],
        getUserInboxRelays: async () => [],
        subscription: (relays, filters) => ({
          subscribe: (observer) => {
            const entry = {
              relays,
              filters: filters as Filter,
              observer,
              closed: false,
            };
            subscriptions.push(entry);
            return {
              unsubscribe: () => {
                entry.closed = true;
              },
            };
          },
        }),
      }),
    };
    const contacts = new ContactsService(account.pubkey, transport, store);
    try {
      const outboxes = ["wss://outbox.test/"];
      const inbox = "wss://inbox.test/";
      const relayList = await account.signer.signEvent({
        kind: 10002,
        created_at: 1,
        content: "",
        tags: [
          ["r", outboxes[0], "write"],
          ["r", inbox, "read"],
        ],
      });
      subscriptions
        .find((entry) => entry.filters.kinds?.includes(10002))!
        .observer.next?.(relayList);
      await expect
        .poll(() =>
          subscriptions.some(
            (entry) =>
              !entry.closed &&
              entry.filters.kinds?.includes(3) &&
              entry.relays[0] === outboxes[0],
          ),
        )
        .toBe(true);
      expect(subscriptions.some((entry) => entry.relays.includes(inbox))).toBe(
        false,
      );
      const follows = await account.signer.signEvent({
        kind: 3,
        created_at: 2,
        content: "",
        tags: [["p", friend.pubkey]],
      });
      const followSub = subscriptions.find(
        (entry) =>
          !entry.closed &&
          entry.filters.kinds?.includes(3) &&
          entry.relays[0] === outboxes[0],
      )!;
      followSub.observer.next?.(follows);
      await expect
        .poll(() => contacts.contacts$.value.map((user) => user.pubkey))
        .toEqual([friend.pubkey]);
      expect(contacts.contacts$.value[0].store).toBe(store);
      followSub.observer.next?.(
        await account.signer.signEvent({
          kind: 3,
          created_at: 3,
          content: "",
          tags: [],
        }),
      );
      await expect.poll(() => contacts.contacts$.value).toEqual([]);
      contacts.close();
      expect(subscriptions.every((entry) => entry.closed)).toBe(true);
    } finally {
      contacts.close();
      store.dispose();
    }
  });
});
