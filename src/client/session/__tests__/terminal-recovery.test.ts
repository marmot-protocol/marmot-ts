import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { memoryDatabase } from "../../../__tests__/helpers/database.js";
import { groupTreeStore } from "../../storage/database/group-batch.js";
import { instrumentedDatabase, type WriteOp } from "./instrumented-database.js";
import { GroupRegistry } from "../../storage/group-registry.js";
import { GroupTerminalError, MarmotGroup } from "../../group/marmot-group.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../../storage/wrapper-ledger.js";
import { GroupSession } from "../group-session.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import { getEventHash } from "applesauce-core/helpers/event";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import { GroupHistory } from "../../storage/group-history.js";

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
  const database = memoryDatabase();
  const network = new MockNetwork(["wss://relay.test"]);
  const registryOptions = { database, network, signer: account.signer };
  const { database: groupDatabase } = await new GroupRegistry(
    registryOptions,
  ).prepare(clientState);
  // Every session and group in a test shares one observable group database.
  const store = instrumentedDatabase(groupDatabase);
  const options = {
    database: store.db,
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
  return { group, options, registryOptions, store, evidence };
}

describe("terminal persistence interruption", () => {
  // The intent, tombstone and registry shell commit in one atomic batch;
  // cleanup (dropping live state) is a separate, repeatable batch.
  for (const boundary of ["projection", "cleanup"] as const)
    for (const forwarding of ["before", "after"] as const)
      it(`fences live use and restores durable authority ${forwarding} ${boundary}`, async () => {
        const { group, options, registryOptions, store, evidence } =
          await fixture();
        let armed = true;
        const writes: string[] = [];
        const isBoundary = (op: WriteOp) =>
          boundary === "projection"
            ? op.key === "meta:disband/intent"
            : op.type === "delete" && op.key === "meta:state";
        const crashing = new MarmotGroup(group.state, options);
        store.onWrite((op) => {
          // The live fence precedes even the first adapter call.
          expect(crashing.status).toBe("disbanded");
          writes.push(op.key);
          if (armed && forwarding === "before" && isBoundary(op)) {
            armed = false;
            throw new Error("crash");
          }
        });
        store.onCommit((ops) => {
          if (armed && forwarding === "after" && ops.some(isBoundary)) {
            armed = false;
            throw new Error("crash");
          }
        });
        await expect(
          crashing.session.persistSelectedDisband(evidence),
        ).rejects.toThrow("crash");
        expect(crashing.status).toBe("disbanded");
        await expect(crashing.selfUpdate()).rejects.toBeInstanceOf(
          GroupTerminalError,
        );
        expect(writes[0]).toBe("meta:disband/intent");
        store.onWrite(undefined);
        store.onCommit(undefined);
        crashing.dispose();
        group.dispose();
        const expected =
          boundary === "projection" && forwarding === "before"
            ? "active"
            : "disbanded";
        for (let restart = 0; restart < 2; restart++) {
          const registry = new GroupRegistry(registryOptions);
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
    "a live history notification paused across terminal purge cannot resurrect plaintext (notification fails: %s)",
    async (notificationFails) => {
      const { group, options, evidence } = await fixture();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The real history: notifications go through its rumor store.
      const history = GroupHistory.forDatabase(options.database);
      const notify = history.saveMessage.bind(history);
      const saveMessage = vi
        .spyOn(history, "saveMessage")
        .mockImplementation(async (payload) => {
          enter();
          await paused;
          await notify(payload);
          if (notificationFails) throw new Error("notification failed");
        });
      const historyError = vi.fn();
      const session = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        database: options.database,
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
      // The message row commits with the send's save; only the live
      // notification afterwards is paused.
      const sending = session.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      // Terminal selection lands before the send hands off its publication.
      const rejected = expect(sending).rejects.toThrow("Group disbanded");
      await entered;
      expect((await options.database.messages.get(rumor.id))?.id).toBe(
        rumor.id,
      );
      const terminal = session.persistSelectedDisband(evidence);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // Terminal selection fences synchronously, before its cleanup runs.
      expect(session.terminalTombstone).toBeDefined();
      const late = expect(
        session.send({
          kind: "applicationMessage",
          payload: serializeApplicationRumor(rumor),
        }),
      ).rejects.toThrow("Group disbanded");
      release();
      await terminal;
      await late;
      await rejected;
      // The late notification must not write the purged rumor back.
      expect(await options.database.messages.query({})).toEqual([]);
      expect(await options.database.deliveries.withEvidence()).toEqual([]);
      expect(saveMessage).toHaveBeenCalledOnce();
      expect(historyError).toHaveBeenCalledTimes(notificationFails ? 1 : 0);
      session.dispose();
      group.dispose();
    },
  );

  it.each(["before", "after"] as const)(
    "purges plaintext evidence, messages and the tree after a terminal cleanup crash %s forwarding",
    async (forwarding) => {
      const { group, options, store, evidence } = await fixture();
      const shared = options.database;
      const source = new GroupSession({
        state: group.state,
        ciphersuite: options.ciphersuite,
        database: shared,
      });
      const rumor = {
        id: "",
        pubkey: evidence.actorPubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "terminal plaintext",
      };
      rumor.id = getEventHash(rumor);
      await source.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumor),
      });
      await source.save(true);
      const tip = source.state;
      const [row] = await shared.deliveries.withEvidence();
      expect(row?.rumorId).toBe(rumor.id);
      expect((await shared.messages.get(rumor.id))?.id).toBe(rumor.id);
      source.dispose();
      async function restart() {
        const tree = await GroupHistoryTree.load(
          groupTreeStore(shared),
          group.idStr,
        );
        return new GroupSession({
          state: tip,
          ciphersuite: options.ciphersuite,
          database: shared,
          historyTree: tree,
          history: GroupHistory.forDatabase(shared),
        });
      }
      let armed = true;
      const hit = (op: WriteOp) =>
        op.type === "delete" && op.key === `delivery:${row!.id}`;
      store.onWrite((op) => {
        if (armed && forwarding === "before" && hit(op)) {
          armed = false;
          throw new Error("cleanup crash");
        }
      });
      store.onCommit((ops) => {
        if (armed && forwarding === "after" && ops.some(hit)) {
          armed = false;
          throw new Error("cleanup crash");
        }
      });
      const first = await restart();
      await expect(first.persistSelectedDisband(evidence)).rejects.toThrow(
        "cleanup crash",
      );
      expect(armed).toBe(false);
      store.onWrite(undefined);
      store.onCommit(undefined);
      expect(first.terminalTombstone).toBeDefined();
      // A crash before forwarding leaves the evidence for the next attempt.
      expect(await shared.deliveries.withEvidence()).toHaveLength(
        forwarding === "before" ? 1 : 0,
      );
      first.dispose();
      for (let i = 0; i < 2; i++) {
        const restored = await restart();
        await restored.hydrateLifecycleEvidence();
        expect(restored.terminalTombstone).toBeDefined();
        for await (const _ of restored.ingest([])) void _;
        restored.dispose();
      }
      expect(await shared.deliveries.withEvidence()).toEqual([]);
      expect(await shared.messages.query({})).toEqual([]);
      expect(await shared.meta.get("tree")).toBeUndefined();
      expect(await shared.meta.get("disband/terminal")).toBeDefined();
      group.dispose();
    },
  );

  it("keeps authority and unacknowledged effects across terminal ingest", async () => {
    const { group, options, registryOptions, store, evidence } =
      await fixture();
    const shared = options.database;
    const session = new GroupSession({
      state: group.state,
      ciphersuite: options.ciphersuite,
      database: shared,
    });
    await session.save(true);
    const ledger = new ConvergenceEffectLedger(shared);
    await ledger.prepareWithdrawal(evidence.commitDigest, 0, []);
    const wrappers = new TerminalWrapperLedger(shared);
    const completed = "cd".repeat(32);
    await wrappers.record(completed, "accepted", 0);
    await session.persistSelectedDisband(evidence);
    expect(await shared.meta.get("disband/intent")).toBeDefined();
    expect(await shared.meta.get("disband/terminal")).toBeDefined();
    expect(await shared.meta.get("disband/registry-state")).toBeDefined();
    expect(await shared.wrappers.get(completed)).toBeUndefined();
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
        database: shared,
      });
      await restored.hydrateLifecycleEvidence();
      const pending = await restored.driveConvergence();
      expect(pending).toMatchObject([
        { kind: "stateInvalidated", forkEpoch: 0 },
      ]);
      restored.dispose();
    }
    let failAck = true;
    store.onWrite((op) => {
      if (failAck && op.key === "meta:effects") {
        failAck = false;
        throw new Error("ack crash");
      }
    });
    const fault = { mockRestore: () => store.onWrite(undefined) };
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
        database: shared,
      });
      await restored.hydrateLifecycleEvidence();
      expect(await restored.driveConvergence()).toEqual([]);
      expect(await new ConvergenceEffectLedger(shared).pending()).toEqual([]);
      restored.dispose();
    }
    const registry = new GroupRegistry(registryOptions);
    expect((await registry.get(group.id)).status).toBe("disbanded");
    registry.untrack(group.id);
    session.dispose();
    group.dispose();
  });

  it("purges only the records its checkpoint names", async () => {
    const { group, store } = await fixture();
    const shared = store.db;
    const tree = group.session.historyTree;
    expect(await shared.meta.get("tree")).toBeDefined();
    await shared.transaction(async (tx) => {
      await tx.treeNodes.put({ tag: "unrelated", value: new Uint8Array([1]) });
      await tx.meta.set("disband/terminal", new Uint8Array([1]));
      await tx.meta.set("effects", new Uint8Array([1]));
    });
    const treeStore = groupTreeStore(shared);
    await treeStore.commit(await GroupHistoryTree.stagePurge(treeStore));
    expect(await shared.meta.get("tree")).toBeUndefined();
    for (const tag of tree.tags())
      expect(await shared.treeNodes.get(tag)).toBeUndefined();
    expect(await shared.treeNodes.get("unrelated")).toBeDefined();
    expect(await shared.meta.get("disband/terminal")).toBeDefined();
    expect(await shared.meta.get("effects")).toBeDefined();
    expect(await shared.meta.get("state")).toBeDefined();
    group.dispose();
  });
});
