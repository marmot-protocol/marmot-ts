import { bytesToHex } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  finalizeEvent,
  generateSecretKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KeyPackageManager,
  MissingRelayError,
  MissingSlotIdentifierError,
  StoredKeyPackage,
} from "../key-package-manager.js";
import {
  getKeyPackageIdentifier,
  getKeyPackageRelays,
} from "../../core/key-package-event.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { KeyPackageStore } from "../storage/key-package-store.js";
import { MarmotClient } from "../marmot-client.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import type {
  KeyPackageRow,
  MarmotAccountDatabase,
} from "../storage/database/types.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { createCredential } from "../../core/credential.js";
import { createDefaultKeyPackageLifetime } from "../../utils/timestamp.js";
import {
  bytesToBase64,
  defaultCapabilities,
  defaultCryptoProvider,
  encode,
  generateKeyPackage as mlsGenerateKeyPackage,
  getCiphersuiteImpl,
  makeCustomExtension,
  mlsMessageEncoder,
  keyPackageEncoder,
  privateKeyPackageEncoder,
  wireformats,
  type CiphersuiteImpl,
} from "ts-mls";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CLIENT_ID = "ab".repeat(32);

/** The stored key package records of `storage`, for inspection and injection. */
function keyPackageRecords(storage: MarmotAccountDatabase) {
  const store = new KeyPackageStore(storage);
  return {
    get: (ref: string) => store.get(ref),
    set: async (ref: string, entry: StoredKeyPackage) => {
      const row: KeyPackageRow = {
        ref,
        publicPackage: encode(keyPackageEncoder, entry.publicPackage),
        ...(entry.privatePackage
          ? {
              privatePackage: encode(
                privateKeyPackageEncoder,
                entry.privatePackage,
              ),
            }
          : {}),
        identifier: entry.identifier,
        notBefore: Number(
          entry.publicPackage.leafNode.lifetime?.notBefore ?? 0n,
        ),
        used: entry.used === true,
        published: entry.published ?? [],
        relays: entry.publicationRelays,
        consumptionReceipts: (entry.consumptionReceipts ?? []).map(
          (receipt) => ({
            groupId: bytesToHex(receipt.groupId),
            keyPackageRef: bytesToHex(receipt.keyPackageRef),
            ...(receipt.adoptionTag !== undefined
              ? { adoptionTag: receipt.adoptionTag }
              : {}),
          }),
        ),
      };
      await storage.transaction((tx) => tx.keyPackages.put(row));
    },
  };
}

describe("publication slots and durable routes", () => {
  it("retains explicit observation routes across duplicate tracking and restart", async () => {
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const source = new KeyPackageManager({
      database: memoryDatabase().account,
      signer,
      network,
      clientId: "ab".repeat(32),
    });
    const pkg = await source.create({ relays: ["wss://source.test"] });
    const event = network.events[0];
    const storage = memoryDatabase().account;
    const options = { database: storage, signer, network };
    const observer = new KeyPackageManager(options);
    expect(await observer.track(event, ["wss://one.test"])).toBe(true);
    expect(
      await observer.track(event, [
        "wss://one.test/",
        "wss://two.test",
        "invalid",
      ]),
    ).toBe(true);
    const restarted = new KeyPackageManager(options);
    expect((await restarted.get(pkg.keyPackageRef))?.publicationRelays).toEqual(
      ["wss://one.test/", "wss://two.test/"],
    );
    const publish = vi.spyOn(network, "publish");
    await restarted.purge(pkg.keyPackageRef);
    expect(publish.mock.calls[0][0]).toEqual([
      "wss://one.test/",
      "wss://two.test/",
    ]);
  });

  it("preserves old route-less records on purge failure without using relay tags", async () => {
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const storage = memoryDatabase().account;
    const store = keyPackageRecords(storage);
    const manager = new KeyPackageManager({
      database: storage,
      signer,
      network,
      clientId: "ab".repeat(32),
    });
    const pkg = await manager.create({ relays: ["wss://local.test"] });
    const { publicationRelays: _routes, ...legacy } = (await manager.get(
      pkg.keyPackageRef,
    ))!;
    const stored = {
      ...legacy,
      published: legacy.published!.map((event) => ({
        ...event,
        tags: [...event.tags, ["relays", "wss://untrusted.test"]],
      })),
    };
    await store.set(bytesToHex(pkg.keyPackageRef), stored);
    const sign = vi.spyOn(signer, "signEvent");
    await expect(manager.purge(pkg.keyPackageRef)).rejects.toThrow(
      MissingRelayError,
    );
    expect(await manager.get(pkg.keyPackageRef)).toEqual(stored);
    expect(sign).not.toHaveBeenCalled();
  });

  it("skips malformed reusable packages before Welcome adoption or consumption", async () => {
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const storage = memoryDatabase().account;
    const store = keyPackageRecords(storage);
    const manager = new KeyPackageManager({
      database: storage,
      signer,
      network,
      clientId: "ab".repeat(32),
    });
    const pkg = await manager.create({ relays: ["wss://local.test"] });
    const entry = (await manager.get(pkg.keyPackageRef))!;
    const legacy = {
      ...entry,
      publicPackage: {
        ...entry.publicPackage,
        extensions: [
          makeCustomExtension({
            extensionType: 10,
            extensionData: new Uint8Array(),
          }),
        ],
      },
    };
    await store.set(bytesToHex(pkg.keyPackageRef), legacy);
    expect(
      await manager.selectForWelcome({
        cipherSuite: entry.publicPackage.cipherSuite,
        secrets: [],
        encryptedGroupInfo: new Uint8Array(),
      }),
    ).toEqual([]);
    expect(await manager.getPrivateKey(pkg.keyPackageRef)).toEqual(
      entry.privatePackage,
    );
  });
  it.each([
    "desktop",
    "AB".repeat(32),
    "a".repeat(63),
    "a".repeat(65),
    "gg".repeat(32),
    " " + "a".repeat(64),
    "",
  ])("rejects invalid clientId %s before effects", (clientId) => {
    const storage = memoryDatabase().account;
    const signer = PrivateKeyAccount.generateNew().signer;
    const sign = vi.spyOn(signer, "signEvent");
    const set = vi.spyOn(storage, "transaction");
    const network = new MockNetwork();
    const publish = vi.spyOn(network, "publish");
    expect(
      () =>
        new KeyPackageManager({ database: storage, signer, network, clientId }),
    ).toThrow("32 random bytes");
    expect(sign).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    "desktop",
    "AB".repeat(32),
    "a".repeat(63),
    "a".repeat(65),
    "gg".repeat(32),
    " " + "a".repeat(64),
    "",
  ])(
    "rejects explicit create and rotation slot %s before effects",
    async (identifier) => {
      const storage = memoryDatabase().account;
      const signer = PrivateKeyAccount.generateNew().signer;
      const network = new MockNetwork();
      const manager = new KeyPackageManager({
        database: storage,
        signer,
        network,
      });
      const sign = vi.spyOn(signer, "signEvent");
      const set = vi.spyOn(storage, "transaction");
      const get = vi.spyOn(storage.keyPackages, "get");
      const publish = vi.spyOn(network, "publish");
      await expect(
        manager.create({ identifier, relays: ["wss://relay.test"] }),
      ).rejects.toThrow("32 random bytes");
      await expect(
        manager.rotate("a".repeat(64), {
          d: identifier,
          relays: ["wss://relay.test"],
        }),
      ).rejects.toThrow("32 random bytes");
      expect(sign).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("rotates after restart using stored routes and retains slot and normalized routes", async () => {
    const storage = memoryDatabase().account;
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const options = {
      database: storage,
      signer,
      network,
      clientId: "ab".repeat(32),
    };
    const first = await new KeyPackageManager(options).create({
      relays: ["wss://relay.test", "wss://relay.test/", "bad-url"],
    });
    const restarted = new KeyPackageManager(options);
    const publish = vi.spyOn(network, "publish");
    const rotated = await restarted.rotate(first.keyPackageRef);
    expect(rotated.identifier).toBe(options.clientId);
    expect(
      (await restarted.get(rotated.keyPackageRef))?.publicationRelays,
    ).toEqual(["wss://relay.test/"]);
    expect((await restarted.list())[0].publicationRelays).toEqual([
      "wss://relay.test/",
    ]);
    expect(publish.mock.calls[0][0]).toEqual(["wss://relay.test/"]);
    expect(publish.mock.calls[0][1].tags.some((t) => t[0] === "relays")).toBe(
      false,
    );
  });

  it("prefers explicit rotation routes and preserves route-less records", async () => {
    const storage = memoryDatabase().account;
    const store = keyPackageRecords(storage);
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const manager = new KeyPackageManager({
      database: storage,
      signer,
      network,
      clientId: "ab".repeat(32),
    });
    const first = await manager.create({ relays: ["wss://old.test"] });
    const publish = vi.spyOn(network, "publish");
    const second = await manager.rotate(first.keyPackageRef, {
      relays: ["wss://new.test"],
    });
    expect(publish.mock.calls[0][0]).toEqual(["wss://new.test/"]);
    const before = (await manager.get(second.keyPackageRef))!;
    const { publicationRelays: _routes, ...legacy } = before;
    await store.set(bytesToHex(second.keyPackageRef), legacy);
    const sign = vi.spyOn(signer, "signEvent");
    await expect(manager.rotate(second.keyPackageRef)).rejects.toThrow(
      "no relay URLs available",
    );
    expect(await manager.get(second.keyPackageRef)).toEqual(legacy);
    expect(sign).not.toHaveBeenCalled();
  });

  it("purges after restart using the union of local routes and consumption metadata", async () => {
    const storage = memoryDatabase().account;
    const signer = PrivateKeyAccount.generateNew().signer;
    const network = new MockNetwork();
    const options = {
      database: storage,
      signer,
      network,
      clientId: "ab".repeat(32),
      hasAdoptedGroup: async () => true,
    };
    const manager = new KeyPackageManager(options);
    const first = await manager.create({
      relays: ["wss://one.test"],
      isLastResort: false,
    });
    const second = await manager.create({
      relays: ["wss://two.test", "wss://one.test/"],
      identifier: "cd".repeat(32),
    });
    await manager.recordConsumption(
      new Uint8Array(32).fill(1),
      first.keyPackageRef,
    );
    await manager.finalizeConsumptions();
    const restarted = new KeyPackageManager(options);
    expect(await restarted.getPrivateKey(first.keyPackageRef)).toBeNull();
    const publish = vi.spyOn(network, "publish");
    await restarted.purge([first.keyPackageRef, second.keyPackageRef]);
    expect(publish.mock.calls[0][0]).toEqual([
      "wss://one.test/",
      "wss://two.test/",
    ]);
    expect(publish.mock.calls[0][1].kind).toBe(5);
    expect(await restarted.get(first.keyPackageRef)).toBeNull();
  });
});

describe("durable KeyPackage consumption receipts", () => {
  async function fixture(isLastResort = false) {
    const account = PrivateKeyAccount.generateNew();
    const database = memoryDatabase();
    const storage = database.account;
    const store = keyPackageRecords(storage);
    let adopted = false;
    const options = {
      database: storage,
      signer: account.signer,
      network: new MockNetwork(),
      hasAdoptedGroup: async (groupId: Uint8Array, adoptionTag?: string) =>
        adopted &&
        (adoptionTag === undefined ||
          (
            await (await database.groups.open(bytesToHex(groupId))).group()
          ).adoptionIds?.includes(adoptionTag) === true),
    };
    const manager = new KeyPackageManager(options);
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(await account.signer.getPublicKey()),
      signer: account.signer,
      ciphersuiteImpl,
      isLastResort,
    });
    const ref = await manager.add(kp);
    const entry = (await manager.get(ref))!;
    const groupId = new Uint8Array(32).fill(7);
    return {
      manager,
      database,
      storage,
      store,
      options,
      ref,
      entry,
      kp,
      groupId,
      adopt: () => {
        adopted = true;
      },
    };
  }

  it("does not retire a failed rejoin receipt merely because the removed group exists", async () => {
    const f = await fixture();
    const group = await f.database.groups.open(bytesToHex(f.groupId));
    await group.transaction((tx) =>
      tx.updateGroup({ removed: true, adoptionIds: ["11".repeat(32)] }),
    );
    f.adopt();
    const adoptionTag = "22".repeat(32);
    await f.manager.recordConsumption(
      f.groupId,
      f.entry.keyPackageRef,
      adoptionTag,
    );
    // Retrying the same Welcome is idempotent; a different Welcome is distinct.
    await f.manager.recordConsumption(
      f.groupId,
      f.entry.keyPackageRef,
      adoptionTag,
    );
    await f.manager.recordConsumption(
      f.groupId,
      f.entry.keyPackageRef,
      "33".repeat(32),
    );
    const restarted = new KeyPackageManager(f.options);
    expect(await restarted.getPrivateKey(f.ref)).toEqual(f.kp.privatePackage);
    expect((await restarted.get(f.ref))?.used).toBeUndefined();
    expect((await restarted.get(f.ref))?.consumptionReceipts).toEqual([
      { groupId: f.groupId, keyPackageRef: f.entry.keyPackageRef, adoptionTag },
      {
        groupId: f.groupId,
        keyPackageRef: f.entry.keyPackageRef,
        adoptionTag: "33".repeat(32),
      },
    ]);
  });

  it.each([false, true])(
    "recovers a matching Welcome adoption after later epochs (reusable: %s)",
    async (reusable) => {
      const f = await fixture(reusable);
      const adoptionTag = "44".repeat(32);
      await f.manager.recordConsumption(
        f.groupId,
        f.entry.keyPackageRef,
        adoptionTag,
      );
      const group = await f.database.groups.open(bytesToHex(f.groupId));
      await group.transaction((tx) =>
        tx.updateGroup({
          adoptionIds: [adoptionTag],
          removed: false,
          state: new Uint8Array([1]),
        }),
      );
      f.adopt();
      // Later canonical state updates must not replace the durable Welcome marker.
      await group.transaction((tx) =>
        tx.updateGroup({ state: new Uint8Array([2]) }),
      );
      const restarted = new KeyPackageManager(f.options);
      expect(await restarted.getPrivateKey(f.ref)).toEqual(
        reusable ? f.kp.privatePackage : null,
      );
      expect((await restarted.get(f.ref))?.used).toBe(true);
      expect((await restarted.get(f.ref))?.consumptionReceipts).toBeUndefined();
      expect((await group.group()).adoptionIds).toEqual([adoptionTag]);
      await restarted.finalizeConsumptions();
      expect((await restarted.get(f.ref))?.consumptionReceipts).toBeUndefined();
    },
  );

  it.each([
    {
      name: "matching canonical adoption",
      canonical: true,
      matches: true,
      retired: true,
    },
    {
      name: "old removed adoption",
      canonical: true,
      matches: false,
      retired: false,
    },
    {
      name: "terminal shell without canonical state",
      canonical: false,
      matches: true,
      retired: true,
    },
  ])(
    "MarmotClient recovery handles $name",
    async ({ canonical, matches, retired }) => {
      const f = await fixture();
      const adoptionTag = "55".repeat(32);
      await f.manager.recordConsumption(
        f.groupId,
        f.entry.keyPackageRef,
        adoptionTag,
      );
      const id = bytesToHex(f.groupId);
      await f.database.account.transaction((tx) =>
        tx.groups.put({ id, status: "active" }),
      );
      const group = await f.database.groups.open(id);
      await group.transaction((tx) =>
        tx.updateGroup({
          ...(canonical
            ? { state: new Uint8Array([1]), removed: !matches }
            : {
                disbandTombstone: {
                  selectedEpoch: 1,
                  commitDigest: "aa".repeat(32),
                  actorPubkey: "bb".repeat(32),
                  notificationState: "delivered",
                },
              }),
          adoptionIds: [matches ? adoptionTag : "66".repeat(32)],
        }),
      );
      const restarted = new MarmotClient({
        database: f.database,
        signer: f.options.signer,
        network: f.options.network,
      });
      expect(await restarted.keyPackages.getPrivateKey(f.ref)).toEqual(
        retired ? null : f.kp.privatePackage,
      );
      expect((await restarted.keyPackages.get(f.ref))?.used === true).toBe(
        retired,
      );
    },
  );

  it("does not retire an initial Welcome whose marker persisted before its first state save", async () => {
    const f = await fixture();
    const adoptionTag = "ee".repeat(32);
    await f.manager.recordConsumption(
      f.groupId,
      f.entry.keyPackageRef,
      adoptionTag,
    );
    const id = bytesToHex(f.groupId);
    const group = await f.database.groups.open(id);
    await group.transaction((tx) =>
      tx.updateGroup({ adoptionIds: [adoptionTag] }),
    );
    // Simulate interruption between the initial marker write and the first save.
    // There is no canonical state, terminal evidence or registered account row.
    const restarted = new MarmotClient({
      database: f.database,
      signer: f.options.signer,
      network: f.options.network,
    });
    expect(await restarted.keyPackages.getPrivateKey(f.ref)).toEqual(
      f.kp.privatePackage,
    );
    expect((await restarted.keyPackages.get(f.ref))?.used).toBeUndefined();
    expect(
      (await restarted.keyPackages.get(f.ref))?.consumptionReceipts,
    ).toHaveLength(1);
    await restarted.keyPackages.finalizeConsumptions();
    expect(await restarted.keyPackages.getPrivateKey(f.ref)).toEqual(
      f.kp.privatePackage,
    );
    // Once the actual state is durable, the same receipt can safely finish.
    const reopened = await f.database.groups.open(id);
    await reopened.transaction((tx) =>
      tx.updateGroup({ state: new Uint8Array([1]) }),
    );
    await restarted.keyPackages.finalizeConsumptions();
    expect(await restarted.keyPackages.getPrivateKey(f.ref)).toBeNull();
    expect(
      (await restarted.keyPackages.get(f.ref))?.consumptionReceipts,
    ).toBeUndefined();
  });

  it.each([false, true])(
    "retires delayed receipts for both committed adoptions after another rejoin (disbanded: %s)",
    async (disbanded) => {
      const f = await fixture();
      const firstTag = "88".repeat(32);
      const secondTag = "99".repeat(32);
      const second = await f.manager.create({
        relays: ["wss://relay.test"],
        identifier: "aa".repeat(32),
        isLastResort: false,
      });
      const id = bytesToHex(f.groupId);
      const group = await f.database.groups.open(id);
      await f.manager.recordConsumption(
        f.groupId,
        f.entry.keyPackageRef,
        firstTag,
      );
      await group.transaction((tx) =>
        tx.updateGroup({ state: new Uint8Array([1]), adoptionIds: [firstTag] }),
      );
      // No retirement runs before the second Welcome is durably adopted.
      await f.manager.recordConsumption(
        f.groupId,
        second.keyPackageRef,
        secondTag,
      );
      await group.transaction(async (tx) => {
        const record = await tx.group();
        await tx.updateGroup({
          state: new Uint8Array([2]),
          adoptionIds: [...(record.adoptionIds ?? []), secondTag],
        });
      });
      if (disbanded)
        await group.transaction((tx) =>
          tx.updateGroup({
            state: null,
            disbandTombstone: {
              selectedEpoch: 3,
              commitDigest: "cc".repeat(32),
              actorPubkey: "dd".repeat(32),
              notificationState: "delivered",
            },
          }),
        );
      await f.database.account.transaction((tx) =>
        tx.groups.put({ id, status: disbanded ? "terminal" : "active" }),
      );
      const restarted = new MarmotClient({
        database: f.database,
        signer: f.options.signer,
        network: f.options.network,
      });
      for (const ref of [f.entry.keyPackageRef, second.keyPackageRef]) {
        expect(await restarted.keyPackages.getPrivateKey(ref)).toBeNull();
        expect((await restarted.keyPackages.get(ref))?.used).toBe(true);
        expect(
          (await restarted.keyPackages.get(ref))?.consumptionReceipts,
        ).toBeUndefined();
      }
      const reopened = await f.database.groups.open(id);
      expect((await reopened.group()).adoptionIds).toEqual([
        firstTag,
        secondTag,
      ]);
    },
  );

  it("leaves pre-adoption receipts and private material unchanged across restart", async () => {
    const f = await fixture();
    await f.manager.recordConsumption(f.groupId, f.entry.keyPackageRef);
    const before = structuredClone(await f.store.get(f.ref));
    expect(before?.consumptionReceipts).toEqual([
      { groupId: f.groupId, keyPackageRef: f.entry.keyPackageRef },
    ]);
    const restarted = new KeyPackageManager(f.options);
    expect(await restarted.get(f.ref)).toEqual(before);
    expect(await restarted.getPrivateKey(f.ref)).toEqual(f.kp.privatePackage);
    f.adopt();
    await restarted.finalizeConsumptions();
    expect(await restarted.getPrivateKey(f.ref)).toBeNull();
    expect((await restarted.get(f.ref))?.consumptionReceipts).toBeUndefined();
  });

  it("automatically retires an adopted single-use package on restart, idempotently", async () => {
    const f = await fixture();
    await f.manager.recordConsumption(f.groupId, f.entry.keyPackageRef);
    f.adopt();
    const restarted = new KeyPackageManager(f.options);
    expect(await restarted.has(f.ref)).toBe(false);
    const after = structuredClone(await restarted.get(f.ref));
    expect(after).toMatchObject({
      used: true,
      publicPackage: f.kp.publicPackage,
    });
    expect(after?.privatePackage).toBeUndefined();
    await restarted.finalizeConsumptions();
    expect(await restarted.get(f.ref)).toEqual(after);
    expect(f.kp.privatePackage).toEqual(f.entry.privatePackage);
  });

  it("retains reusable private material and clears its receipt after adoption", async () => {
    const f = await fixture(true);
    const privateBefore = structuredClone(f.kp.privatePackage);
    await f.manager.recordConsumption(f.groupId, f.entry.keyPackageRef);
    f.adopt();
    const restarted = new KeyPackageManager(f.options);
    expect(await restarted.getPrivateKey(f.ref)).toEqual(privateBefore);
    expect((await restarted.get(f.ref))?.used).toBe(true);
    expect((await restarted.get(f.ref))?.consumptionReceipts).toBeUndefined();
  });

  it.each([
    ["retirement", undefined],
    ["receipt-clear", undefined],
    ["retirement", "77".repeat(32)],
    ["receipt-clear", "77".repeat(32)],
  ])(
    "recovers after a crash during %s persistence (adoption: %s)",
    async (point, adoptionTag) => {
      const f = await fixture();
      await f.manager.recordConsumption(
        f.groupId,
        f.entry.keyPackageRef,
        adoptionTag,
      );
      if (adoptionTag !== undefined) {
        const group = await f.database.groups.open(bytesToHex(f.groupId));
        await group.transaction((tx) =>
          tx.updateGroup({ adoptionIds: [adoptionTag] }),
        );
      }
      f.adopt();
      const before = structuredClone(await f.store.get(f.ref));
      const transaction = f.storage.transaction.bind(f.storage);
      const failure = vi
        .spyOn(f.storage, "transaction")
        .mockImplementation((fn) =>
          transaction((tx) =>
            fn({
              ...tx,
              keyPackages: {
                ...tx.keyPackages,
                put: async (row) => {
                  if (
                    row.used &&
                    (point === "retirement" || !row.consumptionReceipts.length)
                  )
                    throw new Error("simulated crash");
                  return tx.keyPackages.put(row);
                },
              },
            }),
          ),
        );
      await expect(f.manager.finalizeConsumptions()).rejects.toThrow(
        "simulated crash",
      );
      expect((await f.store.get(f.ref))?.consumptionReceipts).toEqual(
        before?.consumptionReceipts,
      );
      if (point === "retirement")
        expect((await f.store.get(f.ref))?.privatePackage).toEqual(
          before?.privatePackage,
        );
      else expect((await f.store.get(f.ref))?.privatePackage).toBeUndefined();
      failure.mockRestore();
      const restarted = new KeyPackageManager(f.options);
      expect(await restarted.getPrivateKey(f.ref)).toBeNull();
      expect((await restarted.get(f.ref))?.consumptionReceipts).toBeUndefined();
    },
  );
});

function makeManager(
  network: MockNetwork,
  account: PrivateKeyAccount<any>,
  clientId?: string,
) {
  const manager = new KeyPackageManager({
    database: memoryDatabase().account,
    signer: account.signer,
    network,
    clientId,
  });
  return { manager };
}

/** Returns the published NostrEvent[] for a ref, or [] if none */
async function getPublished(
  manager: KeyPackageManager,
  ref: Uint8Array | string,
) {
  return (await manager.get(ref))?.published ?? [];
}

/**
 * Builds a legacy-shaped KeyPackage without importing the deleted legacy proof
 * module: calls ts-mls's own `generateKeyPackage` directly with a leaf that
 * carries only the legacy `0xf2f1` custom extension and no `0x8009` proof
 * (D-09). `validateKeyPackageAccountIdentityProof` rejects it, which is
 * exactly what makes `KeyPackageStore.list()` classify it `nonCurrent`.
 */
async function buildLegacyKeyPackage(
  account: PrivateKeyAccount<any>,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const pubkey = await account.signer.getPublicKey();
  return mlsGenerateKeyPackage({
    credential: createCredential(pubkey),
    capabilities: defaultCapabilities(),
    lifetime: createDefaultKeyPackageLifetime(),
    extensions: [],
    cipherSuite: ciphersuiteImpl,
    leafNodeExtensions: [
      makeCustomExtension({
        extensionType: 0xf2f1,
        extensionData: new Uint8Array(4),
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeyPackageManager", () => {
  let account: PrivateKeyAccount<any>;
  let network: MockNetwork;

  beforeEach(() => {
    account = PrivateKeyAccount.generateNew();
    network = new MockNetwork(["wss://relay.test"]);
  });

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe("create()", () => {
    it("throws MissingRelayError if no relays are provided", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await expect(
        manager.create({ relays: [], identifier: TEST_CLIENT_ID }),
      ).rejects.toThrow(MissingRelayError);
    });

    it("throws MissingSlotIdentifierError if no d and no clientId", async () => {
      const { manager } = makeManager(network, account); // no clientId
      await expect(
        manager.create({ relays: ["wss://relay.test"] }),
      ).rejects.toThrow(MissingSlotIdentifierError);
    });

    it("uses manager clientId when no d is passed in options", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      expect(pkg.identifier).toBe(TEST_CLIENT_ID);
    });

    it("uses explicit d option, overriding clientId", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const explicitD = "cd".repeat(32);
      const pkg = await manager.create({
        relays: ["wss://relay.test"],
        identifier: explicitD,
      });

      expect(pkg.identifier).toBe(explicitD);
    });

    it("stores the slot identifier under identifier, not d", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const stored = await manager.get(pkg.keyPackageRef);
      const storedRecord = stored as Record<string, unknown> | null;

      expect(stored?.identifier).toBe(TEST_CLIENT_ID);
      expect(storedRecord?.d).toBeUndefined();
    });

    it("stores private key material locally", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      expect(await manager.count()).toBe(1);
      expect(await manager.has(pkg.keyPackageRef)).toBe(true);
    });

    it("publishes a kind 30443 event to the network", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });

      const published = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      expect(published).toHaveLength(1);
    });

    it("does not publish any legacy kind 443 events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });

      const legacy = network.events.filter((e) => e.kind === 443);
      expect(legacy).toHaveLength(0);
    });

    it("published event includes the d tag", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });

      const event = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;
      expect(getKeyPackageIdentifier(event)).toBe(TEST_CLIENT_ID);
    });

    it("two create() calls with clientId produce events with the same d tag", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      await manager.create({ relays: ["wss://relay.test"] });

      const events = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      expect(events).toHaveLength(2);
      expect(getKeyPackageIdentifier(events[0])).toBe(TEST_CLIENT_ID);
      expect(getKeyPackageIdentifier(events[1])).toBe(TEST_CLIENT_ID);
    });

    it("records the published event on the stored entry", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);

      const networkEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      expect(events[0].id).toBe(networkEvent?.id);
    });

    it("retains relay URLs locally and omits relay tags", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(getKeyPackageRelays(events[0])).toBeUndefined();
      expect((await manager.get(pkg.keyPackageRef))?.publicationRelays).toEqual(
        ["wss://relay.test/"],
      );
    });

    it("emits added and published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      const added = vi.fn();
      const published = vi.fn();
      manager.on("added", added);
      manager.on("published", published);

      await manager.create({ relays: ["wss://relay.test"] });

      expect(added).toHaveBeenCalledOnce();
      expect(published).toHaveBeenCalledOnce();
    });

    it("deduplicates repeated addressable published events for the same ref via track()", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      // Simulate the same key package being observed again on another relay
      const originalEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;
      await manager.track({ ...originalEvent, id: "b".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // rotate()
  // -------------------------------------------------------------------------

  describe("rotate()", () => {
    it("throws if the key package ref is not found in local private store", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const fakeRef = new Uint8Array(32).fill(0xab);
      await expect(manager.rotate(fakeRef)).rejects.toThrow(
        "Key package not found",
      );
    });

    it("throws if no relays can be determined for the new key package", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      // Add a key package to the private store without any published events
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        signer: account.signer,
      });
      await manager.add(kp);

      const listed = await manager.list();
      await expect(
        manager.rotate(listed[0].keyPackageRef, { relays: undefined }),
      ).rejects.toThrow("no relay URLs available");
    });

    it("reuses the same d slot from the stored entry", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const newPkg = await manager.rotate(pkg.keyPackageRef);

      // New package should still use the same slot identifier
      expect(newPkg.identifier).toBe(TEST_CLIENT_ID);
      const addrEvents = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      const newEvent = addrEvents[addrEvents.length - 1]!;
      expect(getKeyPackageIdentifier(newEvent)).toBe(TEST_CLIENT_ID);
    });

    it("generates a random d when old entry has no d", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      // Inject a stored entry without a d slot.
      // Uses top-level imports for generateKeyPackage, createCredential, etc.
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        signer: account.signer,
      });
      // add without d — simulates legacy entry
      await manager.add(kp);

      const listed = await manager.list();
      const newPkg = await manager.rotate(listed[0].keyPackageRef, {
        relays: ["wss://relay.test"],
      });

      // Should have some d, just not a specific one
      expect(newPkg.identifier).toBeDefined();
      expect(typeof newPkg.identifier).toBe("string");
      expect(newPkg.identifier!.length).toBeGreaterThan(0);
    });

    it("does NOT send a NIP-09 deletion for kind 30443 published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.rotate(pkg.keyPackageRef);

      // No kind 5 deletion should have been published
      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(0);
    });

    it("creates and publishes a new kind 30443 event", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.rotate(pkg.keyPackageRef);

      const keyPackageEvents = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      // One from create(), one from rotate()
      expect(keyPackageEvents).toHaveLength(2);
    });

    it("removes the old private key material after rotation", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      expect(await manager.count()).toBe(1);
      await manager.rotate(pkg.keyPackageRef);

      expect(await manager.count()).toBe(1);
      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
    });

    it("removes the old published events after rotation", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.rotate(pkg.keyPackageRef);

      const remaining = await getPublished(manager, pkg.keyPackageRef);
      expect(remaining).toHaveLength(0);
    });

    it("reuses relays from the old key package if no relays option is passed", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({
        relays: ["wss://specific-relay.test"],
      });

      const newPkg = await manager.rotate(pkg.keyPackageRef);

      const events = await getPublished(manager, newPkg.keyPackageRef);
      expect(getKeyPackageRelays(events[0])).toBeUndefined();
      expect(
        (await manager.get(newPkg.keyPackageRef))?.publicationRelays,
      ).toContain("wss://specific-relay.test/");
    });

    it("skips relay deletion if the old key package was never published", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      // Add an unpublished key package directly to the private store
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        signer: account.signer,
      });
      await manager.add(kp);

      const listed = await manager.list();
      await manager.rotate(listed[0].keyPackageRef, {
        relays: ["wss://relay.test"],
      });

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(0);
    });

    it("returns a new key package with a different ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const old = await manager.create({ relays: ["wss://relay.test"] });
      const newPkg = await manager.rotate(old.keyPackageRef);

      expect(newPkg.keyPackageRef).toBeDefined();
      expect(
        Buffer.from(newPkg.keyPackageRef).equals(
          Buffer.from(old.keyPackageRef),
        ),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // remove()
  // -------------------------------------------------------------------------

  describe("remove()", () => {
    it("removes the key package from local private storage", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.remove(pkg.keyPackageRef);

      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
      expect(await manager.count()).toBe(0);
    });

    it("does not publish anything to the network", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const countBefore = network.events.length;

      await manager.remove(pkg.keyPackageRef);

      expect(network.events.length).toBe(countBefore);
    });

    it("emits removed", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const removed = vi.fn();
      manager.on("removed", removed);
      await manager.remove(pkg.keyPackageRef);

      expect(removed).toHaveBeenCalledOnce();
    });

    it("removes the entry including its published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.remove(pkg.keyPackageRef);

      expect(await getPublished(manager, pkg.keyPackageRef)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // purge()
  // -------------------------------------------------------------------------

  describe("purge()", () => {
    it("publishes a kind 5 deletion for a single ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.purge(pkg.keyPackageRef);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);
    });

    it("deletion event includes both e and a tags for kind 30443 published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.purge(pkg.keyPackageRef);

      const deleteEvent = network.events.find((e) => e.kind === 5)!;
      const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
      const aTags = deleteEvent.tags.filter((t) => t[0] === "a");

      expect(eTags).toHaveLength(1);
      expect(aTags).toHaveLength(1);
      // a tag should be a 30443 coordinate
      expect(aTags[0][1]).toMatch(/^30443:/);
    });

    it("the deletion event references deduplicated event IDs for the ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      // Simulate a second observation of the same key package event
      const originalEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;
      await manager.track({ ...originalEvent, id: "b".repeat(64) });

      await manager.purge(pkg.keyPackageRef);

      const deleteEvent = network.events.find((e) => e.kind === 5)!;
      const eTags = deleteEvent.tags.filter((t) => t[0] === "e");
      expect(eTags).toHaveLength(1);
    });

    it("removes local private key material", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.purge(pkg.keyPackageRef);

      expect(await manager.has(pkg.keyPackageRef)).toBe(false);
    });

    it("accepts an array of refs and publishes a single deletion covering all", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg1 = await manager.create({ relays: ["wss://relay.test"] });
      const pkg2 = await manager.create({
        relays: ["wss://relay2.test"],
        identifier: "ef".repeat(32),
      });

      await manager.purge([pkg1.keyPackageRef, pkg2.keyPackageRef]);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);
      const eTags = deleteEvents[0].tags.filter((t) => t[0] === "e");
      expect(eTags).toHaveLength(2);
    });

    it("removes private keys for all refs in a bulk purge", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg1 = await manager.create({ relays: ["wss://relay.test"] });
      const pkg2 = await manager.create({
        relays: ["wss://relay2.test"],
        identifier: "ef".repeat(32),
      });

      await manager.purge([pkg1.keyPackageRef, pkg2.keyPackageRef]);

      expect(await manager.has(pkg1.keyPackageRef)).toBe(false);
      expect(await manager.has(pkg2.keyPackageRef)).toBe(false);
    });

    it("silently skips relay deletion for refs with no published events but still removes private key", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      // Add an unpublished key package directly to the private store
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        signer: account.signer,
      });
      await manager.add(kp);
      const listed = await manager.list();
      const unpublishedRef = listed[0].keyPackageRef;

      const eventCountBefore = network.events.length;
      await manager.purge(unpublishedRef);

      expect(network.events.length).toBe(eventCountBefore);
      expect(await manager.has(unpublishedRef)).toBe(false);
    });

    it("accepts a hex string ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const refHex = Buffer.from(pkg.keyPackageRef).toString("hex");

      await manager.purge(refHex);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(1);
      expect(await manager.has(refHex)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // track()
  // -------------------------------------------------------------------------

  describe("track()", () => {
    it("returns false and ignores non-key-package events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const result = await manager.track({
        id: "aa",
        kind: 1,
        pubkey: "bb",
        created_at: 0,
        content: "",
        tags: [],
        sig: "cc",
      });
      expect(result).toBe(false);
      expect(await manager.list()).toHaveLength(0);
    });

    it("returns false if the kind 30443 event has no `i` tag", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const result = await manager.track({
        id: "aa",
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        pubkey: "bb",
        created_at: 0,
        content: "",
        tags: [["d", "someslot"]],
        sig: "cc",
      });
      expect(result).toBe(false);
      expect(await manager.list()).toHaveLength(0);
    });

    it("rejects a legacy kind 443 event", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const result = await manager.track({
        id: "aa",
        kind: 443,
        pubkey: "bb",
        created_at: 0,
        content: "",
        tags: [["i", "a".repeat(64)]],
        sig: "cc",
      });
      expect(result).toBe(false);
      expect(await manager.list()).toHaveLength(0);
    });

    it("returns false if the event body cannot be decoded as a KeyPackage", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const result = await manager.track({
        id: "b".repeat(64),
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        pubkey: "c".repeat(64),
        created_at: 1000,
        content: "",
        tags: [
          ["i", "a".repeat(64)],
          ["d", "someslot"],
        ],
        sig: "d".repeat(128),
      });
      expect(result).toBe(false);
    });

    it("rejects an event whose `i` tag does not match the decoded KeyPackage (transports/nostr.md)", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      // Same valid KeyPackage body, but a forged `i` tag claiming a different
      // ref. Receivers MUST recompute the ref and reject the mismatch.
      const forgedRef = "f".repeat(64);
      const realRef = realEvent.tags.find((t) => t[0] === "i")![1];
      expect(forgedRef).not.toBe(realRef);
      const forged = {
        ...realEvent,
        id: "e".repeat(64),
        tags: realEvent.tags.map((t) => (t[0] === "i" ? ["i", forgedRef] : t)),
      };

      const result = await manager.track(forged);

      expect(result).toBe(false);
      // Not indexed under the forged ref…
      expect(await manager.get(forgedRef)).toBeNull();
      // …and the real entry's published list did not grow from the forgery.
      const realPublished = await getPublished(manager, realRef);
      expect(realPublished.every((e) => e.id !== forged.id)).toBe(true);
    });

    it("returns true and records a real kind 30443 published event", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const result = await manager.track({ ...realEvent, id: "e".repeat(64) });

      expect(result).toBe(true);
      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);
    });

    it("replaces an older addressable published event with a newer one", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const newerEvent = {
        ...realEvent,
        id: "e".repeat(64),
        created_at: realEvent.created_at + 1,
      };
      await manager.track(newerEvent);

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(newerEvent.id);
    });

    it("stores the d tag when tracking a kind 30443 event", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      // Track with a different id (as if observed from another relay)
      const tracked = { ...realEvent, id: "e".repeat(64) };
      await manager.track(tracked);

      // d tag from the event should be on the stored entry
      const iTag = realEvent.tags.find((t) => t[0] === "i")!;
      const stored = await manager.get(iTag[1]);
      expect(stored?.identifier).toBe(TEST_CLIENT_ID);
    });

    it("retains local relay routes when tracking an event", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({
        relays: ["wss://relay1.test", "wss://relay2.test"],
      });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      await manager.track({ ...realEvent, id: "e".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(getKeyPackageRelays(events[0])).toBeUndefined();
      expect((await manager.get(pkg.keyPackageRef))?.publicationRelays).toEqual(
        ["wss://relay1.test/", "wss://relay2.test/"],
      );
    });

    it("records a valid key package event from another device (no local private key)", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      const otherNetwork = new MockNetwork(["wss://relay.test"]);
      const otherAccount = PrivateKeyAccount.generateNew();
      const { manager: otherManager } = makeManager(
        otherNetwork,
        otherAccount,
        "cd".repeat(32),
      );
      await otherManager.create({ relays: ["wss://relay.test"] });

      const foreignEvent = otherNetwork.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const result = await manager.track(foreignEvent);

      expect(result).toBe(true);
      // Not in local private store
      expect(
        await manager.has(foreignEvent.tags.find((t) => t[0] === "i")![1]),
      ).toBe(false);
      // But tracked in the store
      const refHex = foreignEvent.tags.find((t) => t[0] === "i")![1];
      const stored = await manager.get(refHex);
      expect(stored?.published).toHaveLength(1);
    });

    it("emits published when a valid event is tracked", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const publishedHandler = vi.fn();
      manager.on("published", publishedHandler);

      const newId = "b".repeat(64);
      await manager.track({ ...realEvent, id: newId });

      expect(publishedHandler).toHaveBeenCalledOnce();
      expect(publishedHandler).toHaveBeenCalledWith(
        Buffer.from(pkg.keyPackageRef).toString("hex"),
        newId,
        expect.any(Array),
      );
    });

    it("deduplicates multiple addressable events for the same ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      await manager.track({ ...realEvent, id: "b".repeat(64) });
      await manager.track({ ...realEvent, id: "e".repeat(64) });

      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // track() — trust boundary (SEC-01/WIRE-01/WIRE-02)
  // -------------------------------------------------------------------------

  describe("track() — trust boundary (SEC-01/WIRE-01/WIRE-02)", () => {
    /** See `corruptSignature` in groups-manager.test.ts: strips the cached verifiedSymbol. */
    function corruptSignature(event: NostrEvent): NostrEvent {
      const corrupted: NostrEvent = { ...event, sig: "0".repeat(128) };
      delete (corrupted as Record<PropertyKey, unknown>)[verifiedSymbol];
      return corrupted;
    }

    it("rejects a signature-corrupted 30443 event before persisting", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      const otherNetwork = new MockNetwork(["wss://relay.test"]);
      const otherAccount = PrivateKeyAccount.generateNew();
      const { manager: otherManager } = makeManager(
        otherNetwork,
        otherAccount,
        "cd".repeat(32),
      );
      await otherManager.create({ relays: ["wss://relay.test"] });
      const foreignEvent = otherNetwork.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;
      const corrupted = corruptSignature(foreignEvent);

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(corrupted);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("invalid-signature");
      const refHex = foreignEvent.tags.find((t) => t[0] === "i")![1];
      expect(await manager.get(refHex)).toBeNull();
    });

    it("rejects a properly-signed 30443 event carrying a duplicate d tag as tag-cardinality", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const real = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const draft = {
        kind: real.kind,
        created_at: real.created_at,
        content: real.content,
        tags: [...real.tags, ["d", "duplicate-slot"]],
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("tag-cardinality");
    });

    it("rejects a properly-signed 30443 event with a duplicate i tag as tag-cardinality", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const real = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const draft = {
        kind: real.kind,
        created_at: real.created_at,
        content: real.content,
        tags: [...real.tags, ["i", "b".repeat(64)]],
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("tag-cardinality");
    });

    it("rejects a 30443 event with a missing mls_protocol_version tag as tag-cardinality", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const real = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const draft = {
        kind: real.kind,
        created_at: real.created_at,
        content: real.content,
        tags: real.tags.filter((t) => t[0] !== "mls_protocol_version"),
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("tag-cardinality");
    });

    it("rejects a 30443 event whose mls_protocol_version is not 1.0 as tag-cardinality", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const real = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const draft = {
        kind: real.kind,
        created_at: real.created_at,
        content: real.content,
        tags: real.tags.map((t) =>
          t[0] === "mls_protocol_version" ? ["mls_protocol_version", "2.0"] : t,
        ),
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("tag-cardinality");
    });

    it("rejects a 30443 event whose KeyPackage lifetime exceeds the cap as lifetime-cap", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl,
        signer: account.signer,
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const overCapPackage = {
        ...kp.publicPackage,
        leafNode: {
          ...kp.publicPackage.leafNode,
          lifetime: { notBefore: now, notAfter: now + 7261201n },
        },
      };
      const framedBytes = encode(mlsMessageEncoder, {
        version: overCapPackage.version,
        wireformat: wireformats.mls_key_package,
        keyPackage: overCapPackage,
      });
      const draft = {
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: bytesToBase64(framedBytes),
        tags: [
          ["d", "over-cap-slot"],
          ["i", "a".repeat(64)],
          ["mls_protocol_version", "1.0"],
        ],
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("lifetime-cap");
    });

    it("rejects a 30443 event whose KeyPackage lifetime is expired beyond the ~1h grace as lifetime-cap", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl,
        signer: account.signer,
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiredPackage = {
        ...kp.publicPackage,
        leafNode: {
          ...kp.publicPackage.leafNode,
          lifetime: { notBefore: now - 100_000n, notAfter: now - 10_000n },
        },
      };
      const framedBytes = encode(mlsMessageEncoder, {
        version: expiredPackage.version,
        wireformat: wireformats.mls_key_package,
        keyPackage: expiredPackage,
      });
      const draft = {
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: bytesToBase64(framedBytes),
        tags: [
          ["d", "expired-slot"],
          ["i", "b".repeat(64)],
          ["mls_protocol_version", "1.0"],
        ],
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track(badEvent);

      expect(result).toBe(false);
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1]).toBe("lifetime-cap");
    });

    it("tracks a fully-valid, in-cap, current, correctly-signed 30443 event successfully", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const real = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const rejections: Array<[NostrEvent, string]> = [];
      manager.on("rejected", (event, reason) =>
        rejections.push([event, reason]),
      );

      const result = await manager.track({ ...real, id: "f".repeat(64) });

      expect(result).toBe(true);
      expect(rejections).toHaveLength(0);
      const events = await getPublished(manager, pkg.keyPackageRef);
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // markUsed()
  // -------------------------------------------------------------------------

  describe("markUsed()", () => {
    it("sets used=true on the stored key package", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.markUsed(pkg.keyPackageRef);

      const stored = await manager.get(pkg.keyPackageRef);
      expect(stored?.used).toBe(true);
    });

    it("used flag is visible in list()", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      await manager.create({
        relays: ["wss://relay.test"],
        identifier: "ef".repeat(32),
      });

      await manager.markUsed(pkg.keyPackageRef);

      const all = await manager.list();
      expect(all.filter((p) => p.used)).toHaveLength(1);
      expect(all.filter((p) => !p.used)).toHaveLength(1);
    });

    it("emits updated", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const updated: StoredKeyPackage[] = [];
      manager.on("updated", (kp) => updated.push(kp));

      await manager.markUsed(pkg.keyPackageRef);

      expect(updated).toHaveLength(1);
      expect(updated[0].used).toBe(true);
    });

    it("does nothing when the ref does not exist", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await expect(manager.markUsed("a".repeat(64))).resolves.toBeUndefined();
    });

    it("accepts Uint8Array ref", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      await manager.markUsed(pkg.keyPackageRef);

      const stored = await manager.get(pkg.keyPackageRef);
      expect(stored?.used).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe("list()", () => {
    it("returns all locally stored key packages enriched with published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      await manager.create({
        relays: ["wss://relay.test"],
        identifier: "ef".repeat(32),
      });

      expect(await manager.list()).toHaveLength(2);
    });

    it("returns the slot identifier under identifier, not d", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const [listed] = await manager.list();
      const listedRecord = listed as Record<string, unknown>;

      expect(listed.identifier).toBe(pkg.identifier);
      expect(listedRecord.d).toBeUndefined();
    });

    it("each entry includes published — filter for packages with published events", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      await manager.create({ relays: ["wss://relay.test"] });

      // One unpublished package (added directly to private store, no publish record)
      const ciphersuite = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const pubkey = await account.signer.getPublicKey();
      const kp = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        signer: account.signer,
      });
      await manager.add(kp);

      const all = await manager.list();
      expect(all).toHaveLength(2);
      expect(all.filter((p) => (p.published?.length ?? 0) > 0)).toHaveLength(1);
    });

    it("tracked foreign packages (no private key) do not appear in list()", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);

      const otherNetwork = new MockNetwork(["wss://relay.test"]);
      const otherAccount = PrivateKeyAccount.generateNew();
      const { manager: otherManager } = makeManager(
        otherNetwork,
        otherAccount,
        "cd".repeat(32),
      );
      await otherManager.create({ relays: ["wss://relay.test"] });
      const foreignEvent = otherNetwork.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      await manager.track(foreignEvent);

      expect(await manager.list()).toHaveLength(0);
      const refHex = foreignEvent.tags.find((t) => t[0] === "i")![1];
      const stored = await manager.get(refHex);
      expect(stored?.published).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // watchKeyPackages()
  // -------------------------------------------------------------------------

  describe("watchKeyPackages()", () => {
    it("yields initial snapshot immediately", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      const { value } = await gen.next();
      await gen.return(undefined);

      expect(value).toHaveLength(1);
      expect(value[0].published).toHaveLength(1);
    });

    it("initial snapshot includes published events merged from store", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      const { value } = await gen.next();
      await gen.return(undefined);

      expect(value[0].keyPackageRef).toEqual(pkg.keyPackageRef);
      expect(value[0].published).toHaveLength(1);
      expect(getKeyPackageRelays(value[0].published![0])).toBeUndefined();
      expect(value[0].publicationRelays).toContain("wss://relay.test/");
    });

    it("yields updated snapshot after a key package is added", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const gen = manager.watchKeyPackages();

      const first = await gen.next();
      expect(first.value).toHaveLength(0);

      const created = manager.create({ relays: ["wss://relay.test"] });
      const second = await gen.next();
      await created;
      await gen.return(undefined);

      expect(second.value).toHaveLength(1);
    });

    it("yields a new array instance for each snapshot", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });
      const gen = manager.watchKeyPackages();

      const first = await gen.next();
      const update = manager.markUsed(pkg.keyPackageRef);
      const second = await gen.next();
      await update;
      await gen.return(undefined);

      expect(second.value).not.toBe(first.value);
    });

    it("yields a deduplicated snapshot after a publish is tracked", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });
      const realEvent = network.events.find(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      )!;

      const gen = manager.watchKeyPackages();
      await gen.next();

      const tracking = manager.track({ ...realEvent, id: "b".repeat(64) });
      const { value } = await gen.next();
      await tracking;
      await gen.return(undefined);

      expect(value[0].published).toHaveLength(1);
    });

    it("yields updated snapshot after a key package is removed", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const pkg = await manager.create({ relays: ["wss://relay.test"] });

      const gen = manager.watchKeyPackages();
      await gen.next();

      const removal = manager.remove(pkg.keyPackageRef);
      const { value } = await gen.next();
      await removal;
      await gen.return(undefined);

      expect(value).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // non-current stored KeyPackages (D-09)
  // -------------------------------------------------------------------------

  describe("non-current stored KeyPackages (D-09)", () => {
    it("a KeyPackage created through manager.create() lists without a nonCurrent property (current)", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      await manager.create({ relays: ["wss://relay.test"] });

      const [listed] = await manager.list();
      expect(listed.nonCurrent).toBeUndefined();
    });

    it("a legacy-shaped KeyPackage added through manager.add() lists with nonCurrent === true, including watchKeyPackages snapshots", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const legacy = await buildLegacyKeyPackage(account, ciphersuiteImpl);
      await manager.add(legacy);

      const [listed] = await manager.list();
      expect(listed.nonCurrent).toBe(true);

      const gen = manager.watchKeyPackages();
      const { value } = await gen.next();
      await gen.return(undefined);
      expect(value[0]?.nonCurrent).toBe(true);
    });

    it("ensurePublished ignores a non-current unused package, publishes exactly one fresh current package, and sends no kind-5", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const legacy = await buildLegacyKeyPackage(account, ciphersuiteImpl);
      const legacyRefHex = await manager.add(legacy);

      const fresh = await manager.ensurePublished({
        relays: ["wss://relay.test"],
      });

      expect(bytesToHex(fresh.keyPackageRef)).not.toBe(legacyRefHex);
      const published = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      expect(published).toHaveLength(1);

      const all = await manager.list();
      expect(all).toHaveLength(2);
      const legacyListed = all.find(
        (p) => bytesToHex(p.keyPackageRef) === legacyRefHex,
      );
      expect(legacyListed?.nonCurrent).toBe(true);

      const deleteEvents = network.events.filter((e) => e.kind === 5);
      expect(deleteEvents).toHaveLength(0);
    });

    it("ensurePublished returns the existing current unused package and publishes nothing when one is already stored", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const created = await manager.create({ relays: ["wss://relay.test"] });

      const result = await manager.ensurePublished({
        relays: ["wss://relay.test"],
      });

      expect(result.keyPackageRef).toEqual(created.keyPackageRef);
      const published = network.events.filter(
        (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
      );
      expect(published).toHaveLength(1);
    });

    it("purge(legacyRef) removes a non-current entry explicitly — nothing is auto-deleted", async () => {
      const { manager } = makeManager(network, account, TEST_CLIENT_ID);
      const ciphersuiteImpl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const legacy = await buildLegacyKeyPackage(account, ciphersuiteImpl);
      const legacyRefHex = await manager.add(legacy);

      // Confirmed present and non-current before purge.
      expect((await manager.list())[0]?.nonCurrent).toBe(true);

      await manager.purge(legacyRefHex);

      const all = await manager.list();
      expect(
        all.find((p) => bytesToHex(p.keyPackageRef) === legacyRefHex),
      ).toBeUndefined();
    });
  });
});
