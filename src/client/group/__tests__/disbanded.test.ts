import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defaultCryptoProvider,
  getCiphersuiteImpl,
  createCommit,
  createProposal,
  defaultProposalTypes,
  joinGroup,
  unsafeTestingAuthenticationService,
  getAppDataDictionary,
  makeAppDataDictionaryExtension,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import {
  memoryDatabase,
  memoryGroupDatabase,
} from "../../../__tests__/helpers/database.js";
import type {
  GroupTransaction,
  MarmotDatabase,
  MarmotGroupDatabase,
} from "../../storage/database/types.js";
import { GroupTerminalError, MarmotGroup } from "../marmot-group.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { GroupRegistry } from "../../storage/group-registry.js";
import {
  decodeDisbandTombstone,
  DISBAND_TOMBSTONE_KEY,
  encodeDisbandTombstone,
  type DisbandTombstone,
  encodeDisbandTerminalIntent,
  decodeDisbandTerminalIntent,
  DISBAND_INTENT_KEY,
} from "../../../engine/disband-tombstone.js";

type MetaOp = { type: "set" | "delete"; key: string; value?: Uint8Array };
const ROLLBACK = new Error("rollback");

/**
 * Routes every transaction of `db` through `hook`, which sees the meta writes
 * the transaction would make (from a rolled-back dry run) and decides whether
 * to commit them via `write`. Returns a restore.
 */
function interceptMeta(
  db: MarmotGroupDatabase,
  hook: (ops: MetaOp[], write: () => Promise<void>) => Promise<void>,
): () => void {
  const transaction = db.transaction.bind(db);
  db.transaction = async <T>(fn: (tx: GroupTransaction) => Promise<T>) => {
    const ops: MetaOp[] = [];
    try {
      await transaction(async (tx) => {
        await fn({
          ...tx,
          meta: {
            ...tx.meta,
            set: async (key, value) => {
              ops.push({ type: "set", key, value });
              return tx.meta.set(key, value);
            },
            delete: async (key) => {
              ops.push({ type: "delete", key });
              return tx.meta.delete(key);
            },
          },
        });
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    let result!: T;
    await hook(ops, async () => {
      result = await transaction(fn);
    });
    return result;
  };
  return () => {
    db.transaction = transaction;
  };
}

/** A client database whose only group is `db`. */
async function clientDatabase(
  db: MarmotGroupDatabase,
  id: string,
): Promise<MarmotDatabase> {
  const { account } = memoryDatabase();
  await account.transaction((tx) =>
    tx.groups.put({ id, status: "active", value: new Uint8Array() }),
  );
  return { account, groups: { open: async () => db, drop: async () => {} } };
}
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { deserializeClientState } from "../../../core/client-state.js";
import { GROUP_PROFILE_COMPONENT_ID } from "../../../core/components/ids.js";
import { GroupSession } from "../../session/group-session.js";
import { createGroupEvent } from "../../../core/group-event.js";

async function peers() {
  const admin = testAccount(6),
    member = testAccount(9);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const [adminKp, memberKp] = await Promise.all(
    [admin, member].map((account) =>
      generateKeyPackage({
        credential: createCredential(account.pubkey),
        ciphersuiteImpl: impl,
        signer: account.signer,
      }),
    ),
  );
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "real terminal peers",
    { adminPubkeys: [admin.pubkey], relays: ["wss://relay.test"] },
  );
  const context = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const added = await createCommit({
    context,
    state: clientState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
  });
  const memberState = await joinGroup({
    context,
    welcome: added.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { admin, member, impl, adminState: added.newState, memberState };
}

const GROUP_ID = new Uint8Array([1, 2, 3]);
const COMMIT_DIGEST = new Uint8Array(32).fill(4);

describe("disband tombstone", () => {
  const tombstone: DisbandTombstone = {
    groupId: GROUP_ID,
    selectedEpoch: 7,
    commitDigest: COMMIT_DIGEST,
    actorPubkey: "a".repeat(64),
    notificationState: "pending",
  };

  it("uses a namespace distinct from the pending request", () => {
    expect(DISBAND_TOMBSTONE_KEY).toBe("disband/terminal");
  });

  it("round-trips authenticated terminal evidence", () => {
    expect(decodeDisbandTombstone(encodeDisbandTombstone(tombstone))).toEqual(
      tombstone,
    );
  });

  it("round-trips a versioned intent separately from legacy terminal evidence", () => {
    const intent = { tombstone, registryState: new Uint8Array([1, 2, 3]) };
    expect(DISBAND_INTENT_KEY).toBe("disband/intent");
    expect(
      decodeDisbandTerminalIntent(encodeDisbandTerminalIntent(intent)),
    ).toEqual(intent);
    expect(() =>
      decodeDisbandTerminalIntent(new TextEncoder().encode('{"version":2}')),
    ).toThrow();
    expect(() =>
      decodeDisbandTerminalIntent(
        new TextEncoder().encode('{"version":1,"registryState":"xx"}'),
      ),
    ).toThrow();
  });

  it("fails closed on unknown, corrupt, and semantically invalid records", () => {
    const encoder = new TextEncoder();
    expect(() => decodeDisbandTombstone(encoder.encode("not-json"))).toThrow();
    expect(() =>
      decodeDisbandTombstone(
        encoder.encode(
          JSON.stringify({
            version: 2,
            groupId: "010203",
            selectedEpoch: 7,
            commitDigest: "04".repeat(32),
            actorPubkey: "a".repeat(64),
            notificationState: "pending",
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeDisbandTombstone(
        encoder.encode(
          JSON.stringify({
            version: 1,
            groupId: "010203",
            selectedEpoch: -1,
            commitDigest: "04",
            actorPubkey: "not-a-pubkey",
            notificationState: "pending",
          }),
        ),
      ),
    ).toThrow();
  });
});

async function fixture() {
  const account = testAccount(6);
  const pubkey = account.pubkey;
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(pubkey),
    ciphersuiteImpl: impl,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(kp, impl, "terminal", {
    adminPubkeys: [pubkey],
    relays: ["wss://relay.test"],
  });
  const storage = memoryGroupDatabase();
  const network = new MockNetwork(["wss://relay.test"]);
  const group = new MarmotGroup(clientState, {
    database: storage,
    signer: account.signer,
    ciphersuite: impl,
    network,
  });
  return { group, storage, network, pubkey, account };
}

describe("public disband terminal contract", () => {
  it.each(["before", "after"] as const)(
    "records a consumed callback attempt across a notification write crash %s forwarding",
    async (forwarding) => {
      const { group, storage, network, account, pubkey } = await fixture();
      await group.session.persistSelectedDisband({
        actorPubkey: pubkey,
        commitDigest: COMMIT_DIGEST,
        parentTag: "parent",
        sourceEpoch: 0,
        terminalOutcome: "disbanded",
      });
      let armed = true;
      const restore = interceptMeta(storage, async (ops, write) => {
        const hit =
          armed &&
          ops.some(
            (op) =>
              op.type === "set" &&
              op.key === DISBAND_TOMBSTONE_KEY &&
              decodeDisbandTombstone(op.value!).notificationState ===
                "delivered",
          );
        if (hit && forwarding === "before") {
          armed = false;
          throw new Error("notification crash");
        }
        await write();
        if (hit) {
          armed = false;
          throw new Error("notification crash");
        }
      });
      const fault = { mockRestore: restore };
      const liveCallback = vi.fn();
      group.on("disbanded", liveCallback);
      await expect(group.realizeDisbandIfNeeded()).rejects.toThrow(
        "notification crash",
      );
      expect(liveCallback).not.toHaveBeenCalled();
      fault.mockRestore();
      group.dispose();
      for (let restart = 0; restart < 2; restart++) {
        const restored = new MarmotGroup(group.state, {
          database: storage,
          network,
          signer: account.signer,
          ciphersuite: group.ciphersuite,
        });
        const callback = vi.fn();
        restored.on("disbanded", callback);
        await restored.session.hydrateLifecycleEvidence();
        await restored.realizeDisbandIfNeeded();
        expect(restored.status).toBe("disbanded");
        expect(callback).toHaveBeenCalledTimes(
          restart === 0 && forwarding === "before" ? 1 : 0,
        );
        restored.dispose();
      }
    },
  );

  it("WR-02: internally selects disband after a first tombstone write failure", async () => {
    const f = await peers();
    const network = new MockNetwork(["wss://relay.test"]);
    const author = new MarmotGroup(f.adminState, {
      database: memoryGroupDatabase(),
      signer: f.admin.signer,
      ciphersuite: f.impl,
      network,
    });
    const candidate = await author.session.requestDisband();
    const storage = memoryGroupDatabase();
    let failures = 0;
    interceptMeta(storage, async (ops, write) => {
      if (
        ops.some((op) => op.key === DISBAND_TOMBSTONE_KEY) &&
        failures++ === 0
      )
        throw new Error("first tombstone crash");
      return write();
    });
    let now = 0;
    const observedGroup = new MarmotGroup(f.memberState, {
      ciphersuite: f.impl,
      database: storage,
      signer: f.member.signer,
      network,
      now: () => now,
      settlementQuiescenceMs: 1,
      scheduler: { setTimer: () => 0, clearTimer: () => {} },
    });
    const observer = observedGroup.session;
    observedGroup.on("stateChanged", () =>
      expect(observedGroup.status).toBe("disbanded"),
    );
    const removed = vi.fn(),
      disbanded = vi.fn();
    observedGroup.on("removed", removed);
    observedGroup.on("disbanded", disbanded);
    const admitted = [];
    for await (const result of observer.ingest([candidate.publish[0].envelope]))
      admitted.push(result);
    expect(observer.lifecycle).toBe("Recovering");
    now = 1;
    await observer.driveConvergence();
    expect(observer.terminalTombstone?.actorPubkey).toBe(f.admin.pubkey);
    expect(observer.lifecycle).toBe("Disbanded");
    expect(await storage.meta.get(DISBAND_TOMBSTONE_KEY)).toBeUndefined();
    for await (const _ of observer.ingest([])) {
      /* fully drain retry */
    }
    expect(await storage.meta.get(DISBAND_TOMBSTONE_KEY)).toBeDefined();
    for await (const _ of observedGroup.ingest([])) {
      /* fully drain terminal facade activation */
    }
    expect(disbanded).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    await expect(observedGroup.selfUpdate()).rejects.toBeInstanceOf(
      GroupTerminalError,
    );
    author.dispose();
    observedGroup.dispose();
  });

  it("WR-01: malformed cosmetic metadata cannot elect a non-admin to commit an admin departure", async () => {
    const f = await peers();
    for (const state of [f.adminState, f.memberState])
      state.groupContext.extensions = state.groupContext.extensions.map(
        (extension) => {
          const dictionary = getAppDataDictionary([extension]);
          return dictionary
            ? makeAppDataDictionaryExtension(
                dictionary.map((entry) =>
                  entry.componentId === GROUP_PROFILE_COMPONENT_ID
                    ? { ...entry, data: new Uint8Array([255]) }
                    : entry,
                ),
              )
            : extension;
        },
      );
    const observer = new GroupSession({
      state: f.memberState,
      ciphersuite: f.impl,
      database: memoryGroupDatabase(),
    });
    // An active admin's SelfRemove is refused before sending, so build it
    // directly: the observer must neither stage it nor commit it.
    const { message } = await createProposal({
      context: {
        cipherSuite: f.impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: f.adminState,
      wireAsPublicMessage: true,
      proposal: { proposalType: selfRemoveProposalType },
    });
    const envelope = await createGroupEvent({
      message,
      state: f.adminState,
      ciphersuite: f.impl,
    });
    const results = [];
    for await (const result of observer.ingest([envelope]))
      results.push(result);
    expect(results.some((r) => r.kind === "autoCommit")).toBe(false);
    expect(Object.keys(observer.state.unappliedProposals)).toHaveLength(0);
    observer.dispose();
  });

  it.each([false, true])(
    "WR-01: peer self-removal fully drains with pending disband publish failure=%s",
    async (publishFailure) => {
      const f = await peers();
      const storage = memoryGroupDatabase();
      const network = new MockNetwork(["wss://relay.test"]);
      const group = new MarmotGroup(f.adminState, {
        database: storage,
        network,
        signer: f.admin.signer,
        ciphersuite: f.impl,
      });
      const leaver = new GroupSession({
        state: f.memberState,
        ciphersuite: f.impl,
        database: memoryGroupDatabase(),
      });
      if (publishFailure) {
        // An explicit rejecting OK is a definitive failure. A thrown adapter
        // error is now ACK-uncertain and correctly keeps PendingPublish.
        vi.spyOn(network, "publish").mockResolvedValueOnce({
          "wss://relay.test": {
            from: "wss://relay.test",
            ok: false,
            message: "blocked",
          },
        });
        expect(await group.disband()).toMatchObject({ kind: "publishFailed" });
        expect((await group.session.disbandRequest())?.status).toBe("pending");
      }
      const proposal = await leaver.leave(f.member.pubkey);
      const results = [];
      for await (const result of group.ingest([proposal.publish[0].envelope]))
        results.push(result);
      expect(results.some((r) => r.kind === "processed")).toBe(true);
      expect(results.some((r) => r.kind === "autoCommit")).toBe(
        !publishFailure,
      );
      const durable = deserializeClientState(
        (await storage.meta.get("state"))!,
      );
      expect(durable.groupContext.epoch).toBe(group.state.groupContext.epoch);
      if (publishFailure)
        expect(Object.keys(durable.unappliedProposals)).toHaveLength(1);
      else expect(durable.groupContext.epoch).toBe(2n);
      group.dispose();
      leaver.dispose();
    },
  );
  it("keeps the registry shell after a post-intent cleanup crash and survives two restarts", async () => {
    const { group, network, pubkey, account } = await fixture();
    const storage = memoryGroupDatabase();
    let failCleanup = true;
    interceptMeta(storage, async (ops, write) => {
      if (
        failCleanup &&
        ops.some((op) => op.type === "delete" && op.key === "state")
      ) {
        failCleanup = false;
        throw new Error("injected cleanup crash");
      }
      return write();
    });
    const crashing = new MarmotGroup(group.state, {
      database: storage,
      signer: account.signer,
      ciphersuite: group.ciphersuite,
      network,
    });
    await crashing.save(true);
    await expect(
      crashing.session.persistSelectedDisband({
        actorPubkey: pubkey,
        commitDigest: COMMIT_DIGEST,
        parentTag: "parent",
        sourceEpoch: 0,
        terminalOutcome: "disbanded",
      }),
    ).rejects.toThrow("injected cleanup crash");
    // The intent, tombstone and registry shell committed together.
    expect(await storage.meta.get("disband/registry-state")).toBeDefined();
    crashing.dispose();

    const options = {
      database: await clientDatabase(storage, group.idStr),
      signer: account.signer,
      network,
    };
    const first = new GroupRegistry(options);
    expect((await first.get(group.id)).status).toBe("disbanded");
    first.untrack(group.id);
    const second = new GroupRegistry(options);
    expect((await second.get(group.id)).status).toBe("disbanded");
  });

  it("discovers and loads a scrubbed terminal facade after live-state cleanup", async () => {
    const { group, storage, network, pubkey, account } = await fixture();
    await group.session.persistSelectedDisband({
      actorPubkey: pubkey,
      commitDigest: COMMIT_DIGEST,
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });
    expect(await storage.meta.get("state")).toBeUndefined();

    const registry = new GroupRegistry({
      database: await clientDatabase(storage, group.idStr),
      signer: account.signer,
      network,
    });
    expect((await registry.listIds()).map(bytesToHex)).toContain(group.idStr);
    expect(await registry.has(group.id)).toBe(true);
    const restored = await registry.get(group.id);
    expect(restored.status).toBe("disbanded");
    expect(restored.groupData).toBeNull();
    expect(await registry.has(group.id)).toBe(true);
    await expect(restored.selfUpdate()).rejects.toBeInstanceOf(
      GroupTerminalError,
    );
  });

  it("records delivery before emitting once and rejects every outbound intent", async () => {
    const { group, pubkey } = await fixture();
    const digest = new Uint8Array(32).fill(7);
    const seen = vi.fn(() => {
      expect(group.status).toBe("disbanded");
      throw new Error("application callback failure");
    });
    group.on("disbanded", seen);

    await group.session.persistSelectedDisband({
      actorPubkey: pubkey,
      commitDigest: digest,
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });
    await Promise.all([
      group.realizeDisbandIfNeeded(),
      group.realizeDisbandIfNeeded(),
    ]);
    await group.realizeDisbandIfNeeded();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(group, {
      actorPubkey: pubkey,
      commitDigest: digest,
    });
    await expect(
      group.submitIntent({
        kind: "applicationMessage",
        payload: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "group_disbanded" });
    await expect(group.selfUpdate()).rejects.toBeInstanceOf(GroupTerminalError);
    await expect(group.enableDisbanding()).rejects.toMatchObject({
      reason: "group_disbanded",
    });
    await expect(group.disband()).rejects.toMatchObject({
      reason: "group_disbanded",
    });
  });
});
