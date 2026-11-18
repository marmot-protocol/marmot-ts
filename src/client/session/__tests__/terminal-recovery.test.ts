import {
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { memoryStorage, type StorageOp } from "../../../utils/storage.js";
import { GroupRegistry } from "../../storage/group-registry.js";
import { GroupTerminalError, MarmotGroup } from "../../group/marmot-group.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../../storage/wrapper-ledger.js";
import { GroupSession } from "../group-session.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../../core/client-state.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../../core/convergence.js";
import { getEventHash } from "applesauce-core/helpers/event";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import {
  encodeDeliveredEvidence,
  decodeDeliveredEvidence,
} from "../../storage/delivered-payload-store.js";

async function fixture() {
  const account = testAccount(6);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    ciphersuiteImpl: ciphersuite,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuite,
    "terminal recovery",
    { adminPubkeys: [account.pubkey], relays: ["wss://relay.test"] },
  );
  const storage = memoryStorage();
  const network = new MockNetwork(["wss://relay.test"]);
  const options = {
    storage,
    network,
    signer: account.signer,
    ciphersuite,
  };
  const group = new MarmotGroup(clientState, options);
  await group.save(true);
  const evidence = {
    actorPubkey: account.pubkey,
    commitDigest: new Uint8Array(32).fill(4),
    parentTag: "parent",
    sourceEpoch: 0,
    terminalOutcome: "disbanded" as const,
  };
  return { group, options, evidence };
}

describe("terminal persistence interruption", () => {
  // The intent, tombstone and registry shell commit in one atomic batch;
  // cleanup (dropping live state) is a separate, repeatable batch.
  for (const boundary of ["projection", "cleanup"] as const)
    for (const forwarding of ["before", "after"] as const)
      it(`fences live use and restores durable authority ${forwarding} ${boundary}`, async () => {
        const { group, options, evidence } = await fixture();
        const storage = options.storage;
        let armed = true;
        const writes: string[] = [];
        const isBoundary = (ops: readonly StorageOp[]) =>
          boundary === "projection"
            ? ops.some((op) => op.key.endsWith("/disband/intent/v1"))
            : ops.some(
                (op) =>
                  op.type === "delete" && op.key === `${group.idStr}/state`,
              );
        const faultStorage = {
          get: (key: string) => storage.get(key),
          list: (prefix: string) => storage.list(prefix),
          set: async (key: string, value: Uint8Array) => {
            expect(crashing.status).toBe("disbanded");
            writes.push(key);
            await storage.set(key, value);
          },
          delete: async (key: string) => {
            expect(crashing.status).toBe("disbanded");
            writes.push(key);
            await storage.delete(key);
          },
          batch: async (ops: readonly StorageOp[]) => {
            // The live fence precedes even the first adapter call.
            expect(crashing.status).toBe("disbanded");
            writes.push(...ops.map((op) => op.key));
            const hit = armed && isBoundary(ops);
            if (hit && forwarding === "before") {
              armed = false;
              throw new Error("crash");
            }
            await storage.batch(ops);
            if (hit) {
              armed = false;
              throw new Error("crash");
            }
          },
        };
        const crashing = new MarmotGroup(group.state, {
          ...options,
          storage: faultStorage,
        });
        await expect(
          crashing.session.persistSelectedDisband(evidence),
        ).rejects.toThrow("crash");
        expect(crashing.status).toBe("disbanded");
        await expect(crashing.selfUpdate()).rejects.toBeInstanceOf(
          GroupTerminalError,
        );
        expect(writes[0]).toBe(`${group.idStr}/disband/intent/v1`);
        crashing.dispose();
        group.dispose();
        const expected =
          boundary === "projection" && forwarding === "before"
            ? "active"
            : "disbanded";
        for (let restart = 0; restart < 2; restart++) {
          const registry = new GroupRegistry(options);
          const restored = await registry.get(group.id);
          expect(restored.status).toBe(expected);
          if (expected === "disbanded")
            await expect(restored.selfUpdate()).rejects.toBeInstanceOf(
              GroupTerminalError,
            );
          registry.untrack(group.id);
        }
      });
});

describe("terminal work ownership", () => {
  it.each([false, true])(
    "settles an admitted history save before terminal purge (throws after forwarding: %s)",
    async (throwAfterForwarding) => {
      const { group, options, evidence } = await fixture();
      let enter!: () => void;
      let release!: () => void;
      let reachCleanup!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cleanupReached = new Promise<void>((resolve) => {
        reachCleanup = resolve;
      });
      const rows: Uint8Array[] = [];
      const history = {
        saveMessage: vi.fn(async (payload: Uint8Array) => {
          enter();
          await paused;
          rows.push(payload.slice());
          if (throwAfterForwarding)
            throw new Error("save forwarded before failure");
        }),
        purgeMessages: vi.fn(async () => {
          rows.length = 0;
        }),
        removeMessage: vi.fn(async () => {}),
      };
      const batch = options.storage.batch.bind(options.storage);
      const cleanup = vi
        .spyOn(options.storage, "batch")
        .mockImplementation(async (ops) => {
          await batch(ops);
          if (
            ops.some(
              (op) => op.type === "delete" && op.key === `${group.idStr}/state`,
            )
          )
            reachCleanup();
        });
      const historyError = vi.fn();
      const session = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        storage: options.storage,
        history,
        onHistoryError: historyError,
      });
      const rumor = {
        id: "",
        pubkey: evidence.actorPubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "admitted plaintext",
      };
      rumor.id = getEventHash(rumor);
      const sending = session.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      const rejected = expect(sending).rejects.toThrow("Group disbanded");
      await entered;
      let terminalComplete = false;
      const terminal = session.persistSelectedDisband(evidence).then(() => {
        terminalComplete = true;
      });
      try {
        await cleanupReached;
        // Give every unblocked continuation a turn; cleanup must remain behind
        // the paused adapter, rather than purging first and accepting its row later.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(session.terminalTombstone).toBeDefined();
        expect(terminalComplete).toBe(false);
        expect(history.purgeMessages).not.toHaveBeenCalled();
        await expect(
          session.send({
            kind: "applicationMessage",
            payload: serializeApplicationRumor(rumor),
          }),
        ).rejects.toThrow("Group disbanded");
        expect(history.saveMessage).toHaveBeenCalledOnce();
      } finally {
        release();
        await terminal;
        await rejected;
        cleanup.mockRestore();
        session.dispose();
        group.dispose();
      }
      expect(terminalComplete).toBe(true);
      expect(history.purgeMessages).toHaveBeenCalledOnce();
      expect(rows).toEqual([]);
      expect(historyError).toHaveBeenCalledTimes(throwAfterForwarding ? 1 : 0);
    },
  );

  it.each(["before", "after"] as const)(
    "keeps pending retraction provenance across two restarts and an acknowledgement crash %s forwarding",
    async (forwarding) => {
      const { group, options, evidence } = await fixture();
      const shared = options.storage;
      const source = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        storage: shared,
      });
      const rumor = {
        id: "",
        pubkey: options.signer
          ? await options.signer.getPublicKey()
          : evidence.actorPubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "terminal retraction",
      };
      rumor.id = getEventHash(rumor);
      await source.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      await source.save(true);
      const deliveredKey = `${group.idStr}/ingest/delivered`;
      const delivered = decodeDeliveredEvidence(
        (await shared.get(deliveredKey))!,
        source.historyTree,
      );
      expect(delivered.entries).toHaveLength(1);
      await shared.set(
        deliveredKey,
        encodeDeliveredEvidence({ entries: [], pending: delivered.entries }),
      );
      // Age the genuine producing state outside a finite horizon before
      // terminal selection. Pending withdrawal owns the old snapshot/edge,
      // independently of the absorbing terminal authority.
      let retainedTip = source.state;
      const retainedTree = source.historyTree;
      source.dispose();
      for (let epoch = 0; epoch < 3; epoch++) {
        const next = await createCommit({
          context: {
            cipherSuite: options.ciphersuite,
            authService: unsafeTestingAuthenticationService,
          },
          state: deserializeClientState(serializeClientState(retainedTip)),
          extraProposals: [],
          wireAsPublicMessage: true,
        });
        retainedTree.recordCommit(
          bytesToHex(retainedTip.confirmationTag),
          next.commit,
          next.newState,
        );
        retainedTip = next.newState;
      }
      await retainedTree.publishRetention(
        await retainedTree.prepareRetention({
          canonicalTipTag: bytesToHex(retainedTip.confirmationTag),
          maxRewindCommits: 1,
          appPayloadPastEpochLimit: 1,
          pins: delivered.entries.map((entry) => ({
            stateTag: entry.stateTag,
            reason: "retraction" as const,
          })),
        }),
      );
      await retainedTree.resumeRetentionCleanup();
      await shared.set(
        `${group.idStr}/state`,
        serializeClientState(retainedTip),
      );
      let historyFails = true;
      const rows = new Set([rumor.id]);
      const history = {
        saveMessage: vi.fn(async () => {}),
        purgeMessages: vi.fn(async () => {
          rows.clear();
        }),
        removeMessage: vi.fn(async (id: string) => {
          if (historyFails) throw new Error("history unavailable");
          rows.delete(id);
        }),
      };
      async function restart() {
        const tree = await GroupHistoryTree.load(shared, group.idStr);
        expect(tree).toBeDefined();
        return new GroupSession({
          state: retainedTip,
          ciphersuite: options.ciphersuite,
          storage: shared,
          historyTree: tree,
          convergencePolicy: {
            ...DEFAULT_CONVERGENCE_POLICY,
            maxRewindCommits: 1,
            appPayloadPastEpochLimit: 1,
          },
          history,
        });
      }
      const first = await restart();
      await first.persistSelectedDisband(evidence);
      expect(
        decodeDeliveredEvidence(
          (await shared.get(deliveredKey))!,
          first.historyTree,
        ).pending,
      ).toHaveLength(1);
      first.dispose();
      for (let i = 0; i < 2; i++) {
        const restored = await restart();
        await restored.hydrateLifecycleEvidence();
        expect(restored.terminalTombstone).toBeDefined();
        expect(
          decodeDeliveredEvidence(
            (await shared.get(deliveredKey))!,
            restored.historyTree,
          ).pending,
        ).toHaveLength(1);
        expect(await shared.get(`${group.idStr}/tree/meta`)).toBeDefined();
        expect(
          restored.historyTree.epochOf(delivered.entries[0].stateTag),
        ).toBe(0);
        expect(
          await restored.historyTree.stateAt(delivered.entries[0].stateTag),
        ).toBeDefined();
        expect(restored.historyTree.size).toBe(4);
        expect(history.purgeMessages).not.toHaveBeenCalled();
        restored.dispose();
      }
      const acknowledging = await restart();
      await acknowledging.hydrateLifecycleEvidence();
      historyFails = false;
      let armed = true;
      const write = shared.batch.bind(shared);
      const fault = vi
        .spyOn(shared, "batch")
        .mockImplementation(async (ops) => {
          const hit = armed && ops.some((op) => op.key === deliveredKey);
          if (hit && forwarding === "before") {
            armed = false;
            throw new Error("ack crash");
          }
          await write(ops);
          if (hit) {
            armed = false;
            throw new Error("ack crash");
          }
        });
      for await (const _ of acknowledging.ingest([])) {
        /* fully drain acknowledgement attempt */
      }
      fault.mockRestore();
      expect(rows.has(rumor.id)).toBe(false);
      expect(
        decodeDeliveredEvidence(
          (await shared.get(deliveredKey))!,
          acknowledging.historyTree,
        ).pending,
      ).toHaveLength(forwarding === "before" ? 1 : 0);
      acknowledging.dispose();
      const final = await restart();
      await final.hydrateLifecycleEvidence();
      for await (const _ of final.ingest([])) {
        /* retry any surviving acknowledgement */
      }
      expect(await shared.get(deliveredKey)).toBeUndefined();
      expect(await shared.get(`${group.idStr}/tree/meta`)).toBeUndefined();
      expect(await shared.get(`${group.idStr}/disband/terminal`)).toBeDefined();
      final.dispose();
      group.dispose();
    },
  );

  it("keeps authority and unacknowledged effects across terminal ingest", async () => {
    const { group, options, evidence } = await fixture();
    const shared = options.storage;
    const session = new GroupSession({
      state: group.state,
      ciphersuite: options.ciphersuite,
      storage: shared,
    });
    await session.save(true);
    const ledger = new ConvergenceEffectLedger(shared, group.idStr);
    await ledger.prepareWithdrawal(evidence.commitDigest, 0, []);
    const wrappers = new TerminalWrapperLedger(shared, group.idStr);
    const completed = "cd".repeat(32);
    await wrappers.record(completed, "accepted", 0);
    await shared.set(`${group.idStr}/application-owned`, new Uint8Array([7]));
    await session.persistSelectedDisband(evidence);
    expect(await shared.get(`${group.idStr}/disband/intent/v1`)).toBeDefined();
    expect(await shared.get(`${group.idStr}/disband/terminal`)).toBeDefined();
    expect(
      await shared.get(`${group.idStr}/disband/registry-state`),
    ).toBeDefined();
    expect(
      await shared.get(`${group.idStr}/ingest/wrapper/${completed}`),
    ).toBeUndefined();
    expect(await shared.get(`${group.idStr}/application-owned`)).toEqual(
      new Uint8Array([7]),
    );
    const results = [];
    for await (const result of session.ingest([])) results.push(result);
    expect(results).toMatchObject([{ kind: "stateInvalidated", forkEpoch: 0 }]);
    const effect = results[0];
    if (effect.kind !== "stateInvalidated")
      throw new Error("expected pending withdrawal");
    // Callback attempts/activation cannot consume an application's effect ack.
    for (let restart = 0; restart < 2; restart++) {
      const restored = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        storage: shared,
      });
      await restored.hydrateLifecycleEvidence();
      const pending = await restored.driveConvergence();
      expect(pending).toMatchObject([
        { kind: "stateInvalidated", forkEpoch: 0 },
      ]);
      restored.dispose();
    }
    const fault = vi
      .spyOn(shared, "set")
      .mockRejectedValueOnce(new Error("ack crash"));
    await expect(session.acknowledgeConvergenceEffect(effect)).rejects.toThrow(
      "ack crash",
    );
    fault.mockRestore();
    expect(await ledger.pending()).toHaveLength(1);
    await session.acknowledgeConvergenceEffect(effect);
    expect(await ledger.pending()).toEqual([]);
    for (let restart = 0; restart < 2; restart++) {
      const restored = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        storage: shared,
      });
      await restored.hydrateLifecycleEvidence();
      expect(await restored.driveConvergence()).toEqual([]);
      expect(
        await new ConvergenceEffectLedger(shared, group.idStr).pending(),
      ).toEqual([]);
      expect(await shared.get(`${group.idStr}/application-owned`)).toEqual(
        Uint8Array.of(7),
      );
      restored.dispose();
    }
    const registry = new GroupRegistry(options);
    expect((await registry.get(group.id)).status).toBe("disbanded");
    registry.untrack(group.id);
    session.dispose();
    group.dispose();
  });

  it("purges only tree-owned keys within the group keyspace", async () => {
    const shared = memoryStorage();
    const gid = "ab".repeat(16);
    for (const suffix of [
      "tree/meta",
      "tree/edge/node",
      "tree/state/node",
      "tree/commit/node",
      "tree-adjacent",
      "disband/terminal",
      "ingest/effect/pending",
      "application-owned",
    ])
      await shared.set(`${gid}/${suffix}`, new Uint8Array([1]));
    await shared.set(`other/tree/meta`, new Uint8Array([1]));
    await GroupHistoryTree.purge(shared, gid);
    expect(await shared.list("")).toEqual([
      `${gid}/application-owned`,
      `${gid}/disband/terminal`,
      `${gid}/ingest/effect/pending`,
      `${gid}/tree-adjacent`,
      "other/tree/meta",
    ]);
  });
});
