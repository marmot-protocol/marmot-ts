import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import {
  KeyPackageManager,
  MissingSlotIdentifierError,
  type StoredKeyPackage,
} from "../key-package-manager.js";
import type { PublishResponse } from "../nostr-interface.js";

const SLOT = "ab".repeat(32);
const OTHER_SLOT = "cd".repeat(32);
const TARGET = "wss://relay.test/";
const OPTIONS = { identifier: SLOT, relays: [TARGET] };

function fixture(clientId: string | undefined = SLOT) {
  const network = new MockNetwork();
  const store = new InMemoryKeyValueStore<StoredKeyPackage>();
  const signer = PrivateKeyAccount.generateNew().signer;
  const manager = new KeyPackageManager({ store, signer, network, clientId });
  return { manager, network, store, signer };
}

describe("KeyPackage relay acknowledgements", () => {
  const failures: [string, Record<string, PublishResponse>][] = [
    [
      "rejection",
      { [TARGET]: { from: TARGET, ok: false, message: "blocked" } },
    ],
    ["empty response", {}],
    [
      "unrelated acceptance",
      { "wss://other.test/": { from: "wss://other.test/", ok: true } },
    ],
    [
      "uncertain outcome",
      { [TARGET]: { from: TARGET, ok: false, uncertain: true } },
    ],
  ];

  for (const [name, responses] of failures) {
    it(`does not record publication on ${name}`, async () => {
      const { manager, network } = fixture();
      vi.spyOn(network, "publish").mockResolvedValue(responses);
      await expect(manager.create(OPTIONS)).rejects.toMatchObject({
        name: "KeyPackagePublishError",
        responses,
        relays: [TARGET],
        event: { kind: 30443 },
      });
      const [entry] = await manager.list();
      expect(entry.published ?? []).toEqual([]);
      expect(await manager.getPrivateKey(entry.keyPackageRef)).not.toBeNull();
    });

    for (const operation of ["purge", "rotate"] as const) {
      it(`preserves the old bundle on ${operation} ${name}`, async () => {
        const { manager, network, store, signer } = fixture();
        const old = await manager.create(OPTIONS);
        const before = await manager.get(old.keyPackageRef);
        vi.spyOn(network, "publish").mockResolvedValue(responses);
        await expect(
          manager[operation](old.keyPackageRef),
        ).rejects.toMatchObject({
          name: "KeyPackagePublishError",
          responses,
        });
        const restarted = new KeyPackageManager({
          store,
          signer,
          network,
          clientId: SLOT,
        });
        expect(await restarted.get(old.keyPackageRef)).toEqual(before);
        expect(await restarted.getPrivateKey(old.keyPackageRef)).not.toBeNull();
      });
    }
  }

  it("accepts a requested relay even when another target rejects", async () => {
    const { manager, network } = fixture();
    vi.spyOn(network, "publish").mockResolvedValue({
      [TARGET]: { from: TARGET, ok: true },
      "wss://other.test/": { from: "wss://other.test/", ok: false },
    });
    const pkg = await manager.create({
      ...OPTIONS,
      relays: [TARGET, "wss://other.test/"],
    });
    expect((await manager.get(pkg.keyPackageRef))?.published).toHaveLength(1);
  });

  it("preserves the old bundle when replacement transport throws", async () => {
    const { manager, network } = fixture();
    const old = await manager.create(OPTIONS);
    const error = new Error("offline");
    vi.spyOn(network, "publish").mockRejectedValue(error);
    await expect(manager.rotate(old.keyPackageRef)).rejects.toBe(error);
    expect(await manager.getPrivateKey(old.keyPackageRef)).not.toBeNull();
  });

  it("can retry a rejected deletion without losing the old bundle", async () => {
    const { manager, network } = fixture();
    const old = await manager.create(OPTIONS);
    vi.spyOn(network, "publish").mockResolvedValueOnce({});
    await expect(manager.purge(old.keyPackageRef)).rejects.toThrow();
    await manager.purge(old.keyPackageRef);
    expect(await manager.get(old.keyPackageRef)).toBeNull();
  });
});

describe("ensurePublished slot isolation", () => {
  it.each([true, false])(
    "uses the requested slot (explicit: %s)",
    async (explicit) => {
      const { manager, network } = fixture();
      const other = await manager.create({
        ...OPTIONS,
        identifier: OTHER_SLOT,
      });
      const ensured = await manager.ensurePublished(
        explicit ? OPTIONS : { relays: [TARGET] },
      );
      expect(ensured.identifier).toBe(SLOT);
      expect(ensured.keyPackageRef).not.toEqual(other.keyPackageRef);
      expect(await manager.getPrivateKey(other.keyPackageRef)).not.toBeNull();
      const count = network.events.length;
      expect((await manager.ensurePublished(OPTIONS)).keyPackageRef).toEqual(
        ensured.keyPackageRef,
      );
      expect(network.events).toHaveLength(count);
    },
  );

  it("lets the explicit slot override the manager default", async () => {
    const { manager } = fixture();
    await manager.create(OPTIONS);
    expect(
      (await manager.ensurePublished({ ...OPTIONS, identifier: OTHER_SLOT }))
        .identifier,
    ).toBe(OTHER_SLOT);
  });

  it("does not infer a missing device identity from another stored slot", async () => {
    const { manager, store, signer, network } = fixture();
    await manager.create(OPTIONS);
    const unconfigured = new KeyPackageManager({
      store,
      signer,
      network,
    });
    await expect(
      unconfigured.ensurePublished({ relays: [TARGET] }),
    ).rejects.toBeInstanceOf(MissingSlotIdentifierError);
  });
});
