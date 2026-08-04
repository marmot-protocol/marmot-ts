import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type ProposalRemove,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

const RELAY = "wss://relay.test";

/** Same shape as group-engine.test.ts's local `testPeeler` helper. */
function testPeeler(ciphersuite: CiphersuiteImpl): GroupPeeler<NostrEvent> {
  return {
    async peelGroupMessages(envelopes, state) {
      const { read, unreadable } = await decryptGroupMessages(
        envelopes,
        state,
        ciphersuite,
      );
      return {
        read: read.map(({ event, message }) => ({ envelope: event, message })),
        unreadable,
      };
    },
    wrapGroupMessage(message, state) {
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
}

/** Wraps a peeler with a call counter so a test can assert `peelGroupMessages`
 * was (or was not) invoked for a given batch. */
function countingPeeler(inner: GroupPeeler<NostrEvent>): {
  peeler: GroupPeeler<NostrEvent>;
  calls: () => number;
} {
  let calls = 0;
  return {
    peeler: {
      async peelGroupMessages(envelopes, state) {
        calls++;
        return inner.peelGroupMessages(envelopes, state);
      },
      wrapGroupMessage: inner.wrapGroupMessage.bind(inner),
      idOf: inner.idOf.bind(inner),
    },
    calls: () => calls,
  };
}

/**
 * Builds a 3-member group (admin "a", "d", "e"), then has the admin commit a
 * `Remove` targeting "e" — an involuntary removal, exactly the fixture shape
 * used by `src/__tests__/integration/removed.test.ts`. Returns "e"'s
 * pre-removal `ClientState` and the wrapped removing-commit envelope; the
 * caller constructs the engine under test with whichever peeler it needs.
 */
async function buildRemovalFixture() {
  const adminPubkey = "a".repeat(64);
  const dPubkey = "d".repeat(64);
  const ePubkey = "e".repeat(64);
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
    ciphersuiteImpl: impl,
  });
  const eKp = await generateKeyPackage({
    credential: createCredential(ePubkey),
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
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: eKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const welcomeMsg = welcome!.welcome ?? (welcome as never);
  const eEpoch1 = await joinGroup({
    context: ctx,
    welcome: welcomeMsg,
    keyPackage: eKp.publicPackage,
    privateKeys: eKp.privatePackage,
    ratchetTree: undefined,
  });

  const removeE: ProposalRemove = {
    proposalType: defaultProposalTypes.remove,
    remove: { removed: eEpoch1.privatePath.leafIndex },
  };
  const { commit } = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [removeE],
  });
  const removeCommitEvent = await createGroupEvent({
    message: commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });

  return { impl, eEpoch1, removeCommitEvent };
}

/** Builds a `MarmotGroupEngine` for "e" and ingests the removing commit,
 * leaving the engine's canonical state as the `removedFromGroup` tombstone. */
async function buildRemovedEngine() {
  const { impl, eEpoch1, removeCommitEvent } = await buildRemovalFixture();
  const { peeler, calls } = countingPeeler(testPeeler(impl));
  const engine = new MarmotGroupEngine({
    state: eEpoch1,
    ciphersuite: impl,
    peeler,
  });

  const removalResults: { kind: string }[] = [];
  for await (const r of engine.ingest([removeCommitEvent]))
    removalResults.push(r);

  expect(removalResults.map((r) => r.kind)).toContain("removed");
  expect(engine.state.groupActiveState.kind).toBe("removedFromGroup");

  return { impl, engine, calls };
}

/** A minimal, deliberately-arbitrary transport envelope. The `self-evicted`
 * short-circuit classifies later input by canonical state alone, before any
 * peel/decrypt/auth work — so the bytes never need to be a real MLS message
 * (`member-departure.md`: "such input need not be decrypted or
 * authenticated"). */
function arbitraryEnvelope(id: string): NostrEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 0,
    kind: 445,
    tags: [],
    content: "",
    sig: "0".repeat(128),
  } as unknown as NostrEvent;
}

describe("self-eviction (CONV-02, D-13/D-14)", () => {
  it("classifies every envelope in a later batch as self-evicted, with no message field", async () => {
    const { engine } = await buildRemovedEngine();

    const later = [
      arbitraryEnvelope("f".repeat(64)),
      arbitraryEnvelope("1".repeat(64)),
    ];
    const results: { kind: string; reason?: string; message?: unknown }[] = [];
    for await (const r of engine.ingest(later)) results.push(r);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ kind: "skipped", reason: "self-evicted" });
      expect(r.message).toBeUndefined();
    }
  });

  it("carries the shared stale/stale_epoch disposition for a self-evicted result", async () => {
    const { engine } = await buildRemovedEngine();

    const results: { disposition: { kind: string; category?: string } }[] = [];
    for await (const r of engine.ingest([arbitraryEnvelope("2".repeat(64))]))
      results.push(r as never);

    expect(results).toHaveLength(1);
    expect(results[0].disposition).toEqual({
      kind: "stale",
      category: "stale_epoch",
    });
  });

  it("does not invoke the peeler for a batch classified self-evicted", async () => {
    const { engine, calls } = await buildRemovedEngine();
    const callsBefore = calls();

    for await (const _ of engine.ingest([
      arbitraryEnvelope("3".repeat(64)),
      arbitraryEnvelope("4".repeat(64)),
    ]))
      void _;

    // The engine under test is wired with a counting peeler (see
    // `countingPeeler`/`buildRemovedEngine`); a self-evicted batch must leave
    // the peel-call counter exactly where it was.
    expect(calls()).toBe(callsBefore);
  });

  it("rejects send() of any intent — applicationMessage and commit — once removed", async () => {
    const { engine } = await buildRemovedEngine();

    await expect(
      engine.send({
        kind: "applicationMessage",
        payload: new TextEncoder().encode("hello"),
      }),
    ).rejects.toThrow(/removed/i);

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: "e".repeat(64),
        extraProposals: [],
      }),
    ).rejects.toThrow(/removed/i);
  });

  it("rejects send() on a second engine constructed from the same serialized removed state (restart)", async () => {
    const { impl, engine } = await buildRemovedEngine();

    const serialized = serializeClientState(engine.state);
    const restarted = deserializeClientState(serialized);
    expect(restarted.groupActiveState.kind).toBe("removedFromGroup");

    const freshEngine = new MarmotGroupEngine({
      state: restarted,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      freshEngine.send({
        kind: "applicationMessage",
        payload: new TextEncoder().encode("hello"),
      }),
    ).rejects.toThrow(/removed/i);
  });
});
