import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { IngestionPool } from "../ingestion-pool.js";
import type { GroupPeeler } from "../types.js";

const ADMIN = "a".repeat(64);
const MEMBER = "e".repeat(64);

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

async function drain<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

describe("MarmotGroupEngine ingestion pool", () => {
  it("holds a future-epoch event delivered before its commit, then reads it once the epoch is reached", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // Admin creates a group and adds a member → both reach epoch 1.
    const adminKp = await generateKeyPackage({
      credential: createCredential(ADMIN),
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Pool Group",
      { adminPubkeys: [ADMIN], relays: ["wss://mock.test"] },
    );
    const memberKp = await generateKeyPackage({
      credential: createCredential(MEMBER),
      ciphersuiteImpl: impl,
    });
    const { newState: adminE1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const memberE1 = await joinGroup({
      context: ctx,
      welcome: welcome!.welcome ?? (welcome as never),
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin builds two sequential commits: epoch 1→2 and 2→3. The epoch-2 commit
    // is wrapped with the epoch-2 exporter key, so a member still at epoch 1
    // cannot decrypt it until it advances.
    const commit12 = await createCommit({
      context: ctx,
      state: adminE1,
      extraProposals: [],
    });
    const commit23 = await createCommit({
      context: ctx,
      state: commit12.newState,
      extraProposals: [],
    });
    const event12 = await createGroupEvent({
      message: commit12.commit,
      state: adminE1,
      ciphersuite: impl,
    });
    const event23 = await createGroupEvent({
      message: commit23.commit,
      state: commit12.newState,
      ciphersuite: impl,
    });

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberE1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    // Deliver the epoch-2 commit FIRST (out of order, as a relay would stream
    // it). The member cannot decrypt it yet → it is pooled, not dropped, and no
    // terminal result is surfaced.
    const first = await drain(engine.ingest([event23]));
    expect(first.some((r) => r.kind === "processed")).toBe(false);
    expect(first.some((r) => r.kind === "unreadable")).toBe(false);
    expect(engine.pendingCount).toBe(1);
    expect(Number(engine.state.groupContext.epoch)).toBe(1);

    // The unlocking commit arrives in a later batch → the member advances to
    // epoch 2, the pool is swept, and the previously-undecryptable commit is now
    // read and applied, reaching epoch 3.
    const second = await drain(engine.ingest([event12]));
    expect(second.filter((r) => r.kind === "processed")).toHaveLength(2);
    expect(engine.pendingCount).toBe(0);
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
  });

  it("bounds the pool by size and epoch-age", () => {
    const pool = new IngestionPool<{ id: string }>({
      maxSize: 2,
      maxEpochAge: 5,
    });

    pool.add("a", { id: "a" }, 0);
    pool.add("b", { id: "b" }, 0);
    pool.add("a", { id: "a" }, 9); // re-add keeps original arrival epoch
    expect(pool.size).toBe(2);

    // Overflow evicts the oldest entry.
    pool.add("c", { id: "c" }, 1);
    expect(pool.size).toBe(2);
    expect(pool.has("a")).toBe(false);

    // Entries whose arrival the tip has aged past `maxEpochAge` are dropped.
    const evicted = pool.evictStale(10);
    expect(evicted.map((e) => e.id).sort()).toEqual(["b", "c"]);
    expect(pool.size).toBe(0);
  });
});
