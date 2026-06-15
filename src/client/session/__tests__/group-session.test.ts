import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra";
import { GroupSession } from "../group-session.js";

const ADMIN = "a".repeat(64);
const MEMBER = "b".repeat(64);

async function getImpl(): Promise<CiphersuiteImpl> {
  return getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
}

async function createAdminState(impl: CiphersuiteImpl) {
  const credential = createCredential(ADMIN);
  const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
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
  overrides: Partial<
    import("../group-session.js").GroupSessionOptions<any>
  > = {},
) {
  return new GroupSession({
    state,
    ciphersuite: impl,
    store: new InMemoryKeyValueStore<SerializedClientState>(),
    ...overrides,
  });
}

describe("GroupSession send intent effects", () => {
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
    };
    const onApplicationMessage = vi.fn();
    const adminSession = makeSession(adminEpoch1, impl, {
      history,
      onApplicationMessage,
    });
    const memberSession = makeSession(memberEpoch1, impl);

    const payload = new TextEncoder().encode("from member");
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

describe("GroupSession save lifecycle", () => {
  it("only writes to the store when dirty, or when forced", async () => {
    const impl = await getImpl();
    const state = await createAdminState(impl);
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const onStateSaved = vi.fn();
    const session = makeSession(state, impl, { store, onStateSaved });
    const key = bytesToHex(state.groupContext.groupId);

    // Clean session: a plain save is a no-op.
    await session.save();
    expect(await store.getItem(key)).toBeNull();
    expect(onStateSaved).not.toHaveBeenCalled();

    // Forced save persists the initial state even when not dirty.
    await session.save(true);
    expect(await store.getItem(key)).not.toBeNull();
    expect(onStateSaved).toHaveBeenCalledOnce();
  });
});
