/**
 * Tests that the ingest pipeline emits a retryable `deferred` disposition for a
 * commit whose source epoch is more than one ahead of the current epoch — its
 * intermediate parent commit has not arrived yet, so the input MUST be retried,
 * not terminally classified as `stale` (`protocol-core/inbound-processing.md`).
 */
import debug from "debug";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  type MlsMessage,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { marmotAuthService } from "../../core/auth-service.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { ingestResultDisposition } from "../ingest-disposition.js";
import { type IngestContext, ingestEnvelopes } from "../ingest.js";
import { IngestionPool } from "../ingestion-pool.js";
import { RetainedHistoryStore } from "../retained-store.js";
import type { GroupPeeler, IngestResult } from "../types.js";

type Envelope = { id: string };

describe("ingestEnvelopes – deferred (future-epoch commit)", () => {
  it("defers a commit more than one epoch ahead as missing_parent, not stale", async () => {
    const adminPubkey = "a".repeat(64);
    const impl: CiphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: [],
    });

    // Advance a working copy two epochs to capture a real, encodable commit
    // whose source epoch is 2 (one past the in-order epoch a receiver at 0
    // could apply).
    let state = clientState;
    let futureCommit: MlsMessage | undefined;
    for (let epoch = 0; epoch <= 2; epoch++) {
      const res = await createCommit({
        context: { cipherSuite: impl, authService: marmotAuthService },
        state,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
      state = res.newState;
      if (epoch === 2) futureCommit = res.commit;
    }
    if (!futureCommit) throw new Error("expected a source-epoch-2 commit");

    // Receiver is at epoch 0; the peeler hands the commit over already peeled so
    // the test exercises the epoch-gap logic, not the kind-445 crypto (a real
    // receiver at epoch 0 lacks the epoch-2 exporter and would never peel it).
    const envelope: Envelope = { id: "future01" };
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        if (envelopes.includes(envelope))
          return {
            read: [{ envelope, message: futureCommit! }],
            unreadable: [],
          };
        return { read: [], unreadable: [...envelopes] };
      },
      wrapGroupMessage() {
        throw new Error("not used");
      },
    };

    const ctx: IngestContext<Envelope> = {
      ciphersuite: impl,
      peeler,
      retained: new RetainedHistoryStore(clientState),
      log: debug("test:ingest-deferred"),
      getState: () => clientState,
      setState: () => {
        throw new Error("setState must not be called for a deferred commit");
      },
      createAdminCallback: () => () => "accept",
      resolveFork: () => {
        throw new Error("resolveFork must not be called for a deferred commit");
      },
      toUnrecoverable: () => {
        throw new Error("toUnrecoverable must not be called");
      },
      dedup: {
        classify: () => undefined,
        remember: () => {},
      },
    };

    const results: IngestResult<Envelope>[] = [];
    for await (const r of ingestEnvelopes(ctx, [envelope])) results.push(r);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("expected deferred");
    expect(result.reason).toBe("missing_parent");
    expect(result.envelope).toBe(envelope);
    // The protocol-visible disposition is retryable, not terminal stale.
    expect(ingestResultDisposition(result)).toEqual({
      kind: "deferred",
      reason: "missing_parent",
    });
  });

  it("expires authenticated deferred commits only beyond the rewind boundary", () => {
    const pool = new IngestionPool<Envelope>({
      maxSize: 4,
      maxRewindCommits: 5,
    });

    expect(pool.add("boundary", { id: "boundary" }, 5)).toEqual({
      kind: "accepted",
    });
    expect(pool.evictStale(10)).toEqual([]);
    expect(pool.has("boundary")).toBe(true);

    expect(pool.evictStale(11).map((entry) => entry.id)).toEqual(["boundary"]);
  });

  it("never expires authenticated deferred commits under an infinite horizon", () => {
    const pool = new IngestionPool<Envelope>({
      maxSize: 4,
      maxRewindCommits: Number.POSITIVE_INFINITY,
    });
    pool.add("future", { id: "future" }, 2);

    expect(pool.evictStale(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(pool.has("future")).toBe(true);
  });

  it("refuses capacity without consuming an entry and accepts redelivery later", () => {
    const pool = new IngestionPool<Envelope>({ maxSize: 1 });

    expect(pool.add("held", { id: "held" }, 1)).toEqual({ kind: "accepted" });
    expect(pool.add("refused", { id: "refused" }, 2)).toEqual({
      kind: "refused",
      reason: "capacity",
    });
    expect(pool.has("held")).toBe(true);
    expect(pool.has("refused")).toBe(false);

    pool.remove("held");
    expect(pool.add("refused", { id: "refused" }, 2)).toEqual({
      kind: "accepted",
    });
    expect(pool.has("refused")).toBe(true);
  });
});
