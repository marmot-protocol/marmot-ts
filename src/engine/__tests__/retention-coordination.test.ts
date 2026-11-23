import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  appDataDictionaryExtensionType,
  defaultCryptoProvider,
  createApplicationMessage,
  createCommit,
  createProposal,
  createGroup as mlsCreateGroup,
  getAppDataDictionary,
  joinGroup,
  processMessage,
  type ClientState,
  defaultProposalTypes,
  pskTypes,
  resumptionPSKUsages,
  getCiphersuiteImpl,
  type MlsMessage,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";
import {
  getAppComponents,
  appComponentsEntry,
  makeAppComponentsExtension,
  GROUP_LIFECYCLE_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
} from "../../core/components/index.js";
import { marmotAuthService } from "../../core/auth-service.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { serializeApplicationRumor } from "../../core/application-rumor.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { memoryTreeStore } from "../../__tests__/helpers/database.js";
import type {
  HistoryTreeStore,
  HistoryTreeWrite,
} from "../history-tree-store.js";
import {
  MarmotGroupEngine,
  type MarmotGroupEngineOptions,
} from "../group-engine.js";
import { GroupHistoryTree } from "../history-tree.js";
import { RetainedHistoryStore } from "../retained-store.js";
import { framedEpoch } from "../wire-format.js";

type Envelope = { id: string; message: MlsMessage; toJSON(): { id: string } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Memory tree store with hooks around every durable write (`commit`). */
class MemoryStore implements HistoryTreeStore {
  readonly #inner = memoryTreeStore();
  beforeWrite?: () => Promise<void>;
  afterWrite?: (value: Uint8Array) => Promise<void>;
  meta() {
    return this.#inner.meta();
  }
  node(tag: string) {
    return this.#inner.node(tag);
  }
  async commit(write: HistoryTreeWrite) {
    await this.beforeWrite?.();
    await this.#inner.commit(write);
    for (const value of write.puts.values()) await this.afterWrite?.(value);
    if (write.meta) await this.afterWrite?.(write.meta);
  }
}

async function fixture(
  options: Partial<
    Pick<
      MarmotGroupEngineOptions<Envelope>,
      "scheduler" | "now" | "onSettleCheck" | "peeler"
    >
  > = {},
  legacy = false,
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
      relays: [],
    },
  );
  // Recreate an authenticated MLS group advertising the legacy component set.
  // Do not mutate a live group's signed context to fabricate legacy state.
  const state = legacy
    ? await mlsCreateGroup({
        context: { cipherSuite: ciphersuite, authService: marmotAuthService },
        groupId: clientState.groupContext.groupId,
        keyPackage: kp.publicPackage,
        privateKeyPackage: kp.privatePackage,
        extensions: [
          ...clientState.groupContext.extensions.filter(
            (extension) =>
              extension.extensionType !== appDataDictionaryExtensionType,
          ),
          makeAppComponentsExtension([
            appComponentsEntry(
              getAppComponents(clientState.groupContext.extensions)!.filter(
                (id) => id !== GROUP_LIFECYCLE_COMPONENT_ID,
              ),
            ),
            ...getAppDataDictionary(
              clientState.groupContext.extensions,
            )!.filter(
              (entry) =>
                entry.componentId !== GROUP_LIFECYCLE_COMPONENT_ID &&
                entry.componentId !== APP_COMPONENTS_COMPONENT_ID,
            ),
          ]),
        ],
      })
    : clientState;
  const engine = new MarmotGroupEngine<Envelope>({
    state,
    ciphersuite,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits: 1,
      appPayloadPastEpochLimit: 1,
    },
    peeler: {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.map((envelope) => ({
            envelope,
            message: envelope.message,
          })),
          unreadable: [],
        };
      },
      async wrapGroupMessage(message) {
        const id = crypto.randomUUID();
        return { id, message, toJSON: () => ({ id }) };
      },
      idOf: (envelope) => envelope.id,
    },
    ...options,
  });
  const store = new MemoryStore();
  engine.history.bindStore(store);
  return { engine, store };
}

async function advance(engine: MarmotGroupEngine<Envelope>) {
  const sent = await engine.send({ kind: "selfUpdate" });
  if (!("pending" in sent)) throw new Error("expected commit");
  engine.confirmPublished(sent.pending);
  return sent;
}

/** Genuine two-member MLS states with one source-1 and one source-2 application. */
async function applicationFixture(
  mode: "direct" | "sweep",
  maxRewindCommits = Infinity,
) {
  const admin = testAccount(6);
  const member = testAccount(11);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const context = { cipherSuite: ciphersuite, authService: marmotAuthService };
  const keyPackage = async (account: typeof admin) =>
    generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: ciphersuite,
    });
  const adminKp = await keyPackage(admin);
  const memberKp = await keyPackage(member);
  const { clientState } = await createSimpleGroup(
    adminKp,
    ciphersuite,
    "App window",
    { adminPubkeys: [admin.pubkey], relays: [] },
  );
  const add = await createCommit({
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
  let sender = add.newState;
  let receiver = await joinGroup({
    context,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  const tree = new GroupHistoryTree(receiver);
  const states: ClientState[] = [receiver];
  const messages: MlsMessage[] = [];
  for (let epoch = 1; epoch <= 2; epoch++) {
    const event = {
      pubkey: admin.pubkey,
      created_at: epoch,
      kind: 9,
      tags: [],
      content: `epoch ${epoch}`,
    };
    const app = await createApplicationMessage({
      context,
      state: sender,
      message: serializeApplicationRumor({ ...event, id: getEventHash(event) }),
    });
    messages.push(app.message);
    sender = app.newState;
    const commit = await createCommit({
      context,
      state: sender,
      wireAsPublicMessage: true,
      extraProposals: [],
    });
    const applied = await processMessage({
      context,
      state: receiver,
      message: commit.commit,
    });
    if (applied.kind !== "newState" || applied.actionTaken !== "accept")
      throw new Error("expected authenticated commit");
    tree.recordCommit(
      bytesToHex(receiver.confirmationTag),
      commit.commit,
      applied.newState,
    );
    receiver = applied.newState;
    sender = commit.newState;
    states.push(receiver);
  }
  const store = new MemoryStore();
  tree.bindStore(store);
  const engine = new MarmotGroupEngine<Envelope>({
    state: receiver,
    historyTree: tree,
    retained: new RetainedHistoryStore(receiver),
    ciphersuite,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits,
      appPayloadPastEpochLimit: 1,
    },
    peeler: {
      async peelGroupMessages(envelopes, state) {
        const read = envelopes.filter(
          (envelope) =>
            mode === "direct" ||
            framedEpoch(envelope.message) === state.groupContext.epoch,
        );
        return {
          read: read.map((envelope) => ({
            envelope,
            message: envelope.message,
          })),
          unreadable: envelopes.filter((envelope) => !read.includes(envelope)),
        };
      },
      async wrapGroupMessage(message) {
        const id = crypto.randomUUID();
        return { id, message, toJSON: () => ({ id }) };
      },
      idOf: (envelope) => envelope.id,
    },
  });
  async function receive(message: MlsMessage) {
    const id = crypto.randomUUID();
    const results = [];
    for await (const result of engine.ingest([
      { id, message, toJSON: () => ({ id }) },
    ]))
      results.push(result);
    return results;
  }
  return {
    engine,
    receive,
    expired: messages[0],
    equality: messages[1],
    states,
    sender,
    context,
    store,
  };
}

describe("competing resumption Commit retention", () => {
  it("preserves authentic competing PSK Commit replay through retention and reload until its source expires", async () => {
    const f = await applicationFixture("direct", 2);
    const tree = f.engine.history;
    const sourceTag = bytesToHex(f.engine.state.confirmationTag);
    const copy = (state: ClientState) =>
      deserializeClientState(serializeClientState(state));
    const proposal = await createProposal({
      context: f.context,
      state: copy(f.sender),
      wireAsPublicMessage: true,
      proposal: {
        proposalType: defaultProposalTypes.psk,
        psk: {
          preSharedKeyId: {
            psktype: pskTypes.resumption,
            usage: resumptionPSKUsages.application,
            pskGroupId: f.sender.groupContext.groupId,
            pskEpoch: 1n,
            pskNonce: new Uint8Array(32).fill(1),
          },
        },
      },
    });
    const staged = await processMessage({
      context: f.context,
      state: copy(f.engine.state),
      message: proposal.message,
    });
    if (staged.kind !== "newState") throw new Error("expected staged PSK");
    tree.updateSnapshot(sourceTag, staged.newState);
    const competing = await createCommit({
      context: f.context,
      state: copy(proposal.newState),
      wireAsPublicMessage: true,
      extraProposals: [],
    });
    const replay = async (history: GroupHistoryTree) => {
      const source = (await history.stateAt(sourceTag))!;
      expect(Object.keys(source.unappliedProposals)).toHaveLength(1);
      await expect(
        processMessage({
          context: f.context,
          state: source,
          message: competing.commit,
        }),
      ).resolves.toMatchObject({ kind: "newState", actionTaken: "accept" });
      expect(source.historicalReceiverData.has(1n)).toBe(true);
    };
    await replay(tree);
    const canonical = await createCommit({
      context: f.context,
      state: copy(f.sender),
      wireAsPublicMessage: true,
      extraProposals: [],
    });
    const canonicalApplied = await processMessage({
      context: f.context,
      state: copy(f.engine.state),
      message: canonical.commit,
    });
    if (canonicalApplied.kind !== "newState")
      throw new Error("expected canonical Commit");
    const tipTag = tree.recordCommit(
      sourceTag,
      canonical.commit,
      canonicalApplied.newState,
    );
    f.engine.dispose();
    const engine = new MarmotGroupEngine<Envelope>({
      state: canonicalApplied.newState,
      historyTree: tree,
      ciphersuite: f.context.cipherSuite,
      convergencePolicy: {
        ...DEFAULT_CONVERGENCE_POLICY,
        maxRewindCommits: 2,
        appPayloadPastEpochLimit: 1,
      },
      peeler: {
        async peelGroupMessages(envelopes) {
          return {
            read: envelopes.map((envelope) => ({
              envelope,
              message: envelope.message,
            })),
            unreadable: [],
          };
        },
        async wrapGroupMessage(message) {
          const id = crypto.randomUUID();
          return { id, message, toJSON: () => ({ id }) };
        },
        idOf: (envelope) => envelope.id,
      },
    });
    try {
      expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
      expect(tree.epochOf(sourceTag)).toBe(3);
      expect(tree.epochOf(tipTag)).toBe(4);
      await replay(tree);
      const loaded = (await GroupHistoryTree.load(
        f.store,
        bytesToHex(engine.state.groupContext.groupId),
        { snapshotCacheSize: 0 },
      ))!;
      await replay(loaded);
      // The staged proposal protects only its selectable source. Once the
      // source falls out of the window, ordinary finite contraction resumes.
      for (let step = 0; step < 6; step++) {
        await advance(engine);
        expect(await engine.retainSettled()).toMatchObject({
          kind: "committed",
        });
        if (step >= 1) {
          expect(tree.hasNode(sourceTag)).toBe(false);
          expect(tree.size).toBe(3);
          for (const tag of tree.tags())
            expect(
              (await tree.stateAt(tag))!.historicalReceiverData.has(1n),
            ).toBe(false);
        }
      }
    } finally {
      engine.dispose();
    }
  });
});

describe("authenticated seen identity retention", () => {
  it("records source epochs only on real completion and retains equality", async () => {
    const { engine, receive, equality } = await applicationFixture("direct", 1);
    expect(
      (await receive(equality)).some((result) => result.kind === "processed"),
    ).toBe(true);
    expect(engine.retentionIdentityCounts().seen).toBe(1);
    await engine.retainSettled();
    expect(await receive(equality)).toMatchObject([
      { kind: "skipped", reason: "duplicate" },
    ]);
    await advance(engine);
    await engine.retainSettled();
    expect(engine.retentionIdentityCounts().seen).toBe(0);
    expect(
      (await receive(equality)).some(
        (result) => result.kind === "skipped" && result.reason === "duplicate",
      ),
    ).toBe(false);
  });

  it("preserves historical seen IDs with Infinity and never marks opaque input seen", async () => {
    const { engine, receive, equality } = await applicationFixture("direct");
    await receive(equality);
    await advance(engine);
    await advance(engine);
    await engine.retainSettled();
    expect(engine.retentionIdentityCounts().seen).toBe(1);
    expect(await receive(equality)).toMatchObject([
      { kind: "skipped", reason: "duplicate" },
    ]);
    const before = engine.retentionIdentityCounts().seen;
    engine.peeler.peelGroupMessages = async (envelopes) => ({
      read: [],
      unreadable: envelopes,
    });
    await receive(equality);
    expect(engine.retentionIdentityCounts().seen).toBe(before);
  });
});

describe("independent application payload window", () => {
  for (const mode of ["direct", "sweep"] as const) {
    it(`${mode} leaves future and unauthenticated application epochs retryable or unreadable`, async () => {
      const { engine, receive, sender, context } =
        await applicationFixture(mode);
      const commit = await createCommit({
        context,
        state: sender,
        wireAsPublicMessage: true,
        extraProposals: [],
      });
      const event = {
        pubkey: testAccount(6).pubkey,
        created_at: 4,
        kind: 9,
        tags: [],
        content: "future",
      };
      const future = await createApplicationMessage({
        context,
        state: commit.newState,
        message: serializeApplicationRumor({
          ...event,
          id: getEventHash(event),
        }),
      });
      const results = await receive(future.message);
      expect(
        results.some(
          (result) =>
            result.kind === "processed" ||
            (result.kind === "skipped" && result.reason === "past-epoch"),
        ),
      ).toBe(false);
      expect(engine.retentionIdentityCounts().seen).toBe(0);
      expect(engine.exportDeliveredPayloads()).toHaveLength(0);
      if (!("privateMessage" in future.message))
        throw new Error("expected private application");
      const untrusted = {
        ...future.message,
        privateMessage: {
          ...future.message.privateMessage,
          epoch: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        },
      };
      const bad = await receive(untrusted);
      expect(
        bad.some(
          (result) =>
            result.kind === "processed" ||
            (result.kind === "skipped" && result.reason === "past-epoch"),
        ),
      ).toBe(false);
      expect(engine.retentionIdentityCounts().seen).toBe(0);
      if (mode === "sweep") {
        expect(engine.pendingCount).toBe(2);
        expect(await engine.retainSettled()).toMatchObject({
          kind: "postponed",
          reason: "unknown-input-epoch",
        });
        expect(engine.pendingCount).toBe(2);
      }
    });
  }
  for (const mode of ["direct", "sweep"] as const) {
    for (const horizon of [Infinity, 1]) {
      it(`${mode} accepts equality and rejects one-below with horizon ${horizon} and exact receiver pins`, async () => {
        const { engine, receive, expired, equality, states } =
          await applicationFixture(mode, horizon);
        const tipTag = bytesToHex(engine.state.confirmationTag);
        await engine.retainSettled(undefined, {
          pins: [
            { stateTag: tipTag, reason: "resumption", receiverEpoch: 1 },
            {
              stateTag: bytesToHex(states[0].confirmationTag),
              reason: "recovery",
            },
          ],
        });
        expect(engine.state.historicalReceiverData.has(1n)).toBe(true);
        expect(
          engine.history.hasNode(bytesToHex(states[0].confirmationTag)),
        ).toBe(true);
        const fresh = await receive(equality);
        expect(
          fresh.some(
            (result) =>
              result.kind === "processed" &&
              result.result.kind === "applicationMessage",
          ),
        ).toBe(true);
        const stale = await receive(expired);
        expect(
          stale.some(
            (result) =>
              result.kind === "processed" &&
              result.result.kind === "applicationMessage",
          ),
        ).toBe(false);
        expect(stale).toContainEqual(
          expect.objectContaining({
            kind: "skipped",
            reason: "past-epoch",
            disposition: expect.objectContaining({ kind: "stale" }),
          }),
        );
        expect(engine.exportDeliveredPayloads()).toHaveLength(1);
        expect(engine.pendingCount).toBe(0);
        expect(engine.convergencePass).toBeUndefined();
        expect(engine.convergenceStatus).toBe("Settled");
      });
    }
  }
});

describe("settled engine retention", () => {
  it.each(["success", "failure"] as const)(
    "keeps enablement admitted during asynchronous wrapping through %s",
    async (mode) => {
      const wrapStarted = deferred();
      const wrapGate = deferred();
      const retentionStarted = deferred();
      const retentionGate = deferred();
      const { engine } = await fixture(
        {
          peeler: {
            async peelGroupMessages() {
              return { read: [], unreadable: [] };
            },
            async wrapGroupMessage(message) {
              wrapStarted.resolve();
              await wrapGate.promise;
              if (mode === "failure") throw new Error("wrap failed");
              const id = crypto.randomUUID();
              return { id, message, toJSON: () => ({ id }) };
            },
            idOf: (envelope) => envelope.id,
          },
        },
        true,
      );
      let acquired = false;
      const enable = engine.enableGroupDisbanding().then(
        (result) => ({ result, error: undefined }),
        (error: Error) => ({ result: undefined, error }),
      );
      try {
        await wrapStarted.promise;
        const retention = engine.retainSettled(async (capture, publish) => {
          acquired = true;
          retentionStarted.resolve();
          await retentionGate.promise;
          const plan = await engine.history.prepareRetention(capture);
          await publish(plan);
          return plan;
        });
        await Promise.race([retentionStarted.promise, retention]);
        wrapGate.resolve();
        const enabled = await enable;
        retentionGate.resolve();
        const during = await retention;
        expect({ acquired, enableError: enabled.error?.message }).toEqual({
          acquired: false,
          enableError: mode === "failure" ? "wrap failed" : undefined,
        });
        expect(during).toMatchObject({
          kind: "postponed",
          reason: "active-dependencies",
        });
        if (mode === "failure") {
          expect(enabled.error?.message).toBe("wrap failed");
        } else {
          expect(enabled.error).toBeUndefined();
          expect(enabled.result?.kind).toBe("groupEvolution");
          if (!enabled.result || !("pending" in enabled.result))
            throw new Error("expected lifecycle Commit");
          // The async admission has ended, but staged publication still protects
          // the source until its actual confirmation boundary.
          expect(await engine.retainSettled()).toMatchObject({
            kind: "postponed",
          });
          engine.confirmPublished(enabled.result.pending);
        }
        expect(await engine.retainSettled()).toMatchObject({
          kind: "committed",
        });
      } finally {
        wrapGate.resolve();
        retentionGate.resolve();
        await enable;
        engine.dispose();
      }
    },
  );

  it("defers a queued settle callback through storage and owns its asynchronous completion", async () => {
    let now = 0;
    let wakeups = 0;
    let callback: (() => void) | undefined;
    const finished = deferred();
    const { engine, store } = await fixture({
      now: () => now,
      scheduler: {
        setTimer(_ms, cb) {
          callback = cb;
          return 1;
        },
        clearTimer() {},
      },
      onSettleCheck() {
        wakeups++;
        return finished.promise;
      },
    });
    const staged = await engine.send({ kind: "selfUpdate" });
    if (!("pending" in staged) || !("envelope" in staged))
      throw new Error("expected staged send");
    for await (const _ of engine.ingest([staged.envelope])) {
      void _;
    }
    engine.publishFailed(staged.pending);
    const queued = callback!;
    await engine.driveConvergence();
    now = 100_000;
    await engine.driveConvergence();
    const entered = deferred();
    const release = deferred();
    store.beforeWrite = async () => {
      entered.resolve();
      await release.promise;
    };
    const retention = engine.retainSettled();
    await entered.promise;
    queued();
    expect(wakeups).toBe(0);
    release.resolve();
    await retention;
    await Promise.resolve();
    expect(wakeups).toBe(1);
    expect(await engine.retainSettled()).toMatchObject({
      kind: "postponed",
      reason: "active-dependencies",
    });
    finished.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
  });

  it("refuses callback plans that omit captured pins or change the application floor", async () => {
    const { engine } = await fixture();
    const root = engine.history.rootTag!;
    await advance(engine);
    await advance(engine);
    await advance(engine);
    const oldStates = engine.retainedStates();
    await expect(
      engine.retainSettled(
        async (capture, publish) => {
          const plan = await engine.history.prepareRetention({
            ...capture,
            pins: [],
          });
          await publish(plan);
          return plan;
        },
        { pins: [{ stateTag: root, reason: "recovery" }] },
      ),
    ).rejects.toThrow(/omitted an exact pin/);
    expect(engine.history.rootTag).toBe(root);
    expect(engine.retainedStates()).toEqual(oldStates);
    await expect(
      engine.retainSettled(async (capture, publish) => {
        const plan = await engine.history.prepareRetention({
          ...capture,
          appPayloadPastEpochLimit: Infinity,
        });
        await publish(plan);
        return plan;
      }),
    ).rejects.toThrow(/differs from settled capture/);
    expect(engine.history.rootTag).toBe(root);
    expect(engine.retainedStates()).toEqual(oldStates);
    await engine.retainSettled();
  });

  it("adopts exactly forwarded checkpoint authority despite adapter rejection", async () => {
    const { engine, store } = await fixture();
    await advance(engine);
    await advance(engine);
    await advance(engine);
    await engine.history.flush();
    const root = engine.history.rootTag;
    store.afterWrite = async (value) => {
      if (value[0] === 2) throw new Error("forwarded checkpoint rejected");
    };
    let plan!: Awaited<ReturnType<typeof engine.history.prepareRetention>>;
    await expect(
      engine.retainSettled(async (capture, publish) => {
        plan = await engine.history.prepareRetention(capture);
        await publish(plan);
        return plan;
      }),
    ).rejects.toThrow("forwarded checkpoint rejected");
    expect(engine.history.isRetentionPublished(plan)).toBe(true);
    expect(engine.history.rootTag).not.toBe(root);
    expect(
      engine.retainedStates().map((state) => Number(state.groupContext.epoch)),
    ).toEqual([3, 2]);
    expect(engine.history.isRetentionPublished({ ...plan })).toBe(false);
    const snapshots = plan.snapshots;
    if (!(snapshots instanceof Map)) throw new Error("expected a Map fixture");
    const bytes = snapshots.get(plan.canonicalTipTag)!;
    const modified = bytes.slice();
    modified[modified.length - 1] ^= 1;
    try {
      snapshots.set(plan.canonicalTipTag, modified);
      expect(engine.history.isRetentionPublished(plan)).toBe(false);
    } finally {
      snapshots.set(plan.canonicalTipTag, bytes);
      store.afterWrite = undefined;
    }
    expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
    await advance(engine);
    expect(engine.history.isRetentionPublished(plan)).toBe(false);
  });

  it("keeps exact recovery pins until their owner releases them", async () => {
    const { engine } = await fixture();
    const rootTag = engine.history.rootTag!;
    await advance(engine);
    await advance(engine);
    await advance(engine);
    expect(
      await engine.retainSettled(undefined, {
        pins: [{ stateTag: rootTag, reason: "recovery" }],
      }),
    ).toMatchObject({ kind: "committed" });
    expect(engine.history.hasNode(rootTag)).toBe(true);
    expect(
      engine.retainedStates().some((state) => state.groupContext.epoch === 0n),
    ).toBe(true);
    expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
    expect(engine.history.hasNode(rootTag)).toBe(false);
    expect(
      engine.retainedStates().map((state) => Number(state.groupContext.epoch)),
    ).toEqual([3, 2]);
  });

  it("refuses a resumption PSK proposal without pinning its receiver", async () => {
    const { engine } = await fixture();
    await advance(engine);
    await advance(engine);
    await advance(engine);
    expect(engine.state.historicalReceiverData.has(0n)).toBe(true);
    // MDK and every marmot-ts peer reject PreSharedKey proposals, so one can
    // never be staged and its resumption receiver is never pinned.
    await expect(
      engine.send({
        kind: "proposal",
        proposal: {
          proposalType: defaultProposalTypes.psk,
          psk: {
            preSharedKeyId: {
              psktype: pskTypes.resumption,
              usage: resumptionPSKUsages.application,
              pskGroupId: engine.state.groupContext.groupId,
              pskEpoch: 0n,
              pskNonce: new Uint8Array(32).fill(7),
            },
          },
        },
      }),
    ).rejects.toThrow("proposal type 4 is not supported");
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
    let pins: unknown;
    await engine.retainSettled(async (capture, publish) => {
      pins = capture.pins;
      const plan = await engine.history.prepareRetention(capture);
      await publish(plan);
      return plan;
    });
    expect(pins).not.toContainEqual(
      expect.objectContaining({ reason: "resumption" }),
    );
    expect(engine.state.historicalReceiverData.has(0n)).toBe(false);
  });

  it("never releases canonical recovery state when checkpoint publication rejects", async () => {
    const { engine, store } = await fixture();
    await advance(engine);
    await advance(engine);
    await advance(engine);
    await engine.history.flush();
    const oldStates = engine.retainedStates();
    const root = engine.history.rootTag;
    store.beforeWrite = async () => {
      throw new Error("checkpoint rejected");
    };
    await expect(engine.retainSettled()).rejects.toThrow("checkpoint rejected");
    expect(engine.history.rootTag).toBe(root);
    expect(engine.retainedStates()).toEqual(oldStates);
    store.beforeWrite = undefined;
    await engine.retainSettled();
    expect(engine.retainedStates()).toHaveLength(2);
  });

  it("rejects callback success without publishing checkpoint authority", async () => {
    const { engine } = await fixture();
    await advance(engine);
    await advance(engine);
    await advance(engine);
    const before = engine.retainedStates();
    await expect(
      engine.retainSettled((capture) =>
        engine.history.prepareRetention(capture),
      ),
    ).rejects.toThrow(/did not publish/);
    expect(engine.retainedStates()).toEqual(before);
    await engine.retainSettled();
  });

  it("postpones opaque retryable input and unsafe retention coordinates", async () => {
    const { engine } = await fixture();
    const original = engine.peeler.peelGroupMessages;
    engine.peeler.peelGroupMessages = async (envelopes) => ({
      read: [],
      unreadable: envelopes,
    });
    const sent = await advance(engine);
    if (!("envelope" in sent)) throw new Error("expected envelope");
    for await (const _ of engine.ingest([sent.envelope])) {
      void _;
    }
    expect(engine.pendingCount).toBe(1);
    expect(await engine.retainSettled()).toMatchObject({
      kind: "postponed",
      reason: "unknown-input-epoch",
    });
    expect(engine.pendingCount).toBe(1);
    engine.peeler.peelGroupMessages = original;
    const { engine: unsafe } = await fixture();
    unsafe.state = {
      ...unsafe.state,
      groupContext: {
        ...unsafe.state.groupContext,
        epoch: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      },
    };
    expect(await unsafe.retainSettled()).toMatchObject({
      kind: "postponed",
      reason: "unsafe-epoch",
    });
  });

  it("postpones retention until an admitted generator is fully drained", async () => {
    const { engine } = await fixture();
    const sent = await advance(engine);
    if (!("envelope" in sent)) throw new Error("expected envelope");
    const generator = engine.ingest([sent.envelope]);
    expect((await generator.next()).done).toBe(false);
    expect(await engine.retainSettled()).toMatchObject({ kind: "postponed" });
    await generator.return(undefined);
    expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
  });

  it("holds admissions while the actual storage adapter is paused", async () => {
    const { engine, store } = await fixture();
    await advance(engine);
    await advance(engine);
    const entered = deferred();
    const release = deferred();
    store.beforeWrite = async () => {
      entered.resolve();
      await release.promise;
    };
    const retention = engine.retainSettled();
    await entered.promise;
    let done = false;
    const admission = engine.driveConvergence().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release.resolve();
    await retention;
    await admission;
    expect(done).toBe(true);
  });

  it("holds a settled lease across durable pruning and fences direct mutation", async () => {
    const { engine } = await fixture();
    await advance(engine);
    await advance(engine);
    await advance(engine);
    const oldRoot = engine.history.rootTag;
    expect(typeof engine.retainSettled).toBe("function");
    const entered = deferred();
    const release = deferred();
    const retention = engine.retainSettled(async (capture, publish) => {
      const plan = await engine.history.prepareRetention(capture);
      entered.resolve();
      await release.promise;
      await publish(plan);
      await engine.history.resumeRetentionCleanup();
      return plan;
    });
    await entered.promise;
    const before = engine.state;
    expect(() => {
      engine.state = before;
    }).toThrow(/retention/i);
    expect(() => engine.admitConvergencePass()).toThrow(/retention/i);
    expect(() =>
      engine.confirmPublished({ kind: "proposal", newState: before }),
    ).toThrow(/retention/i);
    expect(() =>
      engine.publishFailed({ kind: "commit", newState: before }),
    ).toThrow(/retention/i);
    let ingested = false;
    let sent = false;
    const ingest = (async () => {
      for await (const _ of engine.ingest([])) {
        void _;
      }
      ingested = true;
    })();
    const send = engine
      .send({ kind: "applicationMessage", payload: new Uint8Array([1]) })
      .then(() => {
        sent = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(ingested).toBe(false);
    expect(sent).toBe(false);
    expect(engine.state).toBe(before);
    release.resolve();
    expect(await retention).toMatchObject({ kind: "committed", floorEpoch: 2 });
    await ingest;
    await send;
    expect(engine.history.hasNode(oldRoot!)).toBe(false);
    expect(engine.history.epochOf(engine.history.rootTag!)).toBe(2);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(before.confirmationTag),
    );
  });

  it("postpones staged confirmation and releases a failed lease for retry", async () => {
    const { engine } = await fixture();
    expect(typeof engine.retainSettled).toBe("function");
    const staged = await engine.send({ kind: "selfUpdate" });
    if (!("pending" in staged)) throw new Error("expected commit");
    expect(await engine.retainSettled()).toMatchObject({ kind: "postponed" });
    engine.publishFailed(staged.pending);
    await expect(
      engine.retainSettled(async () => {
        throw new Error("storage failed");
      }),
    ).rejects.toThrow("storage failed");
    expect(await engine.retainSettled()).toMatchObject({ kind: "committed" });
    await advance(engine);
  });
});
