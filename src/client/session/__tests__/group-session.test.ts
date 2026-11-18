import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash } from "applesauce-core/helpers/event";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  CiphersuiteImpl,
  appDataUpdateProposalType,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { memoryStorage, type StorageOp } from "../../../utils/storage.js";
import { GroupSession } from "../group-session.js";
import type { UnreadableIngestResult } from "../group-session.js";
import type { IngestResult as EngineIngestResult } from "../../../engine/types.js";
import {
  disbandTombstoneKey,
  disbandTerminalIntentKey,
  encodeDisbandTombstone,
} from "../../../engine/disband-tombstone.js";
import { encodeDisbandRequest } from "../../../engine/disband-request.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { decodeDeliveredEvidence } from "../delivered-payload-store.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../../core/components/ids.js";
import { NostrGroupPeeler } from "../../group/nostr-peeler.js";
import { serializeClientState } from "../../../core/client-state.js";

function clearImageProposal(): import("ts-mls").Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
      operation: "update",
      update: new Uint8Array(5),
    },
  };
}

const ADMIN_ACCOUNT = testAccount(6);
const MEMBER_ACCOUNT = testAccount(9);
const ADMIN = ADMIN_ACCOUNT.pubkey;
const MEMBER = MEMBER_ACCOUNT.pubkey;

describe("expected canonical parent at preparation", () => {
  const makeSession = async () => {
    const ciphersuite = await getImpl();
    return new GroupSession({
      state: await createAdminState(ciphersuite),
      ciphersuite,
      storage: memoryStorage(),
    });
  };
  it("rejects a stale expected parent before preparing a commit", async () => {
    const ciphersuite = await getImpl();
    const state = await createAdminState(ciphersuite);
    const session = new GroupSession({
      state,
      ciphersuite,
      storage: memoryStorage(),
    });
    const before = session.state;
    const intent = {
      kind: "commit" as const,
      actorPubkey: ADMIN,
      expectedParent: "stale-parent",
    };
    let rejection = "accepted";
    try {
      await session.send(intent);
    } catch (error) {
      rejection = (error as Error).message;
    }
    expect(rejection).toBe("Group canonical parent changed before preparation");
    expect(session.state).toBe(before);
    expect(session.lifecycle).toBe("Stable");
    session.dispose();
  });

  it("prepares a current-parent image and requires context for raw, built and referenced images", async () => {
    for (const builder of [false, true]) {
      const session = await makeSession();
      const extraProposals = builder
        ? [async () => clearImageProposal()]
        : [clearImageProposal()];
      await expect(
        session.send({ kind: "commit", actorPubkey: ADMIN, extraProposals }),
      ).rejects.toThrow("require expectedParent");
      expect(session.lifecycle).toBe("Stable");
      const effects = await session.send({
        kind: "commit",
        actorPubkey: ADMIN,
        expectedParent: session.parentToken,
        extraProposals,
      });
      expect(effects.publish).toHaveLength(1);
      session.dispose();
    }
    const session = await makeSession();
    const proposalEffects = await session.send({
      kind: "proposal",
      proposal: clearImageProposal(),
    });
    const work = proposalEffects.publish[0];
    if (work.kind !== "proposal") throw new Error("expected proposal");
    session.confirmPublished(work.pending);
    await expect(
      session.send({ kind: "commit", actorPubkey: ADMIN }),
    ).rejects.toThrow("require expectedParent");
    expect(session.lifecycle).toBe("Stable");
    session.dispose();
  });

  it("rejects a parent changed while an image builder awaited without staging or wrapping", async () => {
    const session = await makeSession();
    const entered = deferred(),
      release = deferred();
    const expectedParent = session.parentToken;
    const pending = session.send({
      kind: "commit",
      actorPubkey: ADMIN,
      expectedParent,
      extraProposals: [
        async () => {
          entered.resolve();
          await release.promise;
          return clearImageProposal();
        },
      ],
    });
    const rejected = expect(pending).rejects.toThrow(
      "canonical parent changed",
    );
    await entered.promise;
    const advanced = await session.send({ kind: "commit", actorPubkey: ADMIN });
    const work = advanced.publish[0];
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    session.confirmPublished(work.pending);
    const before = serializeClientState(session.state);
    const wrap = vi.spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage");
    release.resolve();
    await rejected;
    expect(serializeClientState(session.state)).toEqual(before);
    expect(session.lifecycle).toBe("Stable");
    expect(wrap).not.toHaveBeenCalled();
    wrap.mockRestore();
    session.dispose();
  });

  it.each(["builder", "wrap"] as const)(
    "fences destruction during fallible %s preparation without pending state",
    async (seam) => {
      const session = await makeSession();
      const entered = deferred(),
        release = deferred();
      const original = NostrGroupPeeler.prototype.wrapGroupMessage;
      const wrap =
        seam === "wrap"
          ? vi
              .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
              .mockImplementation(async function (
                this: NostrGroupPeeler,
                ...args
              ) {
                entered.resolve();
                await release.promise;
                return original.apply(this, args);
              })
          : undefined;
      const before = serializeClientState(session.state);
      const pending = session.send({
        kind: "commit",
        actorPubkey: ADMIN,
        expectedParent: session.parentToken,
        extraProposals: [
          async () => {
            if (seam === "builder") {
              entered.resolve();
              await release.promise;
            }
            return clearImageProposal();
          },
        ],
      });
      const rejected = expect(pending).rejects.toThrow("Group destroyed");
      await entered.promise;
      const destruction = session.destroyLocalState();
      release.resolve();
      await rejected;
      await destruction;
      expect(serializeClientState(session.state)).toEqual(before);
      expect(session.lifecycle).toBe("Stable");
      wrap?.mockRestore();
    },
  );

  it("distinguishes same-epoch confirmation evidence and unrelated group identity", async () => {
    const session = await makeSession();
    const token = session.parentToken;
    const epoch = session.state.groupContext.epoch;
    session.state.confirmationTag = session.state.confirmationTag.slice();
    session.state.confirmationTag[0] ^= 1;
    expect(session.state.groupContext.epoch).toBe(epoch);
    expect(session.parentToken).not.toBe(token);
    const other = await makeSession();
    expect(other.parentToken).not.toBe(session.parentToken);
    session.dispose();
    other.dispose();
  });
});

describe("durable delivered evidence validation", () => {
  it("restores root evidence without inventing a digest and rejects malformed provenance", async () => {
    const ciphersuite = await getImpl();
    const state = await createAdminState(ciphersuite);
    const storage = memoryStorage();
    const session = new GroupSession({
      state,
      ciphersuite,
      storage,
    });
    await session.send({
      kind: "applicationMessage",
      payload: serializeApplicationRumor(rumorFrom(ADMIN, "root evidence")),
    });
    const bytes = (await storage.get(
      `${bytesToHex(session.id)}/ingest/delivered`,
    ))!;
    const evidence = decodeDeliveredEvidence(bytes, session.historyTree);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0].commitDigest).toBeUndefined();
    const mutate = (change: (entry: any) => void) => {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      change(value.entries[0]);
      return new TextEncoder().encode(JSON.stringify(value));
    };
    for (const change of [
      (entry: any) => {
        entry.commitDigest = "ff".repeat(32);
      },
      (entry: any) => {
        entry.transportId = "ff".repeat(32);
      },
      (entry: any) => {
        entry.epoch++;
      },
      (entry: any) => {
        entry.stateTag = "ff".repeat(32);
      },
      (entry: any) => {
        entry.rumorId = "ff".repeat(32);
      },
      (entry: any) => {
        entry.message += "00";
      },
      (entry: any) => {
        const rumor = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(
              entry.payload
                .match(/../g)
                .map((byte: string) => parseInt(byte, 16)),
            ),
          ),
        );
        rumor.sig = "forged";
        entry.payload = bytesToHex(
          new TextEncoder().encode(JSON.stringify(rumor)),
        );
      },
    ])
      expect(() =>
        decodeDeliveredEvidence(mutate(change), session.historyTree),
      ).toThrow();
    session.dispose();
  });
});

type EngineUnreadableIngestResult = Extract<
  EngineIngestResult<import("applesauce-core/helpers/event").NostrEvent>,
  { kind: "unreadable" }
>;

// WR-12: public session variants must inherit every engine-only field while
// replacing only the transport envelope name at the Nostr boundary.
expectTypeOf<UnreadableIngestResult>().toEqualTypeOf<
  Omit<EngineUnreadableIngestResult, "envelope"> & {
    event: import("applesauce-core/helpers/event").NostrEvent;
  }
>();
expectTypeOf<UnreadableIngestResult["decryptFailure"]>().toEqualTypeOf<
  boolean | undefined
>();

/** Builds a kind-9 rumor authored by `pubkey` with a canonical NIP-01 id. */
function rumorFrom(pubkey: string, content: string): Rumor {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey,
    created_at: 1000,
    content,
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

async function getImpl(): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
}

async function createAdminState(impl: CiphersuiteImpl) {
  const credential = createCredential(ADMIN);
  const kp = await generateKeyPackage({
    credential,
    ciphersuiteImpl: impl,
    signer: ADMIN_ACCOUNT.signer,
  });
  const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
    adminPubkeys: [ADMIN],
    relays: ["wss://relay.test"],
  });
  return clientState;
}

/**
 * Builds a two-member group sharing one epoch: the admin adds a member via a
 * commit and the member joins from the resulting Welcome.
 */
async function createTwoMemberStates(impl: CiphersuiteImpl) {
  const adminState = await createAdminState(impl);

  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER),
    ciphersuiteImpl: impl,
    signer: MEMBER_ACCOUNT.signer,
  });

  const { newState: adminEpoch1, welcome } = await createCommit({
    context: {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    },
    state: adminState,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  const memberEpoch1 = await joinGroup({
    context: {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    },
    welcome: welcome!.welcome,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  return { adminEpoch1, memberEpoch1 };
}

function makeSession(
  state: import("ts-mls").ClientState,
  impl: CiphersuiteImpl,
  overrides: Partial<import("../group-session.js").GroupSessionOptions> = {},
) {
  return new GroupSession({
    state,
    ciphersuite: impl,
    storage: memoryStorage(),
    ...overrides,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GroupSession send intent effects", () => {
  it("waits for an admitted disband write, rejects its effects, and purges lifecycle stores", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const id = bytesToHex(state.groupContext.groupId);
    const storage = memoryStorage();
    const session = makeSession(state, impl, { storage });
    await session.hydrateLifecycleEvidence();
    await storage.set("other/disband/request", new Uint8Array([1]));
    const entered = deferred();
    const release = deferred();
    const write = storage.set.bind(storage);
    vi.spyOn(storage, "set").mockImplementation(
      async (key: string, value: Uint8Array) => {
        if (key === `${id}/disband/request`) {
          entered.resolve();
          await release.promise;
        }
        return write(key, value);
      },
    );
    const request = session.requestDisband();
    const rejected = expect(request).rejects.toThrow("Group destroyed");
    await entered.promise;
    let destroyed = false;
    const destruction = session.destroyLocalState().then(() => {
      destroyed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(destroyed).toBe(false);
    release.resolve();
    await Promise.all([destruction, rejected]);
    expect(await storage.list(`${id}/`)).toEqual([]);
    expect(await storage.get("other/disband/request")).toEqual(
      new Uint8Array([1]),
    );
    for (const call of [
      () => session.requestDisband(),
      () => session.disbandRequest(),
      () => session.enableGroupDisbanding(),
      () => session.leave(ADMIN),
      () => session.send({ kind: "selfUpdate" }),
    ])
      await expect(call()).rejects.toThrow("Group destroyed");
    await session.hydrateLifecycleEvidence();
    expect(await session.markDisbandNotificationDelivered()).toBeUndefined();
    expect(await storage.list("")).toEqual(["other/disband/request"]);
  });

  it.each(["selection", "notification"] as const)(
    "waits for an admitted %s write without recreating terminal data",
    async (boundary) => {
      const impl = await getImpl();
      const state = await createAdminState(impl);
      const storage = memoryStorage();
      const session = makeSession(state, impl, { storage });
      const evidence = {
        commitDigest: new Uint8Array(32).fill(9),
        actorPubkey: ADMIN,
        sourceEpoch: Number(state.groupContext.epoch),
        parentTag: bytesToHex(state.confirmationTag),
        terminalOutcome: "disbanded" as const,
      };
      await session.hydrateLifecycleEvidence();
      if (boundary === "notification")
        await session.persistSelectedDisband(evidence);
      const entered = deferred();
      const release = deferred();
      // Gate the first durable write the operation admits: the terminal
      // projection batch (selection) or the notification-state set.
      let gated = false;
      const gate = async () => {
        if (gated) return;
        gated = true;
        entered.resolve();
        await release.promise;
      };
      const write = storage.set.bind(storage);
      vi.spyOn(storage, "set").mockImplementation(
        async (key: string, value: Uint8Array) => {
          await gate();
          return write(key, value);
        },
      );
      const commit = storage.batch.bind(storage);
      vi.spyOn(storage, "batch").mockImplementation(
        async (ops: readonly StorageOp[]) => {
          await gate();
          return commit(ops);
        },
      );
      const operation =
        boundary === "selection"
          ? session.persistSelectedDisband(evidence)
          : session.markDisbandNotificationDelivered();
      const rejected = expect(operation).rejects.toThrow("Group destroyed");
      await entered.promise;
      let destroyed = false;
      const destruction = session.destroyLocalState().then(() => {
        destroyed = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(destroyed).toBe(false);
      release.resolve();
      await Promise.all([destruction, rejected]);
      expect(await storage.list("")).toEqual([]);
      await expect(session.persistSelectedDisband(evidence)).rejects.toThrow(
        "Group destroyed",
      );
    },
  );

  it("does not recreate registry state when terminal hydration finishes after closure", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const storage = memoryStorage();
    const key = disbandTombstoneKey(bytesToHex(state.groupContext.groupId));
    await storage.set(
      key,
      encodeDisbandTombstone({
        groupId: state.groupContext.groupId,
        selectedEpoch: Number(state.groupContext.epoch),
        commitDigest: new Uint8Array(32).fill(9),
        actorPubkey: ADMIN,
        notificationState: "pending",
      }),
    );
    const entered = deferred();
    const release = deferred();
    const read = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementation(async (itemKey: string) => {
      const value = await read(itemKey);
      if (itemKey === key) {
        entered.resolve();
        await release.promise;
      }
      return value;
    });
    const writes = vi.spyOn(storage, "set");
    const batches = vi.spyOn(storage, "batch");
    const session = makeSession(state, impl, { storage });
    await entered.promise;
    const destruction = session.destroyLocalState();
    release.resolve();
    await destruction;
    expect(writes).not.toHaveBeenCalled();
    expect(
      batches.mock.calls
        .flatMap(([ops]) => ops)
        .filter((op) => op.type === "set"),
    ).toEqual([]);
    expect(await storage.list("")).toEqual([]);
  });

  it("writes selected terminal evidence before clearing live and work state", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const id = bytesToHex(state.groupContext.groupId);
    const operations: string[] = [];
    const storage = memoryStorage();
    await storage.set(`${id}/state`, new Uint8Array([1]));
    await storage.set(
      `${id}/disband/request`,
      encodeDisbandRequest({
        status: "pending",
        requestedAtMs: 1,
        lastPreparedEpoch: null,
      }),
    );
    await storage.set(`${id}/ingest/effect/work`, new Uint8Array([1]));
    const commit = storage.batch.bind(storage);
    vi.spyOn(storage, "batch").mockImplementation(
      async (ops: readonly StorageOp[]) => {
        for (const op of ops) operations.push(`${op.type}:${op.key}`);
        return commit(ops);
      },
    );
    const write = storage.set.bind(storage);
    vi.spyOn(storage, "set").mockImplementation(async (key, value) => {
      operations.push(`set:${key}`);
      return write(key, value);
    });
    const remove = storage.delete.bind(storage);
    vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      operations.push(`delete:${key}`);
      return remove(key);
    });

    const session = makeSession(state, impl, { storage });
    await session.persistSelectedDisband({
      commitDigest: new Uint8Array(32).fill(9),
      actorPubkey: ADMIN,
      sourceEpoch: Number(state.groupContext.epoch),
      parentTag: bytesToHex(state.confirmationTag),
      terminalOutcome: "disbanded",
    });

    expect(operations[0]).toBe(`set:${disbandTerminalIntentKey(id)}`);
    expect(await storage.get(`${id}/disband/request`)).toBeUndefined();
    expect(await storage.get(`${id}/ingest/effect/work`)).toEqual(
      new Uint8Array([1]),
    );
    expect(operations.indexOf(`delete:${id}/state`)).toBeGreaterThan(0);
  });

  it("hydrates terminal authority over stale live state and rejects corrupt evidence", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const id = bytesToHex(state.groupContext.groupId);
    const storage = memoryStorage();
    const session = makeSession(state, impl, { storage });
    await session.persistSelectedDisband({
      commitDigest: new Uint8Array(32).fill(8),
      actorPubkey: ADMIN,
      sourceEpoch: Number(state.groupContext.epoch),
      parentTag: bytesToHex(state.confirmationTag),
      terminalOutcome: "disbanded",
    });

    const restarted = makeSession(state, impl, { storage });
    expect((await restarted.disbandTombstone())?.actorPubkey).toBe(ADMIN);

    await storage.set(
      disbandTombstoneKey(id),
      new TextEncoder().encode('{"version":99}'),
    );
    const corrupt = makeSession(state, impl, { storage });
    await expect(corrupt.disbandTombstone()).rejects.toThrow(
      "Invalid disband tombstone",
    );
  });

  it("persists a disband request before exposing its candidate and gates later sends", async () => {
    const impl = await getImpl();
    const storage = memoryStorage();
    const session = makeSession(await createAdminState(impl), impl, {
      storage,
    });

    const effects = await session.requestDisband();
    expect(effects.publish).toHaveLength(1);
    expect(
      (await storage.list("")).some((key) => key.endsWith("/disband/request")),
    ).toBe(true);
    await expect(
      session.send({
        kind: "applicationMessage",
        payload: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ reason: "disbanding" });
  });

  it("produces an application-message publish effect", async () => {
    const impl = await getImpl();
    const session = makeSession(await createAdminState(impl), impl);

    const payload = new TextEncoder().encode("hello");
    const effects = await session.send({ kind: "applicationMessage", payload });

    expect(effects.publish).toHaveLength(1);
    const [work] = effects.publish;
    expect(work.kind).toBe("applicationMessage");
    expect(work.envelope.kind).toBe(445);
  });

  it("produces a commit (groupEvolution) effect carrying pending state", async () => {
    const impl = await getImpl();
    const session = makeSession(await createAdminState(impl), impl);

    const effects = await session.send({
      kind: "commit",
      actorPubkey: ADMIN,
      extraProposals: [],
    });

    expect(effects.publish).toHaveLength(1);
    const [work] = effects.publish;
    expect(work.kind).toBe("groupEvolution");
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    expect(work.actorPubkey).toBe(ADMIN);
    expect(work.pending).toBeDefined();
  });

  it("produces a self-update effect carrying pending state", async () => {
    const impl = await getImpl();
    const session = makeSession(await createAdminState(impl), impl);

    const effects = await session.send({ kind: "selfUpdate" });

    expect(effects.publish).toHaveLength(1);
    expect(effects.publish[0].kind).toBe("selfUpdate");
  });
});

describe("GroupSession confirm/rollback", () => {
  it("returns to Stable and advances the epoch after confirmPublished", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const session = makeSession(state, impl);
    const startEpoch = state.groupContext.epoch;

    const effects = await session.send({
      kind: "commit",
      actorPubkey: ADMIN,
      extraProposals: [],
    });
    expect(session.lifecycle).toBe("PendingPublish");

    const work = effects.publish[0];
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    session.confirmPublished(work.pending);

    expect(session.lifecycle).toBe("Stable");
    expect(session.state.groupContext.epoch).toBe(startEpoch + 1n);
  });

  it("returns to Stable without advancing the epoch after publishFailed", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const session = makeSession(state, impl);
    const startEpoch = state.groupContext.epoch;

    const effects = await session.send({
      kind: "commit",
      actorPubkey: ADMIN,
      extraProposals: [],
    });
    const work = effects.publish[0];
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    session.publishFailed(work.pending);

    expect(session.lifecycle).toBe("Stable");
    expect(session.state.groupContext.epoch).toBe(startEpoch);
  });
});

describe("GroupSession self-echo ingest", () => {
  it("skips a sent application message echoed back from the relay", async () => {
    const impl = await getImpl();
    const onApplicationMessage = vi.fn();
    const session = makeSession(await createAdminState(impl), impl, {
      onApplicationMessage,
    });

    const payload = new TextEncoder().encode("self echo");
    const effects = await session.send({ kind: "applicationMessage", payload });
    const envelope = effects.publish[0].envelope;

    const results = [];
    for await (const result of session.ingest([envelope])) results.push(result);

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    if (results[0].kind !== "skipped") throw new Error("expected skipped");
    expect(results[0].reason).toBe("self-echo");
    // The echo must not be re-delivered to the application.
    expect(onApplicationMessage).not.toHaveBeenCalled();
  });
});

describe("GroupSession history persistence", () => {
  it("persists outbound application messages and reports history errors", async () => {
    const impl = await getImpl();
    const error = new Error("disk full");
    const history = {
      saveMessage: vi.fn(async () => {
        throw error;
      }),
      purgeMessages: vi.fn(async () => {}),
      removeMessage: vi.fn(async (_rumorId: string) => {}),
    };
    const onHistoryError = vi.fn();
    const session = makeSession(await createAdminState(impl), impl, {
      history,
      onHistoryError,
    });

    const payload = new TextEncoder().encode("stored");
    // Send resolves even though history persistence fails (best-effort).
    await session.send({ kind: "applicationMessage", payload });

    expect(history.saveMessage).toHaveBeenCalledWith(payload);
    expect(onHistoryError).toHaveBeenCalledWith(error);
  });

  it("persists and emits inbound application messages from other members", async () => {
    const impl = await getImpl();
    const { adminEpoch1, memberEpoch1 } = await createTwoMemberStates(impl);

    const history = {
      saveMessage: vi.fn(async () => {}),
      purgeMessages: vi.fn(async () => {}),
      removeMessage: vi.fn(async (_rumorId: string) => {}),
    };
    const onApplicationMessage = vi.fn();
    const adminSession = makeSession(adminEpoch1, impl, {
      history,
      onApplicationMessage,
    });
    const memberSession = makeSession(memberEpoch1, impl);

    // The inner app event must be authored by the MLS sender (MEMBER); a bare
    // text payload would now be rejected as a non-conformant inner event.
    const payload = serializeApplicationRumor(rumorFrom(MEMBER, "from member"));
    const effects = await memberSession.send({
      kind: "applicationMessage",
      payload,
    });
    const envelope = effects.publish[0].envelope;

    const results = [];
    for await (const result of adminSession.ingest([envelope]))
      results.push(result);

    const processed = results.find((r) => r.kind === "processed");
    expect(processed).toBeDefined();
    expect(history.saveMessage).toHaveBeenCalledOnce();
    expect(onApplicationMessage).toHaveBeenCalledOnce();
    expect(onApplicationMessage.mock.calls[0][0]).toEqual(payload);
  });
});

describe("GroupSession application-message authorship (M3)", () => {
  it("rejects an app message whose inner pubkey is not the MLS sender", async () => {
    const impl = await getImpl();
    const { adminEpoch1, memberEpoch1 } = await createTwoMemberStates(impl);

    const history = {
      saveMessage: vi.fn(async () => {}),
      purgeMessages: vi.fn(async () => {}),
      removeMessage: vi.fn(async (_rumorId: string) => {}),
    };
    const onApplicationMessage = vi.fn();
    const adminSession = makeSession(adminEpoch1, impl, {
      history,
      onApplicationMessage,
    });
    const memberSession = makeSession(memberEpoch1, impl);

    // MEMBER sends, but forges ADMIN as the inner author. The MLS layer
    // authenticates the sender as MEMBER, so the binding must reject it.
    const payload = serializeApplicationRumor(
      rumorFrom(ADMIN, "forged author"),
    );
    const effects = await memberSession.send({
      kind: "applicationMessage",
      payload,
    });

    const results = [];
    for await (const result of adminSession.ingest([
      effects.publish[0].envelope,
    ]))
      results.push(result);

    expect(results.find((r) => r.kind === "processed")).toBeUndefined();
    const skipped = results.find((r) => r.kind === "skipped");
    expect(skipped?.reason).toBe("invalid-app-payload");
    expect(skipped?.disposition).toEqual({
      kind: "stale",
      category: "invalid_encoding",
    });
    expect(onApplicationMessage).not.toHaveBeenCalled();
    expect(history.saveMessage).not.toHaveBeenCalled();
  });

  it("rejects an app message whose inner id is not canonical", async () => {
    const impl = await getImpl();
    const { adminEpoch1, memberEpoch1 } = await createTwoMemberStates(impl);

    const onApplicationMessage = vi.fn();
    const adminSession = makeSession(adminEpoch1, impl, {
      onApplicationMessage,
    });
    const memberSession = makeSession(memberEpoch1, impl);

    // Correct author (MEMBER) but a tampered, non-canonical id.
    const tampered = rumorFrom(MEMBER, "tampered id");
    tampered.id = "0".repeat(64);
    // Raw bytes: serializeApplicationRumor refuses to emit a non-canonical id.
    const effects = await memberSession.send({
      kind: "applicationMessage",
      payload: new TextEncoder().encode(JSON.stringify(tampered)),
    });

    const results = [];
    for await (const result of adminSession.ingest([
      effects.publish[0].envelope,
    ]))
      results.push(result);

    expect(results.find((r) => r.kind === "processed")).toBeUndefined();
    expect(results.find((r) => r.kind === "skipped")?.reason).toBe(
      "invalid-app-payload",
    );
    expect(onApplicationMessage).not.toHaveBeenCalled();
  });
});

describe("GroupSession save lifecycle", () => {
  it("destroy waits for ledger hydration and prevents late hydration or saves from recreating plaintext", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const storage = memoryStorage();
    const original = makeSession(state, impl, { storage });
    await original.send({
      kind: "applicationMessage",
      payload: serializeApplicationRumor(rumorFrom(ADMIN, "private hydration")),
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementation(async (key: string) => {
      const bytes = await get(key);
      if (key.endsWith("/ingest/delivered")) await blocked;
      return bytes;
    });
    const session = makeSession(original.state, impl, {
      storage,
      historyTree: original.historyTree,
    });
    const destruction = session.destroyLocalState();
    release();
    await destruction;
    await session.hydrateLifecycleEvidence();
    await session.save(true);
    expect(await storage.list("")).toEqual([]);
    await expect(
      session.send({
        kind: "applicationMessage",
        payload: serializeApplicationRumor(rumorFrom(ADMIN, "late send")),
      }),
    ).rejects.toThrow("Group destroyed");
    await session.destroyLocalState();
    original.dispose();
  });

  it("only writes to the store when dirty, or when forced", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const storage = memoryStorage();
    const onStateSaved = vi.fn();
    const session = makeSession(state, impl, { storage, onStateSaved });
    const key = `${bytesToHex(state.groupContext.groupId)}/state`;

    // The fork-history tree is always persisted now: a fresh session's seeded
    // root is unflushed, so the first save commits it with the canonical state.
    expect(session.historyTree.isDirty).toBe(true);
    await session.save();
    expect(await storage.get(key)).toBeDefined();
    expect(onStateSaved).toHaveBeenCalledOnce();

    // Clean session: a plain save does not rewrite the canonical state (only
    // the delivered-payload evidence, which every save refreshes).
    const batch = vi.spyOn(storage, "batch");
    const set = vi.spyOn(storage, "set");
    const writtenKeys = () => [
      ...batch.mock.calls.flatMap(([ops]) => ops.map((op) => op.key)),
      ...set.mock.calls.map(([written]) => written),
    ];
    await session.save();
    expect(writtenKeys()).not.toContain(key);
    expect(onStateSaved).toHaveBeenCalledOnce();

    // Forced save persists the state even when not dirty.
    await session.save(true);
    expect(writtenKeys()).toContain(key);
    expect(onStateSaved).toHaveBeenCalledTimes(2);
  });
});
