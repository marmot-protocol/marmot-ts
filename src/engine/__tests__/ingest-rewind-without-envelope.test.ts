/**
 * A pool-replay rewind whose every triggering candidate was refused at its
 * parent still has to surface what it applied (08-REVIEW round 2, WR-01).
 *
 * The winner can be carried by material other than the refused pool entries,
 * so there may be no envelope to hang a `processed` result on. The applied
 * chain's notifications must still reach the consumer, as the tree-fed rewind
 * path (`#reconvergeFromTree`) already delivers them: as envelope-free
 * `appliedNotifications` results.
 */
import debug from "debug";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { snapshot } from "../../__tests__/helpers/engine-seam-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { marmotAuthService } from "../../core/auth-service.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { type IngestContext, ingestEnvelopes } from "../ingest.js";
import type { RetainedHistoryStore } from "../retained-store.js";
import type { StateNotification } from "../state-notifications.js";
import type { GroupPeeler, IngestResult } from "../types.js";

type Envelope = { id: string };

describe("ingestEnvelopes – rewind with every pool candidate refused (WR-01)", () => {
  it("still yields the applied chain's notifications when no envelope survives", async () => {
    const account = testAccount(6);
    const impl: CiphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: epoch0 } = await createSimpleGroup(
      kp,
      impl,
      "Rewind Group",
      { adminPubkeys: [account.pubkey], relays: [] },
    );
    const context = { cipherSuite: impl, authService: marmotAuthService };
    const toEpoch1 = await createCommit({
      context,
      state: epoch0,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const epoch1 = toEpoch1.newState;
    const toEpoch2 = await createCommit({
      context,
      state: snapshot(epoch1),
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const epoch2 = toEpoch2.newState;
    // A competing epoch-1 commit: past-epoch for a receiver at epoch 2, so it
    // is routed to fork recovery, where it is refused.
    const competing = await createCommit({
      context,
      state: snapshot(epoch1),
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const envelope: Envelope = { id: "refused1" };
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.includes(envelope)
            ? [{ envelope, message: competing.commit }]
            : [],
          unreadable: envelopes.filter((e) => e !== envelope),
        };
      },
      wrapGroupMessage() {
        throw new Error("not used");
      },
      idOf(e) {
        return e.id;
      },
    };

    const tipDigest = new Uint8Array(32).fill(7);
    const applied: StateNotification[] = [
      { kind: "epochAdvanced", commitDigest: tipDigest, from: 1, to: 2 },
    ];
    const retained = {
      size: 1,
      states: () => [epoch1],
      hasState: (epoch: number) => epoch === 1,
      anchorEpoch: () => 1,
    } as unknown as RetainedHistoryStore;

    const ctx: IngestContext<Envelope> = {
      ciphersuite: impl,
      peeler,
      retained,
      maxRewindCommits: 16,
      log: debug("test:ingest-rewind-without-envelope"),
      getState: () => epoch2,
      setState: () => {},
      recordCommit: () => {},
      admitDisbandCandidate: () => {},
      recordProposalStaged: () => {},
      createAdminCallback: () => () => "accept",
      resolveFork: async (_forkEpoch, pool) => ({
        outcome: "recovered",
        result: {
          kind: "newState",
          newState: epoch2,
          actionTaken: "accept",
          consumed: [],
          aad: new Uint8Array(),
        },
        tipCommitMessage: undefined,
        notifications: applied,
        invalidated: [],
        withdrawnNotifications: [],
        // Every triggering pool entry was refused at its parent.
        rejected: pool.map((message) => ({
          message,
          result: {
            kind: "newState",
            newState: epoch1,
            actionTaken: "reject",
            consumed: [],
            aad: new Uint8Array(),
          },
        })),
      }),
      recordDeliveredAppPayload: () => {},
      recordStateNotifications: () => {},
      toUnrecoverable: () => {
        throw new Error("toUnrecoverable must not be called");
      },
      dedup: { classify: () => undefined, remember: () => {} },
    };

    const results: IngestResult<Envelope>[] = [];
    for await (const r of ingestEnvelopes(ctx, [envelope])) results.push(r);

    expect(results).toContainEqual(
      expect.objectContaining({ kind: "rejected", envelope }),
    );
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(results).toContainEqual({
      kind: "appliedNotifications",
      commitDigest: tipDigest,
      notifications: applied,
    });
  });
});
