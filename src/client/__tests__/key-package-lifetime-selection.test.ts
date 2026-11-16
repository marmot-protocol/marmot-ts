import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lifetime } from "ts-mls";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import {
  KeyPackageManager,
  type StoredKeyPackage,
} from "../key-package-manager.js";

const SLOT = "ab".repeat(32);
const OPTIONS = { identifier: SLOT, relays: ["wss://relay.test/"] };
const NOW = 1_800_000_000n;

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(NOW) * 1000);
  const network = new MockNetwork();
  const store = new InMemoryKeyValueStore<StoredKeyPackage>();
  const manager = new KeyPackageManager({
    store,
    signer: PrivateKeyAccount.generateNew().signer,
    network,
    clientId: SLOT,
  });
  const original = await manager.create(OPTIONS);
  return { manager, network, store, original };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ensurePublished lifetime selection", () => {
  it("replaces a real expired package in the same slot without deleting its bundle", async () => {
    const { manager, network, original } = await fixture();
    const before = await manager.get(original.keyPackageRef);
    vi.setSystemTime(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const replacement = await manager.ensurePublished(OPTIONS);
    expect(replacement.identifier).toBe(SLOT);
    expect(replacement.keyPackageRef).not.toEqual(original.keyPackageRef);
    expect(network.events.filter((event) => event.kind === 30443)).toHaveLength(
      2,
    );
    expect(await manager.get(original.keyPackageRef)).toEqual(before);
    expect((await manager.ensurePublished(OPTIONS)).keyPackageRef).toEqual(
      replacement.keyPackageRef,
    );
    expect(network.events.filter((event) => event.kind === 30443)).toHaveLength(
      2,
    );
  });

  const cases: [string, Lifetime | undefined, boolean][] = [
    ["notBefore boundary", { notBefore: NOW, notAfter: NOW + 100n }, true],
    ["notAfter boundary", { notBefore: NOW - 100n, notAfter: NOW }, true],
    [
      "one second before validity",
      { notBefore: NOW + 1n, notAfter: NOW + 100n },
      false,
    ],
    [
      "one second after expiry",
      { notBefore: NOW - 100n, notAfter: NOW - 1n },
      false,
    ],
    ["reversed range", { notBefore: NOW + 1n, notAfter: NOW - 1n }, false],
    ["maximum range", { notBefore: NOW, notAfter: NOW + 7_261_200n }, true],
    ["oversized range", { notBefore: NOW, notAfter: NOW + 7_261_201n }, false],
    ["missing lifetime", undefined, false],
  ];

  it.each(cases)("handles %s", async (_name, lifetime, eligible) => {
    const { manager, network, original } = await fixture();
    const [candidate] = await manager.list();
    // Isolate the selection predicate from wire decoding and signature checks.
    const selected = {
      ...candidate,
      publicPackage: {
        ...candidate.publicPackage,
        leafNode: {
          ...candidate.publicPackage.leafNode,
          lifetime: lifetime ?? candidate.publicPackage.leafNode.lifetime,
        },
      },
    };
    // Exercise malformed runtime data without claiming it is a valid wire leaf.
    if (!lifetime)
      Reflect.deleteProperty(selected.publicPackage.leafNode, "lifetime");
    vi.spyOn(manager, "list").mockResolvedValue([selected]);
    const result = await manager.ensurePublished(OPTIONS);
    if (eligible) expect(result.keyPackageRef).toEqual(original.keyPackageRef);
    else expect(result.keyPackageRef).not.toEqual(original.keyPackageRef);
    expect(network.events.filter((event) => event.kind === 30443)).toHaveLength(
      eligible ? 1 : 2,
    );
  });

  it("selects a valid candidate after an expired one without publication", async () => {
    const { manager, network, original } = await fixture();
    vi.setSystemTime(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const current = await manager.create(OPTIONS);
    expect((await manager.list())[0].keyPackageRef).toEqual(
      original.keyPackageRef,
    );
    const result = await manager.ensurePublished(OPTIONS);
    expect(result.keyPackageRef).toEqual(current.keyPackageRef);
    expect(network.events.filter((event) => event.kind === 30443)).toHaveLength(
      2,
    );
  });

  it("does not confuse a publication older than 30 days with an expired lifetime", async () => {
    const { manager, network, original } = await fixture();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect((await manager.ensurePublished(OPTIONS)).keyPackageRef).toEqual(
      original.keyPackageRef,
    );
    expect(network.events.filter((event) => event.kind === 30443)).toHaveLength(
      1,
    );
  });

  it("surfaces replacement rejection and preserves the old private material", async () => {
    const { manager, network, original } = await fixture();
    const before = await manager.get(original.keyPackageRef);
    vi.setSystemTime(Date.now() + 90 * 24 * 60 * 60 * 1000);
    vi.spyOn(network, "publish").mockResolvedValue({});
    await expect(manager.ensurePublished(OPTIONS)).rejects.toMatchObject({
      name: "KeyPackagePublishError",
    });
    expect(await manager.get(original.keyPackageRef)).toEqual(before);
    expect(await manager.getPrivateKey(original.keyPackageRef)).not.toBeNull();
  });
});
