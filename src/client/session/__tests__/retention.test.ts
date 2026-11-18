import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash } from "applesauce-core/helpers/event";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import {
  decodeDeliveredEvidence,
  encodeDeliveredEvidence,
} from "../../storage/delivered-payload-store.js";
import {
  appDataUpdateProposalType,
  defaultCryptoProvider,
  defaultProposalTypes,
  selfRemoveProposalType,
  createCommit,
  joinGroup,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { GroupRuntime } from "../../runtime/group-runtime.js";
import { linkPublicationRetention } from "../../runtime/publication-retention.js";
import { NostrWelcomeDelivery } from "../../transport/nostr/welcome-delivery.js";
import { NostrGroupPeeler } from "../../group/nostr-peeler.js";
import { createGroupEvent } from "../../../core/group-message.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../../core/convergence.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { encodeAdminPolicyV1 } from "../../../core/components/admin-policy.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../../core/components/ids.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { deserializeClientState } from "../../../core/client-state.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import { contentDedupId } from "../../../engine/message-dedup.js";
import { marmotAuthService } from "../../../core/auth-service.js";
import {
  memoryStorage,
  type MemoryStorage,
  type StorageOp,
} from "../../../utils/storage.js";
import {
  GroupSession,
  type GroupSessionHistory,
  type GroupSessionOptions,
} from "../group-session.js";

async function fixture(
  horizon = 1,
  hooks: Pick<
    GroupSessionOptions,
    "scheduler" | "onSettleCheck" | "onHistoryError" | "audit" | "auditContext"
  > & { history?: GroupSessionHistory } = {},
) {
  const account = testAccount(6);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    ciphersuiteImpl: ciphersuite,
  });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuite,
    "Retention",
    {
      adminPubkeys: [account.pubkey],
      relays: ["wss://relay.test"],
    },
  );
  const storage = memoryStorage();
  let now = 0;
  const options = {
    storage,
    ciphersuite,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits: horizon,
      appPayloadPastEpochLimit: horizon,
    },
    now: () => now,
    settlementQuiescenceMs: 1,
    ...hooks,
  };
  const session = new GroupSession({ ...options, state: clientState });
  const network = new MockNetwork(["wss://relay.test"]);
  const runtime = new GroupRuntime({
    welcomeDelivery: new NostrWelcomeDelivery({
      signer: account.signer,
      network,
    }),
    getNetwork: () => network,
    getRelays: () => ["wss://relay.test"],
    getGroupRef: () => bytesToHex(session.id),
    getGroupData: () => session.groupData,
    confirmPublished: (pending) => session.confirmPublished(pending),
    publishFailed: (pending) => session.publishFailed(pending),
    save: () => session.save(),
  });
  linkPublicationRetention(runtime, session);
  const advance = async (save = true) => {
    const result = await session.send({ kind: "selfUpdate" });
    const work = result.publish[0];
    if (work.kind !== "selfUpdate") throw new Error("expected update");
    session.confirmPublished(work.pending);
    if (save) await session.save(true);
  };
  const settle = async () => {
    now += 100;
    await session.driveConvergence();
  };
  return {
    session,
    options,
    storage,
    advance,
    settle,
    runtime,
    network,
    tick: () => {
      now += 100;
    },
  };
}

/**
 * Adds a second member and makes it the only admin in one commit, so the
 * fixture's account can leave: an active admin's SelfRemove is refused.
 */
async function handOffAdmin(f: Awaited<ReturnType<typeof fixture>>) {
  const member = testAccount(11);
  const memberKp = await generateKeyPackage({
    credential: createCredential(member.pubkey),
    signer: member.signer,
    ciphersuiteImpl: f.options.ciphersuite,
  });
  const addWork = (
    await f.session.send({
      kind: "commit",
      actorPubkey: testAccount(6).pubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
            operation: "update",
            update: encodeAdminPolicyV1([member.pubkey]),
          },
        },
      ],
    })
  ).publish[0];
  if (addWork.kind !== "groupEvolution" || !addWork.welcome)
    throw new Error("expected Welcome");
  await f.runtime.publishWork(addWork);
  const context = {
    cipherSuite: f.options.ciphersuite,
    authService: marmotAuthService,
  };
  const peerState = await joinGroup({
    context,
    welcome: addWork.welcome.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { context, peerState };
}

/**
 * Routes every `set` and `batch` on `storage` through `handle`, which receives
 * the ops being written and a callback that performs the write. Returns a
 * function restoring the original methods.
 */
function interceptWrites(
  storage: MemoryStorage,
  handle: (
    ops: readonly StorageOp[],
    write: () => Promise<void>,
  ) => Promise<void>,
): () => void {
  const set = storage.set.bind(storage);
  const batch = storage.batch.bind(storage);
  storage.set = (key, value) =>
    handle([{ type: "set", key, value }], () => set(key, value));
  storage.batch = (ops) => handle(ops, () => batch(ops));
  return () => {
    storage.set = set;
    storage.batch = batch;
  };
}

/** A tree checkpoint (`meta` version 2) and how much garbage it names. */
function checkpointGarbage(op: StorageOp): number | undefined {
  if (op.type !== "set" || !op.key.endsWith("/tree/meta") || op.value[0] !== 2)
    return undefined;
  return JSON.parse(new TextDecoder().decode(op.value.slice(1))).garbage.length;
}

/**
 * Classifies one atomic write of a session save/retention pass:
 * - `commit`: tree nodes + canonical state + delivered evidence (one batch);
 * - `checkpoint`: the retention authority naming garbage to remove;
 * - `cleanup`: garbage deletion + the clean checkpoint (one batch).
 * Other writes (e.g. a bare tree flush) are not classified.
 */
function classifyWrite(
  ops: readonly StorageOp[],
  id: string,
): "commit" | "checkpoint" | "cleanup" | undefined {
  if (ops.some((op) => op.key === `${id}/state`)) return "commit";
  if (
    ops.some((op) => op.type === "delete" && op.key.startsWith(`${id}/tree/`))
  )
    return "cleanup";
  if (ops.some((op) => (checkpointGarbage(op) ?? 0) > 0)) return "checkpoint";
  return undefined;
}

describe("settled session retention", () => {
  it("releases an unpublished application pin after send persistence rejects without reusing its sender generation", async () => {
    const f = await fixture();
    const event = {
      pubkey: testAccount(6).pubkey,
      created_at: 1,
      kind: 9,
      tags: [],
      content: "unpublished",
    };
    const failure = vi
      .spyOn(f.storage, "batch")
      .mockRejectedValueOnce(new Error("send persistence failed"));
    const original = NostrGroupPeeler.prototype.wrapGroupMessage;
    const identities: string[] = [];
    const wrapping = vi
      .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
      .mockImplementation(async function (
        this: NostrGroupPeeler,
        ...[message, state, metadata]: Parameters<
          NostrGroupPeeler["wrapGroupMessage"]
        >
      ) {
        identities.push(contentDedupId(message));
        return original.call(this, message, state, metadata);
      });
    try {
      await expect(
        f.session.send({
          kind: "applicationMessage",
          payload: serializeApplicationRumor({
            ...event,
            id: getEventHash(event),
          }),
        }),
      ).rejects.toThrow("send persistence failed");
      failure.mockRestore();
      const retried = (
        await f.session.send({
          kind: "applicationMessage",
          payload: serializeApplicationRumor({
            ...event,
            id: getEventHash(event),
          }),
        })
      ).publish[0];
      expect(identities).toHaveLength(2);
      expect(identities[0]).not.toBe(identities[1]);
      await f.runtime.publishApplication(retried.envelope);
      for (let step = 0; step < 4; step++) await f.advance();
      expect(f.session.state.groupContext.epoch).toBe(4n);
      expect(f.session.historyTree.oldestEpoch()).toBe(3);
      expect(f.session.historyTree.size).toBe(2);
    } finally {
      failure.mockRestore();
      wrapping.mockRestore();
      f.session.dispose();
    }
  });

  it.each(["before wrapping", "after pending staging"] as const)(
    "releases only rejected Commit preparation %s",
    async (boundary) => {
      const controller = new AbortController();
      let staged = false;
      const f = await fixture(1, {
        audit: {
          record(event) {
            if (
              event.kind.type === "send_outcome" &&
              event.kind.intent_kind === "group_evolution"
            ) {
              staged = true;
              controller.abort();
            }
          },
        },
        auditContext: { engineId: "preparation-cancellation" },
      });
      const wrapping = vi.spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage");
      try {
        if (boundary === "before wrapping") controller.abort();
        await expect(
          f.session.send({
            kind: "commit",
            actorPubkey: testAccount(6).pubkey,
            signal: controller.signal,
          }),
        ).rejects.toThrow();
        expect(staged).toBe(boundary === "after pending staging");
        expect(wrapping).toHaveBeenCalledTimes(
          boundary === "before wrapping" ? 0 : 1,
        );
        wrapping.mockRestore();
        expect(f.session.lifecycle).toBe("Stable");
        for (let step = 0; step < 4; step++) await f.advance();
        expect(f.session.historyTree.oldestEpoch()).toBe(3);
        expect(f.session.historyTree.size).toBe(2);
      } finally {
        wrapping.mockRestore();
        f.session.dispose();
      }
    },
  );

  it("isolates rejected preparation from concurrent, returned and foreign-owner publications and late acknowledgements", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const returned = (
      await f.session.send({
        kind: "applicationMessage",
        payload: new Uint8Array([1]),
      })
    ).publish[0];
    let appEntered!: () => void, releaseApp!: () => void;
    let commitEntered!: () => void, releaseCommit!: () => void;
    const appStarted = new Promise<void>((resolve) => {
      appEntered = resolve;
    });
    const appGate = new Promise<void>((resolve) => {
      releaseApp = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const original = NostrGroupPeeler.prototype.wrapGroupMessage;
    let calls = 0;
    let rejectedEnvelope: NostrEvent | undefined;
    const wrapping = vi
      .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
      .mockImplementation(async function (
        this: NostrGroupPeeler,
        ...[message, state, metadata]: Parameters<
          NostrGroupPeeler["wrapGroupMessage"]
        >
      ) {
        const call = ++calls;
        if (call === 1) {
          appEntered();
          await appGate;
        }
        if (call === 2) {
          commitEntered();
          await commitGate;
        }
        const envelope = await original.call(this, message, state, metadata);
        if (call === 2) rejectedEnvelope = envelope;
        return envelope;
      });
    const controller = new AbortController();
    const concurrent = f.session.send({
      kind: "applicationMessage",
      payload: new Uint8Array([2]),
    });
    try {
      await appStarted;
      const rejected = expect(
        f.session.send({
          kind: "commit",
          actorPubkey: testAccount(6).pubkey,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      await commitStarted;
      controller.abort();
      releaseCommit();
      await rejected;
      const echoes = [];
      for await (const result of f.session.ingest([rejectedEnvelope!]))
        echoes.push(result);
      expect(echoes).toMatchObject([{ kind: "skipped", reason: "self-echo" }]);
      for (let step = 0; step < 4; step++) await f.advance();
      expect(f.session.historyTree.size).toBe(5);
      releaseApp();
      const other = (await concurrent).publish[0];
      await f.runtime.publishApplication(returned.envelope);
      await f.session.save(true);
      expect(f.session.historyTree.size).toBe(5);
      // Repeated genuine acknowledgement of old work cannot release a newer
      // record, and another runtime's acknowledgement cannot cross owners.
      await f.runtime.publishApplication(returned.envelope);
      await foreign.runtime.publishApplication(other.envelope);
      await f.session.save(true);
      expect(f.session.historyTree.size).toBe(5);
      await f.runtime.publishApplication(other.envelope);
      await f.session.save(true);
      expect(f.session.historyTree.oldestEpoch()).toBe(3);
      expect(f.session.historyTree.size).toBe(2);
    } finally {
      releaseApp();
      releaseCommit();
      await concurrent;
      wrapping.mockRestore();
      f.session.dispose();
      foreign.session.dispose();
    }
  });

  it("releases a commit pin when cancellation arrives during real wrapping", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = NostrGroupPeeler.prototype.wrapGroupMessage;
    const wrapped: string[] = [];
    const spy = vi
      .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
      .mockImplementationOnce(async function (
        this: NostrGroupPeeler,
        ...[message, state, metadata]: Parameters<
          NostrGroupPeeler["wrapGroupMessage"]
        >
      ) {
        entered();
        await gate;
        const event = await original.call(this, message, state, metadata);
        wrapped.push(event.id);
        return event;
      });
    const controller = new AbortController();
    try {
      const rejected = expect(
        f.session.send({
          kind: "commit",
          actorPubkey: testAccount(6).pubkey,
          extraProposals: [],
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      await started;
      controller.abort();
      release();
      await rejected;
      expect(wrapped).toHaveLength(1);
      spy.mockRestore();
      expect(f.session.lifecycle).toBe("Stable");
      for (let step = 0; step < 4; step++) await f.advance();
      expect(f.session.state.groupContext.epoch).toBe(4n);
      expect(f.session.historyTree.oldestEpoch()).toBe(3);
      expect(f.session.historyTree.size).toBe(2);
    } finally {
      release();
      spy.mockRestore();
      f.session.dispose();
    }
  });

  it.each(["leave", "send"] as const)(
    "releases a conclusively failed %s publication pin",
    async (mode) => {
      const f = await fixture();
      try {
        await handOffAdmin(f);
        const effects =
          mode === "leave"
            ? await f.session.leave(testAccount(6).pubkey)
            : await f.session.send({
                kind: "proposal",
                proposal: { proposalType: selfRemoveProposalType },
              });
        for (const work of effects.publish) {
          if (work.kind !== "proposal")
            throw new Error("expected self-remove proposal");
          expect(work.pending.commitMessage).toBeUndefined();
          f.session.publishFailed(work.pending);
        }
        for (let step = 0; step < 6; step++) {
          await f.advance();
          if (step >= 1) {
            // The admin hand-off commit is epoch 1.
            expect(f.session.historyTree.oldestEpoch()).toBe(step + 1);
            expect(f.session.historyTree.size).toBe(2);
          }
        }
      } finally {
        f.session.dispose();
      }
    },
  );

  it.each(["acknowledged", "failed", "confirmed"] as const)(
    "releases a genuine %s leave proposal through its session or owned runtime",
    async (outcome) => {
      const f = await fixture();
      try {
        const { context, peerState: joined } = await handOffAdmin(f);
        let peerState = joined;
        const effects = await f.session.leave(testAccount(6).pubkey);
        const work = effects.publish[0];
        if (work.kind !== "proposal")
          throw new Error("expected self-remove proposal");
        // Exercise real wrapping and the actual runtime -> owner bridge; only
        // transport failure is injected, with no synthetic acknowledgement.
        if (outcome === "failed") {
          f.network.publish = async () => {
            throw new Error("proposal transport failed");
          };
          await expect(f.runtime.publishWork(work)).rejects.toThrow(
            "proposal transport failed",
          );
        } else if (outcome === "acknowledged") {
          await f.runtime.publishWork(work);
          expect(
            f.network.events.some((event) => event.id === work.envelope.id),
          ).toBe(true);
          expect(Object.keys(f.session.state.unappliedProposals)).toHaveLength(
            1,
          );
        } else {
          // A custom effect orchestrator confirms the returned pending object
          // directly, without the runtime's event-ID acknowledgement bridge.
          f.session.confirmPublished(work.pending);
          expect(Object.keys(f.session.state.unappliedProposals)).toHaveLength(
            1,
          );
        }
        for (let step = 0; step < 4; step++) {
          // Another member may commit without the just-published proposal. This
          // genuine competing source clears the staged proposal on advancement;
          // the leaver never commits its own self_remove.
          const next = await createCommit({
            context,
            state: peerState,
            wireAsPublicMessage: true,
            extraProposals: [],
          });
          const event = await createGroupEvent({
            message: next.commit,
            state: peerState,
            ciphersuite: f.options.ciphersuite,
          });
          for await (const _ of f.session.ingest([event])) void _;
          peerState = next.newState;
          await f.session.save(true);
        }
        await f.settle();
        await f.session.save(true);
        expect(f.session.state.groupContext.epoch).toBe(5n);
        expect(f.session.historyTree.oldestEpoch()).toBe(4);
        expect(f.session.historyTree.size).toBe(2);
      } finally {
        f.session.dispose();
      }
    },
  );

  it("drops completed delivery evidence without wiping caller payloads or expiring application history", async () => {
    const opaqueHistory = Uint8Array.of(255, 0, 128, 195, 40);
    const rows = new Map<string, Uint8Array>([
      ["app-owned-without-epoch", opaqueHistory],
    ]);
    let saved = 0;
    const history = {
      saveMessage: vi.fn(async (bytes: Uint8Array) => {
        rows.set(`sent-${saved++}`, bytes);
      }),
      removeMessage: vi.fn(async (id: string) => {
        rows.delete(id);
      }),
      purgeMessages: vi.fn(async () => {
        rows.clear();
      }),
    };
    const f = await fixture(1, { history });
    const payload = Uint8Array.of(0, 255, 128, 195, 40, 240, 159, 152, 128);
    const original = payload.slice();
    const work = (await f.session.send({ kind: "applicationMessage", payload }))
      .publish[0]!;
    const rumor = {
      id: "",
      pubkey: testAccount(6).pubkey,
      created_at: 1,
      kind: 9,
      tags: [],
      content: "é/e\u0301/😀/\u0000",
    };
    rumor.id = getEventHash(rumor);
    const rumorPayload = serializeApplicationRumor(rumor);
    const originalRumor = rumorPayload.slice();
    const rumorWork = (
      await f.session.send({
        kind: "applicationMessage",
        payload: rumorPayload,
      })
    ).publish[0]!;
    const id = bytesToHex(f.session.id);
    const key = `${id}/ingest/delivered`;
    expect(
      decodeDeliveredEvidence(
        (await f.storage.get(key))!,
        f.session.historyTree,
      ).entries,
    ).toHaveLength(1);
    expect(
      decodeDeliveredEvidence(
        (await f.storage.get(key))!,
        f.session.historyTree,
      ).entries[0]!.payload,
    ).toEqual(rumorPayload);
    expect(rows.get("sent-0")).toBe(payload);
    expect(rows.get("sent-1")).toBe(rumorPayload);
    await f.runtime.publishApplication(work.envelope);
    await f.runtime.publishApplication(rumorWork.envelope);
    for (let epoch = 0; epoch < 8; epoch++) await f.advance();
    expect(f.session.historyTree.size).toBe(2);
    expect(
      decodeDeliveredEvidence(
        (await f.storage.get(key))!,
        f.session.historyTree,
      ).entries,
    ).toEqual([]);
    expect(payload).toEqual(original);
    expect(rumorPayload).toEqual(originalRumor);
    expect(opaqueHistory).toEqual(Uint8Array.of(255, 0, 128, 195, 40));
    expect(history.saveMessage).toHaveBeenCalledTimes(2);
    expect(history.removeMessage).not.toHaveBeenCalled();
    expect(history.purgeMessages).not.toHaveBeenCalled();
    expect(rows.size).toBe(3);
    f.session.dispose();
    const restarted = new GroupSession({
      ...f.options,
      state: deserializeClientState((await f.storage.get(`${id}/state`))!),
      historyTree: (await GroupHistoryTree.load(f.storage, id))!,
    });
    await restarted.save(true);
    expect(rows.get("sent-0")).toBe(payload);
    expect(rows.get("sent-1")).toBe(rumorPayload);
    expect(payload).toEqual(original);
    expect(rumorPayload).toEqual(originalRumor);
    expect(history.removeMessage).not.toHaveBeenCalled();
    expect(history.purgeMessages).not.toHaveBeenCalled();
    restarted.dispose();
  });
  for (const mode of ["success", "failure", "concurrent"] as const)
    it(`automatically saves after scheduled convergence callback releases admission: ${mode}`, async () => {
      let callback: (() => void) | undefined;
      let entered!: () => void, release!: () => void, completed!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completion = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const errors = vi.fn();
      let f!: Awaited<ReturnType<typeof fixture>>;
      f = await fixture(1, {
        scheduler: {
          setTimer(_ms, cb) {
            callback = cb;
            return 1;
          },
          clearTimer() {},
        },
        onHistoryError: errors,
        onSettleCheck: async () => {
          entered();
          if (mode === "concurrent") await gate;
          await f.session.driveConvergence();
          completed();
        },
      });
      const member = testAccount(11);
      const kp = await generateKeyPackage({
        credential: createCredential(member.pubkey),
        signer: member.signer,
        ciphersuiteImpl: f.options.ciphersuite,
      });
      const addition = (
        await f.session.send({
          kind: "commit",
          actorPubkey: testAccount(6).pubkey,
          extraProposals: [
            {
              proposalType: defaultProposalTypes.add,
              add: { keyPackage: kp.publicPackage },
            },
          ],
        })
      ).publish[0];
      if (addition.kind !== "groupEvolution" || !addition.welcome)
        throw new Error("expected welcome");
      f.session.confirmPublished(addition.pending);
      const memberState = await joinGroup({
        context: {
          cipherSuite: f.options.ciphersuite,
          authService: marmotAuthService,
        },
        welcome: addition.welcome.welcome,
        keyPackage: kp.publicPackage,
        privateKeys: kp.privatePackage,
        ratchetTree: undefined,
      });
      await f.advance(false);
      await f.advance(false);
      await f.advance(false);
      const source = memberState;
      const commit = await createCommit({
        context: {
          cipherSuite: f.options.ciphersuite,
          authService: marmotAuthService,
        },
        state: source,
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const event = await createGroupEvent({
        message: commit.commit,
        state: source,
        ciphersuite: f.options.ciphersuite,
      });
      for await (const _ of f.session.ingest([event])) {
        void _;
      }
      expect(callback).toBeDefined();
      expect(f.session.historyTree.size).toBeGreaterThan(2);
      let failures = 0;
      const restoreWrites =
        mode === "failure"
          ? interceptWrites(f.storage, async (ops, write) => {
              if (
                ops.some((op) => checkpointGarbage(op) !== undefined) &&
                failures++ === 0
              )
                throw new Error("automatic checkpoint failed");
              return write();
            })
          : () => {};
      f.tick();
      callback!();
      await waiting;
      if (mode === "concurrent") {
        const work = (await f.session.send({ kind: "selfUpdate" })).publish[0];
        if (work.kind !== "selfUpdate") throw new Error("expected update");
        release();
        await completion;
        expect(f.session.historyTree.size).toBeGreaterThan(2);
        await f.runtime.publishWork(work);
        await f.session.save(true);
      } else if (mode === "failure") {
        await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
        expect(failures).toBe(1);
        restoreWrites();
        await f.session.save(true);
      } else await vi.waitFor(() => expect(f.session.historyTree.size).toBe(2));
      expect(f.session.historyTree.size).toBe(2);
      f.session.dispose();
    });
  for (const kind of [
    "applicationMessage",
    "proposal",
    "selfUpdate",
    "commit",
  ] as const)
    it(`preserves inner own echo after consuming the outer ${kind} marker`, async () => {
      const f = await fixture();
      const effects = await f.session.send(
        kind === "applicationMessage"
          ? { kind, payload: new TextEncoder().encode("own echo") }
          : kind === "proposal"
            ? {
                kind,
                proposal: {
                  proposalType: defaultProposalTypes.remove,
                  remove: { removed: 0 },
                },
              }
            : kind === "commit"
              ? { kind, actorPubkey: testAccount(6).pubkey }
              : { kind },
      );
      const work = effects.publish[0];
      const source = f.session.state;
      const peeled = await new NostrGroupPeeler(
        f.options.ciphersuite,
      ).peelGroupMessages([work.envelope], source);
      const message = peeled.read[0]?.message;
      expect(message).toBeDefined();
      const rewrapped = await createGroupEvent({
        message: message!,
        state: source,
        ciphersuite: f.options.ciphersuite,
      });
      if ("pending" in work) f.session.confirmPublished(work.pending);
      const results = [];
      for await (const result of f.session.ingest([work.envelope, rewrapped]))
        results.push(result);
      expect(
        results.filter(
          (result) =>
            result.kind === "skipped" && result.reason === "self-echo",
        ),
      ).toHaveLength(2);
      f.session.dispose();
    });

  for (const horizon of [1, Infinity])
    it(`retires only strictly older acknowledged outer IDs with horizon ${horizon}`, async () => {
      const f = await fixture(horizon);
      const old = (
        await f.session.send({
          kind: "applicationMessage",
          payload: new Uint8Array([1]),
        })
      ).publish[0];
      await f.runtime.publishApplication(old.envelope);
      await f.advance();
      await f.advance();
      const equality = (
        await f.session.send({
          kind: "applicationMessage",
          payload: new Uint8Array([2]),
        })
      ).publish[0];
      await f.runtime.publishApplication(equality.envelope);
      await f.advance();
      await f.session.save(true);
      const results = [];
      for await (const result of f.session.ingest([
        old.envelope,
        equality.envelope,
      ]))
        results.push(result);
      const selfEchoes = results.filter(
        (result) => result.kind === "skipped" && result.reason === "self-echo",
      );
      // A retired outer ID no longer takes the self-echo fast path.
      const echoed = (id: string) =>
        selfEchoes.some(
          (result) => "event" in result && result.event?.id === id,
        );
      expect(echoed(old.envelope.id)).toBe(horizon === Infinity);
      expect(echoed(equality.envelope.id)).toBe(true);
      expect(selfEchoes).toHaveLength(horizon === Infinity ? 2 : 1);
      f.session.dispose();
    });

  it("captures the original source epoch before delayed wrapping across local advances", async () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = NostrGroupPeeler.prototype.wrapGroupMessage;
    let first = true;
    const spy = vi
      .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
      .mockImplementation(async function (
        this: NostrGroupPeeler,
        ...[message, state, metadata]: Parameters<
          NostrGroupPeeler["wrapGroupMessage"]
        >
      ) {
        if (first) {
          first = false;
          entered();
          await gate;
        }
        return original.call(this, message, state, metadata);
      });
    const f = await fixture();
    try {
      const sending = f.session.send({
        kind: "applicationMessage",
        payload: new Uint8Array([3]),
      });
      await waiting;
      await f.advance();
      await f.advance();
      await f.advance();
      release();
      const work = (await sending).publish[0];
      expect(f.session.state.groupContext.epoch).toBe(3n);
      expect(f.session.historyTree.size).toBe(4);
      await f.runtime.publishApplication(work.envelope);
      await f.session.save(true);
      expect(f.session.historyTree.size).toBe(2);
      const results = [];
      for await (const result of f.session.ingest([work.envelope]))
        results.push(result);
      // The retired outer ID is not fast-pathed: no self-echo record is written.
      expect(
        await f.storage.get(
          `${bytesToHex(f.session.id)}/ingest/wrapper/${work.envelope.id}`,
        ),
      ).toBeUndefined();
      expect(
        results.some(
          (result) =>
            result.kind === "skipped" && result.reason === "self-echo",
        ),
      ).toBe(false);
    } finally {
      release();
      spy.mockRestore();
      f.session.dispose();
    }
  });

  it("consumes sender generation on wrapping failure without reusing authenticated bytes", async () => {
    const f = await fixture();
    const original = NostrGroupPeeler.prototype.wrapGroupMessage;
    const identities: string[] = [];
    const spy = vi
      .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
      .mockImplementation(async function (
        this: NostrGroupPeeler,
        ...[message, state, metadata]: Parameters<
          NostrGroupPeeler["wrapGroupMessage"]
        >
      ) {
        identities.push(contentDedupId(message));
        if (identities.length === 1) throw new Error("wrap failed");
        return original.call(this, message, state, metadata);
      });
    const payload = new Uint8Array([9, 8, 7]);
    try {
      await expect(
        f.session.send({ kind: "applicationMessage", payload }),
      ).rejects.toThrow("wrap failed");
      await f.session.send({ kind: "applicationMessage", payload });
      expect(identities).toHaveLength(2);
      expect(identities[0]).not.toBe(identities[1]);
      expect(f.session.state.groupContext.epoch).toBe(0n);
      expect(payload).toEqual(new Uint8Array([9, 8, 7]));
    } finally {
      spy.mockRestore();
      f.session.dispose();
    }
  });

  it("routes acknowledgements only to their live session owner", async () => {
    const first = await fixture();
    const other = await fixture();
    const work = (
      await first.session.send({
        kind: "applicationMessage",
        payload: new Uint8Array([6]),
      })
    ).publish[0];
    await first.advance();
    await first.advance();
    await first.advance();
    await other.runtime.publishApplication(work.envelope);
    await first.session.save(true);
    expect(first.session.historyTree.size).toBe(4);
    other.session.dispose();
    await other.runtime.publishApplication(work.envelope);
    await first.session.save(true);
    expect(first.session.historyTree.size).toBe(4);
    await first.runtime.publishApplication(work.envelope);
    await first.session.save();
    expect(first.session.historyTree.size).toBe(2);
    first.session.dispose();
  });

  it("pins actual delayed publication and retryable failures until relay acknowledgement", async () => {
    const f = await fixture();
    const work = (
      await f.session.send({
        kind: "applicationMessage",
        payload: new Uint8Array([4]),
      })
    ).publish[0];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publish = f.network.publish.bind(f.network);
    f.network.publish = async () => {
      entered();
      await gate;
      throw new Error("retryable adapter failure");
    };
    const publication = f.runtime.publishApplication(work.envelope);
    const rejected = expect(publication).rejects.toThrow(
      "retryable adapter failure",
    );
    await waiting;
    await f.advance();
    await f.advance();
    await f.advance();
    expect(f.session.historyTree.size).toBe(4);
    release();
    await rejected;
    await f.session.save(true);
    expect(f.session.historyTree.size).toBe(4);
    f.network.publish = publish;
    await f.runtime.publishApplication({ ...work.envelope });
    await f.session.save();
    expect(f.session.historyTree.size).toBe(2);
    f.session.dispose();
  });
  it("uses the outer fast path for locally wrapped handshakes", async () => {
    const f = await fixture();
    const work = (await f.session.send({ kind: "selfUpdate" })).publish[0];
    const results = [];
    for await (const result of f.session.ingest([work.envelope]))
      results.push(result);
    // The locally wrapped handshake is recognized by its outer ID alone.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "skipped",
      reason: "self-echo",
    });
    expect(results[0]).toHaveProperty("event.id", work.envelope.id);
    if (work.kind !== "selfUpdate") throw new Error("expected update");
    f.session.publishFailed(work.pending);
    f.session.dispose();
  });
  for (const forwarding of ["before", "after"] as const)
    it(`pins pending retraction and same-rumor support through ${forwarding} acknowledgement and two restarts`, async () => {
      const f = await fixture();
      const rumor = {
        id: "",
        pubkey: testAccount(6).pubkey,
        created_at: 1000,
        kind: 9,
        tags: [],
        content: "byte exact rumor",
      };
      rumor.id = getEventHash(rumor);
      const payload = serializeApplicationRumor(rumor);
      await f.session.send({ kind: "applicationMessage", payload });
      await f.session.send({
        kind: "applicationMessage",
        payload: payload.slice(),
      });
      const id = bytesToHex(f.session.id);
      const key = `${id}/ingest/delivered`;
      const evidence = decodeDeliveredEvidence(
        (await f.storage.get(key))!,
        f.session.historyTree,
      );
      expect(evidence.entries).toHaveLength(2);
      await f.storage.set(
        key,
        encodeDeliveredEvidence({
          entries: [evidence.entries[0]],
          pending: [evidence.entries[1]],
        }),
      );
      f.session.dispose();
      let failHistory = true;
      const rows = new Map([[rumor.id, payload.slice()]]);
      const history = {
        async saveMessage(bytes: Uint8Array) {
          if (failHistory) throw new Error("history failure");
          rows.set(rumor.id, bytes.slice());
        },
        async removeMessage(id: string) {
          rows.delete(id);
        },
        async purgeMessages() {
          throw new Error("application history must survive");
        },
      };
      const restore = async () =>
        new GroupSession({
          ...f.options,
          history,
          state: deserializeClientState((await f.storage.get(`${id}/state`))!),
          historyTree: (await GroupHistoryTree.load(f.storage, id))!,
        });
      let session = await restore();
      for (let i = 0; i < 3; i++) {
        const effect = (await session.send({ kind: "selfUpdate" })).publish[0];
        if (effect.kind !== "selfUpdate") throw new Error("expected update");
        session.confirmPublished(effect.pending);
        await session.save(true);
      }
      session.dispose();
      for (let restart = 0; restart < 2; restart++) {
        session = await restore();
        for await (const _ of session.ingest([])) {
          void _;
        }
        const retained = decodeDeliveredEvidence(
          (await f.storage.get(key))!,
          session.historyTree,
        );
        expect(retained.pending).toHaveLength(1);
        expect(retained.entries).toHaveLength(1);
        expect(session.historyTree.epochOf(retained.pending[0].stateTag)).toBe(
          0,
        );
        session.dispose();
      }
      session = await restore();
      failHistory = false;
      let armed = true;
      const restoreWrites = interceptWrites(f.storage, async (ops, write) => {
        if (armed && ops.some((op) => op.key === key)) {
          armed = false;
          if (forwarding === "after") await write();
          throw new Error("ack crash");
        }
        return write();
      });
      for await (const _ of session.ingest([])) {
        void _;
      }
      expect(armed).toBe(false);
      restoreWrites();
      for await (const _ of session.ingest([])) {
        void _;
      }
      await session.save(true);
      const compacted = decodeDeliveredEvidence(
        (await f.storage.get(key))!,
        session.historyTree,
      );
      expect(compacted.pending).toEqual([]);
      expect(compacted.entries).toEqual([]);
      expect(
        session.historyTree
          .tags()
          .map((tag) => session.historyTree.epochOf(tag)),
      ).toEqual([2, 3]);
      expect(rows.get(rumor.id)).toEqual(payload);
      session.dispose();
    });
  for (const horizon of [1, Infinity])
    it(`contracts durable history with horizon ${horizon}`, async () => {
      const f = await fixture(horizon);
      await f.advance();
      await f.advance();
      await f.advance();
      await f.settle();
      expect(f.session.historyTree.size).toBe(horizon === Infinity ? 4 : 2);
      const id = bytesToHex(f.session.id);
      const persisted = await GroupHistoryTree.load(f.storage, id);
      expect(persisted?.size).toBe(f.session.historyTree.size);
      const tip = await f.session.historyTree.stateAt(
        bytesToHex(f.session.state.confirmationTag),
      );
      expect(tip?.groupContext.epoch).toBe(3n);
      f.session.dispose();
    });

  // Tree nodes, canonical state and delivered evidence now commit in one
  // atomic batch ("commit"), and garbage deletion commits with the clean
  // checkpoint ("cleanup"); the windows between them no longer exist.
  for (const boundary of ["commit", "checkpoint", "cleanup"] as const)
    for (const forwarding of ["before", "after"] as const)
      it(`recovers through two restarts after ${forwarding} ${boundary}`, async () => {
        const f = await fixture();
        await f.session.save(true);
        await f.advance(false);
        await f.advance(false);
        await f.advance(false);
        const id = bytesToHex(f.session.id);
        let armed = true;
        const writes: string[] = [];
        interceptWrites(f.storage, async (ops, write) => {
          const kind = classifyWrite(ops, id);
          if (kind) writes.push(kind);
          const hit = armed && kind === boundary;
          if (hit && forwarding === "before") {
            armed = false;
            throw new Error("crash");
          }
          await write();
          if (hit) {
            armed = false;
            throw new Error("crash");
          }
        });
        await expect(f.session.save(true)).rejects.toThrow("crash");
        expect(armed).toBe(false);
        if (boundary !== "cleanup")
          expect(writes.includes("cleanup")).toBe(false);
        f.session.dispose();
        for (let restart = 0; restart < 2; restart++) {
          const tree = (await GroupHistoryTree.load(f.storage, id))!;
          const state = deserializeClientState(
            (await f.storage.get(`${id}/state`))!,
          );
          expect(tree.hasNode(bytesToHex(state.confirmationTag))).toBe(true);
          await tree.resumeRetentionCleanup();
          const restored = new GroupSession({
            ...f.options,
            state,
            historyTree: tree,
          });
          await restored.save(true);
          restored.dispose();
        }
      });

  it("publishes bounded authority after the canonical commit", async () => {
    const f = await fixture();
    const id = bytesToHex(f.session.id);
    const writes: string[] = [];
    interceptWrites(f.storage, async (ops, write) => {
      const kind = classifyWrite(ops, id);
      if (kind === "commit") {
        // Canonical state and delivered evidence are one atomic write.
        expect(ops.some((op) => op.key === `${id}/ingest/delivered`)).toBe(
          true,
        );
      }
      if (kind) writes.push(kind);
      return write();
    });
    await f.advance();
    await f.advance();
    await f.advance();
    await f.settle();
    expect(
      f.session.historyTree
        .tags()
        .map((tag) => f.session.historyTree.epochOf(tag))
        .join() === "2,3",
    ).toBe(true);
    const checkpoint = writes.indexOf("checkpoint");
    expect(checkpoint).toBeGreaterThan(-1);
    expect(writes.lastIndexOf("commit", checkpoint)).toBeGreaterThan(-1);
    expect(writes.indexOf("cleanup", checkpoint)).toBeGreaterThan(checkpoint);
    expect(writes.slice(0, checkpoint)).not.toContain("cleanup");
    for (let restart = 0; restart < 2; restart++) {
      const restored = await GroupHistoryTree.load(f.storage, id);
      expect(restored?.size).toBe(2);
      const state = deserializeClientState(
        (await f.storage.get(`${id}/state`))!,
      );
      expect(restored?.hasNode(bytesToHex(state.confirmationTag))).toBe(true);
    }
    f.session.dispose();
  });
});
