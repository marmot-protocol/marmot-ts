import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { expect, it, vi } from "vitest";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { MarmotClient } from "../marmot-client.js";
import { MarmotGroup } from "../group/marmot-group.js";

function fixture() {
  const database = memoryDatabase();
  const network = new MockNetwork();
  const signer = PrivateKeyAccount.generateNew().signer;
  const client = new MarmotClient({ database, network, signer });
  return { client, database, network, signer };
}

it("disposes loaded groups once, preserving caller-owned storage and transport", async () => {
  const { client, database, network, signer } = fixture();
  const group = await client.groups.create("Disposal", {
    relays: network.relayUrls,
  });
  const dispose = vi.spyOn(group, "dispose");
  const close = vi.spyOn(database.account, "close");
  client.dispose();
  client.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(group.closedSignal.aborted).toBe(true);
  expect(client.groups.loaded).toEqual([]);
  expect(client.groups.snapshot).toEqual([]);
  expect(close).not.toHaveBeenCalled();
  expect(await database.account.groups.get(group.idStr)).toBeDefined();
  const replacement = new MarmotClient({ database, network, signer });
  try {
    const restored = await replacement.groups.get(group.id);
    expect(restored.closedSignal.aborted).toBe(false);
    expect(restored.id).toEqual(group.id);
  } finally {
    replacement.dispose();
  }
});

it("disconnects direct and automatic group subscriptions and tracking listeners", async () => {
  const { client, network } = fixture();
  const group = await client.groups.create("Connections", {
    relays: network.relayUrls,
  });
  const unsubscribe = vi.fn();
  vi.spyOn(network, "subscription").mockReturnValue({
    subscribe: () => ({ unsubscribe }),
  });
  await client.groups.connect(group.id);
  const all = client.groups.connectAll();
  await vi.waitFor(() => expect(network.subscription).toHaveBeenCalledTimes(2));
  client.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(client.groups.listenerCount("created")).toBe(0);
  expect(client.groups.listenerCount("loaded")).toBe(0);
  all.unsubscribe();
  client.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(() => client.groups.connectAll()).toThrow("Groups manager disposed");
  await expect(client.groups.get(group.id)).rejects.toThrow(
    "Groups manager disposed",
  );
});

it.each(["load", "activation"] as const)(
  "rejects and disposes an in-flight group %s without repopulating the client",
  async (phase) => {
    const { client, database, network, signer } = fixture();
    const group = await client.groups.create("Pending load");
    client.dispose();
    const replacement = new MarmotClient({ database, network, signer });
    const build = MarmotGroup.fromClientState;
    let resume!: () => void;
    let hydrated: MarmotGroup | undefined;
    const paused = vi.fn();
    const pending = new Promise<void>((resolve) => (resume = resolve));
    const building = vi
      .spyOn(MarmotGroup, "fromClientState")
      .mockImplementation(async (...args) => {
        hydrated = await build(...args);
        if (phase === "load") {
          paused();
          await pending;
        } else {
          const hydrate = hydrated.session.hydrateLifecycleEvidence.bind(
            hydrated.session,
          );
          vi.spyOn(
            hydrated.session,
            "hydrateLifecycleEvidence",
          ).mockImplementation(async () => {
            await hydrate();
            paused();
            await pending;
          });
        }
        return hydrated;
      });
    const loaded = replacement.groups.get(group.id);
    const rejected = expect(loaded).rejects.toThrow("Groups manager disposed");
    try {
      await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce());
      replacement.dispose();
      resume();
      await rejected;
      expect(hydrated!.closedSignal.aborted).toBe(true);
      expect(replacement.groups.loaded).toEqual([]);
    } finally {
      resume();
      replacement.dispose();
      building.mockRestore();
    }
  },
);
