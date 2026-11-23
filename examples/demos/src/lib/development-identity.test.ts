import { expect, it } from "vitest";
import { EventStore } from "applesauce-core";
import { castUser } from "applesauce-common/casts";
import { DemoRelay } from "./demo-relay.js";
import {
  createDevelopmentAccount,
  getDevelopmentName,
  publishDevelopmentProfile,
} from "./development-identity.js";

it("publishes a named signed development profile to the local relay", async () => {
  const account = createDevelopmentAccount();
  const relay = new DemoRelay({ channel: false });
  const store = new EventStore();
  try {
    await publishDevelopmentProfile(
      account,
      relay,
      new AbortController().signal,
    );
    const [profile] = await relay.network("test").request(relay.relays, {
      kinds: [0],
      authors: [account.pubkey],
    });
    expect(profile.pubkey).toBe(account.pubkey);
    expect(JSON.parse(profile.content).name).toBe(getDevelopmentName(account));
    store.add(profile);
    expect(
      await castUser(account.pubkey, store).profile$.displayName.$first(1000),
    ).toBe(getDevelopmentName(account));
  } finally {
    relay.close();
    store.dispose();
  }
});

it("does not publish after a local session is disposed", async () => {
  const account = createDevelopmentAccount();
  const relay = new DemoRelay({ channel: false });
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(
      publishDevelopmentProfile(account, relay, controller.signal),
    ).rejects.toThrow();
    expect(relay.events).toEqual([]);
  } finally {
    relay.close();
  }
});
