import type { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  type ClientState,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import { convergenceStatuses } from "../../core/convergence-status.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { memoryGroupDatabase } from "../helpers/database.js";
import { testAccount } from "../helpers/test-accounts.js";

const RELAY = "wss://relay.test";
const QUIESCENCE_MS = 1_000;

function recordingNetwork(published: NostrEvent[]): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async (_relays, event) => {
      published.push(event);
      return { [RELAY]: { from: RELAY, ok: true } satisfies PublishResponse };
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

/** A controllable fake clock. */
function fakeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A controllable fake settle-timer: `fire()` invokes the pending callback. */
function controllableScheduler() {
  let pending: (() => void) | null = null;
  return {
    scheduler: {
      setTimer: (_ms: number, cb: () => void) => {
        pending = cb;
        return {};
      },
      clearTimer: () => {
        pending = null;
      },
    },
    fire: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

function marmotGroup(
  state: ClientState,
  signer: EventSigner,
  impl: CiphersuiteImpl,
  published: NostrEvent[],
  now: () => number,
  scheduler?: {
    setTimer: (ms: number, cb: () => void) => unknown;
    clearTimer: (h: unknown) => void;
  },
) {
  return new MarmotGroup(state, {
    database: memoryGroupDatabase(),
    signer,
    ciphersuite: impl,
    network: recordingNetwork(published),
    now,
    settlementQuiescenceMs: QUIESCENCE_MS,
    scheduler,
  });
}

describe("convergence status (B5, increment 2)", () => {
  it("starts Settled, goes Syncing on a commit, then Settled after the quiescence window", async () => {
    const adminAccount = testAccount(6);
    const dAccount = testAccount(9);
    const adminPubkey = adminAccount.pubkey;
    const dPubkey = dAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 2-member group: admin "a" (leaf 0), "d" (leaf 1).
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const dKp = await generateKeyPackage({
      credential: createCredential(dPubkey),
      signer: dAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { newState: adminEpoch1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    if (!welcome) throw new Error("expected the Add commit Welcome");
    const welcomeMsg = welcome.welcome;
    const dEpoch1 = await joinGroup({
      context: ctx,
      welcome: welcomeMsg,
      keyPackage: dKp.publicPackage,
      privateKeys: dKp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin makes a self-update commit (epoch 1 -> 2) for "d" to ingest, and an
    // application message at epoch 1 (which is NOT convergence-relevant).
    const { commit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const commitEvent = await createGroupEvent({
      message: commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const { message: appMessage } = await createApplicationMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
        externalPsks: {},
      },
      state: adminEpoch1,
      message: new TextEncoder().encode("hi"),
    });
    const appEvent = await createGroupEvent({
      message: appMessage,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const clock = fakeClock(100_000);
    const published: NostrEvent[] = [];
    const dGroup = marmotGroup(
      dEpoch1,
      dAccount.signer,
      impl,
      published,
      clock.now,
    );

    // A freshly loaded group has no pending convergence input -> Settled.
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);

    // An application message is NOT convergence-relevant: it must not reset the
    // quiescence window, so the status stays Settled.
    for await (const _ of dGroup.ingest([appEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);

    // Ingesting a commit IS convergence-relevant: the quiescence window resets,
    // so status is Syncing immediately after.
    for await (const _ of dGroup.ingest([commitEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);

    // Still within the window -> still Syncing.
    clock.advance(QUIESCENCE_MS - 1);
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);

    // Window elapses with a clean fixed point -> Settled.
    clock.advance(1);
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);
  });

  it("queues an outbound send while Syncing and drains it once the window settles (Inc 3)", async () => {
    const adminAccount = testAccount(6);
    const dAccount = testAccount(9);
    const adminPubkey = adminAccount.pubkey;
    const dPubkey = dAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const dKp = await generateKeyPackage({
      credential: createCredential(dPubkey),
      signer: dAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { newState: adminEpoch1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    if (!welcome) throw new Error("expected the Add commit Welcome");
    const welcomeMsg = welcome.welcome;
    const dEpoch1 = await joinGroup({
      context: ctx,
      welcome: welcomeMsg,
      keyPackage: dKp.publicPackage,
      privateKeys: dKp.privatePackage,
      ratchetTree: undefined,
    });
    const { commit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const commitEvent = await createGroupEvent({
      message: commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const clock = fakeClock(100_000);
    const { scheduler, fire } = controllableScheduler();
    const published: NostrEvent[] = [];
    const dGroup = marmotGroup(
      dEpoch1,
      dAccount.signer,
      impl,
      published,
      clock.now,
      scheduler,
    );

    // Ingesting the commit drives the group to Syncing and arms the settle timer.
    for await (const _ of dGroup.ingest([commitEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);

    // Sending while Syncing must NOT publish yet — it queues, promise pending.
    const sendPromise = dGroup.submitIntent({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("queued while syncing"),
    });
    let settledEarly = false;
    void sendPromise.then(() => (settledEarly = true));
    await Promise.resolve();
    expect(published).toHaveLength(0);
    expect(settledEarly).toBe(false);

    // The window elapses; firing the settle timer drains the queue and publishes.
    clock.advance(QUIESCENCE_MS);
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);
    fire();
    const results = await sendPromise;
    expect(published).toHaveLength(1);
    expect(results.length).toBeGreaterThan(0);
  });
});

/** A fake settle-timer that records each requested delay. */
function recordingScheduler() {
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  return {
    delays,
    hasPending: () => pending !== undefined,
    scheduler: {
      setTimer: (ms: number, cb: () => void) => {
        delays.push(ms);
        pending = cb;
        return {};
      },
      clearTimer: () => {
        pending = undefined;
      },
    },
    fire: () => {
      const cb = pending;
      pending = undefined;
      cb?.();
    },
  };
}

/** Lets the fire-and-forget settle callback run to completion. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 2-member group ("a" admin, "d"): returns d's epoch-1 state, an admin
 * self-update commit (epoch 1 -> 2) for d to ingest, and an epoch-2
 * application message from the admin.
 */
async function twoMemberGroup() {
  const adminAccount = testAccount(6);
  const dAccount = testAccount(9);
  const adminPubkey = adminAccount.pubkey;
  const dPubkey = dAccount.pubkey;
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(
    adminKp,
    impl,
    "Group",
    { adminPubkeys: [adminPubkey], relays: [RELAY] },
  );
  const dKp = await generateKeyPackage({
    credential: createCredential(dPubkey),
    signer: dAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { newState: adminEpoch1, welcome } = await createCommit({
    context: ctx,
    state: created,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: dKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const welcomeMsg = welcome!.welcome ?? (welcome as never);
  const dEpoch1 = await joinGroup({
    context: ctx,
    welcome: welcomeMsg,
    keyPackage: dKp.publicPackage,
    privateKeys: dKp.privatePackage,
    ratchetTree: undefined,
  });
  const { commit, newState: adminEpoch2 } = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const commitEvent = await createGroupEvent({
    message: commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });
  const { message: appMessage } = await createApplicationMessage({
    context: { ...ctx, externalPsks: {} },
    state: adminEpoch2,
    message: new TextEncoder().encode("after the commit"),
  });
  const appEvent = await createGroupEvent({
    message: appMessage,
    state: adminEpoch2,
    ciphersuite: impl,
  });
  return { impl, dSigner: dAccount.signer, dEpoch1, commitEvent, appEvent };
}

describe("settle-check liveness (#109)", () => {
  it("re-arms when the settle timer fires before the engine clock reaches the cutoff", async () => {
    const { impl, dSigner, dEpoch1, commitEvent } = await twoMemberGroup();
    const clock = fakeClock(100_000);
    const timer = recordingScheduler();
    const published: NostrEvent[] = [];
    const dGroup = marmotGroup(
      dEpoch1,
      dSigner,
      impl,
      published,
      clock.now,
      timer.scheduler,
    );

    for await (const _ of dGroup.ingest([commitEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);
    expect(timer.delays).toEqual([QUIESCENCE_MS]);

    const sendPromise = dGroup.submitIntent({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("sent during the settle window"),
    });

    // The timer fires 1 ms before the cutoff by the engine clock (a different
    // clock source or timer coarsening). Nothing may be released yet, and a
    // follow-up check must stay armed so the queue is not stranded.
    clock.advance(QUIESCENCE_MS - 1);
    timer.fire();
    await flush();
    expect(published).toHaveLength(0);
    expect(timer.hasPending()).toBe(true);

    // A timer that keeps firing early against a frozen clock re-arms with a
    // 1 ms floor rather than a 0 ms spin.
    timer.fire();
    await flush();
    expect(published).toHaveLength(0);
    expect(timer.delays).toEqual([QUIESCENCE_MS, 1, 1]);

    // Once the window really elapses the re-armed check drains the queue.
    clock.advance(1);
    timer.fire();
    const results = await sendPromise;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);
    expect(published).toHaveLength(1);
    expect(results.length).toBeGreaterThan(0);
    expect(timer.hasPending()).toBe(false);
  });

  it("drains queued outbound after resuming retained non-commit input", async () => {
    const { impl, dSigner, dEpoch1, commitEvent, appEvent } =
      await twoMemberGroup();
    const clock = fakeClock(100_000);
    const timer = recordingScheduler();
    const published: NostrEvent[] = [];
    const dGroup = marmotGroup(
      dEpoch1,
      dSigner,
      impl,
      published,
      clock.now,
      timer.scheduler,
    );

    for await (const _ of dGroup.ingest([commitEvent])) void _;
    const sendPromise = dGroup.submitIntent({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("queued behind retained input"),
    });

    // A non-commit message arriving at the pass deadline is retained and
    // the pass closes; the continuation wake replaces the settle timer.
    clock.advance(5_000);
    for await (const _ of dGroup.ingest([appEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);

    // Resuming that input is not convergence-relevant, so no further settle
    // check is armed: this wake is the only chance to release the queue.
    timer.fire();
    await vi.waitFor(() => expect(published).toHaveLength(1));
    await expect(sendPromise).resolves.not.toHaveLength(0);
    expect(timer.hasPending()).toBe(false);
  });
});
