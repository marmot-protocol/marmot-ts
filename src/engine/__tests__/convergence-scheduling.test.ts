import { describe, expect, it } from "vitest";
import {
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  type MlsMessage,
} from "ts-mls";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  DEFAULT_CONVERGENCE_POLICY,
  normalizeConvergencePolicy,
} from "../../core/convergence.js";
import { openConvergencePass, refreshConvergencePass } from "../types.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { marmotAuthService } from "../../core/auth-service.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { selectFairQueuedStateIntent } from "../../client/group/marmot-group.js";
import {
  groupLifecycleStates,
  mayApplyRetainedInbound,
} from "../../core/group-lifecycle.js";

type Envelope = { id: string };

async function fixture(
  now: () => number,
  scheduling?: {
    scheduler: {
      setTimer(delayMs: number, callback: () => void): unknown;
      clearTimer(handle: unknown): void;
    };
    onSettleCheck: () => void | Promise<void>;
  },
) {
  const adminAccount = testAccount(6);
  const admin = adminAccount.pubkey;
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const keyPackage = await generateKeyPackage({
    credential: createCredential(admin),
    signer: adminAccount.signer,
    ciphersuiteImpl: ciphersuite,
  });
  const { clientState: state } = await createSimpleGroup(
    keyPackage,
    ciphersuite,
    "scheduler",
    { adminPubkeys: [admin], relays: [] },
  );
  const messages = new Map<string, MlsMessage>();
  const makeCommit = async (id: string): Promise<Envelope> => {
    messages.set(
      id,
      (
        await createCommit({
          context: { cipherSuite: ciphersuite, authService: marmotAuthService },
          state,
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
          extraProposals: [],
        })
      ).commit,
    );
    return { id };
  };
  const engine = new MarmotGroupEngine<Envelope>({
    state,
    ciphersuite,
    now,
    settlementQuiescenceMs: 1_000,
    scheduler: scheduling?.scheduler,
    onSettleCheck: scheduling?.onSettleCheck,
    peeler: {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.map((envelope) => ({
            envelope,
            message: messages.get(envelope.id)!,
          })),
          unreadable: [],
        };
      },
      async wrapGroupMessage(message) {
        messages.set("local", message);
        return { id: "local" };
      },
      idOf(envelope) {
        return envelope.id;
      },
    },
  });
  return { admin, engine, makeCommit };
}

describe("bounded convergence scheduling", () => {
  it("starts Settled even when the monotonic clock is near its origin", async () => {
    const { engine } = await fixture(() => 0);
    expect(engine.convergenceStatus).toBe("Settled");
  });

  it("defaults older policy input to the immutable v1 pass bound", () => {
    const { maxConvergencePassMs: _, ...legacy } = DEFAULT_CONVERGENCE_POLICY;
    expect(normalizeConvergencePolicy(legacy).maxConvergencePassMs).toBe(5_000);
  });

  it("samples one monotonic deadline and never moves it for later input", () => {
    const pass = openConvergencePass(100, 5_000, 7, 12);
    expect(pass).toEqual({
      generation: 7,
      openedAtMs: 100,
      deadlineMs: 5_100,
      lastRelevantInputMs: 100,
      baseEpoch: 12,
    });
    expect(refreshConvergencePass(pass, 2_000)).toEqual({
      ...pass,
      lastRelevantInputMs: 2_000,
    });
    expect(refreshConvergencePass(pass, 2_000).deadlineMs).toBe(5_100);
  });

  it("treats the exact deadline as expired", () => {
    const pass = openConvergencePass(100, 5_000, 1, 12);
    expect(pass.deadlineMs > 5_099).toBe(true);
    expect(pass.deadlineMs <= 5_100).toBe(true);
  });

  it("retains exact-boundary input and resumes it deterministically", async () => {
    let nowMs = 100;
    const { engine, makeCommit } = await fixture(() => nowMs);
    engine.admitConvergencePass();
    expect(engine.convergencePass?.deadlineMs).toBe(5_100);

    nowMs = 5_100;
    const later = await makeCommit("later");
    const boundaryResults = [];
    for await (const result of engine.ingest([later]))
      boundaryResults.push(result);
    expect(boundaryResults).toHaveLength(0);
    expect(engine.retainedConvergenceInputCount).toBe(1);

    const resumed = await engine.driveConvergence();
    expect(resumed.length).toBeGreaterThan(0);
    expect(engine.retainedConvergenceInputCount).toBe(0);
    expect(engine.convergencePass?.generation).toBe(2);
  });

  it("re-arms an immediate continuation when deadline-edge ingest cancels the pass timer", async () => {
    let nowMs = 100;
    const timers = new Map<number, { delayMs: number; callback: () => void }>();
    let nextTimer = 1;
    let wakeups = 0;
    const { engine, makeCommit } = await fixture(() => nowMs, {
      scheduler: {
        setTimer(delayMs, callback) {
          const handle = nextTimer++;
          timers.set(handle, { delayMs, callback });
          return handle;
        },
        clearTimer(handle) {
          timers.delete(handle as number);
        },
      },
      onSettleCheck() {
        wakeups += 1;
      },
    });
    engine.admitConvergencePass();

    nowMs = 5_100;
    for await (const _ of engine.ingest([await makeCommit("deadline-edge")])) {
      // The expired pass retains this input and yields nothing.
    }

    expect(engine.retainedConvergenceInputCount).toBe(1);
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([0]);
    [...timers.values()][0]!.callback();
    expect(wakeups).toBe(1);
  });

  it("retains inbound while PendingPublish without opening a pass", async () => {
    let nowMs = 100;
    const { admin, engine, makeCommit } = await fixture(() => nowMs);
    await engine.send({ kind: "commit", actorPubkey: admin });
    const inbound = await makeCommit("pending");
    const results = [];
    for await (const result of engine.ingest([inbound])) results.push(result);
    expect(results).toHaveLength(0);
    expect(engine.convergencePass).toBeUndefined();
    expect(engine.retainedConvergenceInputCount).toBe(1);
    expect(mayApplyRetainedInbound(groupLifecycleStates.pendingPublish)).toBe(
      false,
    );
    expect(mayApplyRetainedInbound(groupLifecycleStates.merging)).toBe(false);
  });

  it("selects exactly one pre-existing group-state intent for fairness", () => {
    const queue = [
      { intent: { kind: "applicationMessage" as const } },
      { intent: { kind: "commit" as const } },
      { intent: { kind: "commit" as const } },
    ];
    expect(selectFairQueuedStateIntent(queue, 3)).toBe(1);
    expect(selectFairQueuedStateIntent(queue, 1)).toBeUndefined();
  });

  it("does not let a newly queued intent steal the settlement slot", () => {
    const queue = [{ intent: { kind: "applicationMessage" as const } }];
    const settledQueueLength = queue.length;
    queue.push({ intent: { kind: "commit" as const } });
    expect(
      selectFairQueuedStateIntent(queue, settledQueueLength),
    ).toBeUndefined();
  });
});
