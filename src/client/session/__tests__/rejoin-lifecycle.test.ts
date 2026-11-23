import { describe, expect, it, onTestFinished, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { memoryGroupDatabase } from "../../../__tests__/helpers/database.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { MarmotGroup } from "../../group/marmot-group.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import { groupTreeStore } from "../../storage/database/group-batch.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(loaded = false) {
  const account = testAccount(6);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const keys = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    ciphersuiteImpl: ciphersuite,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(
    keys,
    ciphersuite,
    "Lifecycle",
    {
      adminPubkeys: [account.pubkey],
      relays: ["wss://relay.test"],
    },
  );
  let fresh = clientState;
  for (let i = 0; i < 2; i++)
    fresh = (
      await createCommit({
        context: {
          cipherSuite: ciphersuite,
          authService: unsafeTestingAuthenticationService,
        },
        state: fresh,
        wireAsPublicMessage: false,
      })
    ).newState;
  const removed = structuredClone(clientState);
  removed.groupActiveState = { kind: "removedFromGroup" };
  const database = memoryGroupDatabase();
  const network = new MockNetwork();
  const options = { database, signer: account.signer, ciphersuite, network };
  let group = new MarmotGroup(removed, options);
  await group.save(true);
  if (loaded) {
    group.dispose();
    const historyTree = await GroupHistoryTree.load(
      groupTreeStore(database),
      bytesToHex(removed.groupContext.groupId),
    );
    group = new MarmotGroup(removed, { ...options, historyTree });
  }
  onTestFinished(() => group.dispose());
  return { group, fresh, database, network };
}

describe("rejoin lifetime races", () => {
  it.each(["dispose", "destroy"] as const)(
    "does not reopen a facade when %s races the adapter commit acknowledgement",
    async (operation) => {
      const { group, fresh, database, network } = await fixture();
      const committed = deferred();
      const acknowledge = deferred();
      const transaction = database.transaction.bind(database);
      let armed = true;
      vi.spyOn(database, "transaction").mockImplementation(async (callback) => {
        const result = await transaction(callback);
        if (armed) {
          armed = false;
          committed.resolve();
          await acknowledge.promise;
        }
        return result;
      });
      const rejoining = group.rejoinFromWelcome(fresh);
      await committed.promise;
      const closing = group[operation]();
      expect(group.closedSignal.aborted).toBe(true);
      acknowledge.resolve();
      await rejoining;
      await closing;
      expect(group.session.destroyed).toBe(true);
      expect(() => group.session.assertOpen()).toThrow();
      const events = network.events.length;
      await expect(group.selfUpdate()).rejects.toThrow(/destroyed|unloaded/i);
      expect(network.events).toHaveLength(events);
      if (operation === "destroy") expect(await database.group()).toEqual({});
    },
  );

  it("revokes the loaded old tree's backing store after adoption", async () => {
    const { group, fresh, database } = await fixture(true);
    const oldTree = group.forkTree;
    expect(oldTree.isDirty).toBe(false);
    const oldTag = bytesToHex(group.state.confirmationTag);
    oldTree.updateSnapshot(oldTag, group.state);
    await group.rejoinFromWelcome(fresh);
    const checkpoint = (await database.group()).checkpoint;
    // Direct tree persistence must use the retired owner's capability, not the
    // raw store originally used by the registry loader.
    await expect(oldTree.flush()).rejects.toThrow(/replacement/);
    expect((await database.group()).checkpoint).toEqual(checkpoint);
    expect(await database.treeNodes.get(oldTag)).toBeUndefined();
  });

  it("finishes destruction when adoption aborts while its callback is paused", async () => {
    const { group, fresh, database } = await fixture();
    const entered = deferred();
    const release = deferred();
    const rejoining = group.rejoinFromWelcome(fresh, {
      beforeAdopt: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const rejected = expect(rejoining).rejects.toThrow(/closed/);
    await entered.promise;
    const destroying = group.destroy();
    expect(group.closedSignal.aborted).toBe(true);
    release.resolve();
    await rejected;
    await destroying;
    expect(await database.group()).toEqual({});
    expect(group.session.destroyed).toBe(true);
  });

  it("refuses rejoin until a paused ingestion batch is fully drained", async () => {
    const { group, fresh } = await fixture();
    const event = await group.signer.signEvent({
      kind: 445,
      created_at: 1,
      content: "",
      tags: [],
    });
    const ingestion = group.ingest([event, event]);
    expect((await ingestion.next()).done).toBe(false);
    const beforeAdopt = vi.fn();
    await expect(
      group.rejoinFromWelcome(fresh, { beforeAdopt }),
    ).rejects.toThrow(/fully drained/);
    expect(beforeAdopt).not.toHaveBeenCalled();
    expect((await ingestion.next()).done).toBe(false);
    expect((await ingestion.next()).done).toBe(true);
    await group.rejoinFromWelcome(fresh);
    expect(group.status).toBe("active");
  });
});
