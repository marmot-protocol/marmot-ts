/**
 * A pool-replay rewind whose every triggering candidate was refused at its
 * parent still has to surface what it applied (08-REVIEW round 2, WR-01).
 *
 * The winner can be carried by material other than the refused pool entries,
 * so there may be no envelope to hang a `processed` result on. The applied
 * chain's notifications must still reach the consumer, as the tree-fed rewind
 * path (`#reconvergeFromTree`) already delivers them: as envelope-free
 * `appliedNotifications` results.
 *
 * Round 4 WR-04: those results now also carry the two terminal facts the
 * envelope-carrying branches report (`selectedTerminal` on `processed`, and
 * the `removed` classification), which otherwise had nowhere to go on this
 * path — leaving a direct `./engine` consumer to see a rewind onto a disband
 * or onto its own removal as nothing but a notification stream.
 */
import debug from "debug";
import {
  type CiphersuiteImpl,
  type ClientState,
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
import type {
  DisbandCandidateEvidence,
  GroupPeeler,
  IngestResult,
} from "../types.js";

type Envelope = { id: string };

const TIP_DIGEST = new Uint8Array(32).fill(7);
const APPLIED: StateNotification[] = [
  { kind: "epochAdvanced", commitDigest: TIP_DIGEST, from: 1, to: 2 },
];

/**
 * Drives a rewind in which the single triggering envelope is refused at its
 * parent, so the recovered winner has no envelope to be reported on.
 *
 * `options` control only what the two WR-04 fields are derived from: the
 * canonical state the rewind landed on, and whether selection chose
 * authenticated terminal evidence.
 */
async function runRefusedPoolRewind(options?: {
  removedFromGroup?: boolean;
  selectedTerminal?: DisbandCandidateEvidence;
}): Promise<{ results: IngestResult<Envelope>[]; envelope: Envelope }> {
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
  // A competing epoch-1 commit: past-epoch for a receiver at epoch 2, so it
  // is routed to fork recovery, where it is refused.
  const competing = await createCommit({
    context,
    state: snapshot(epoch1),
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });

  // The state the rewind ADOPTS. Ingest must start from the active epoch-2
  // state: `ingest.ts`'s D-13 guard yields every envelope as `self-evicted`
  // when canonical state is already the tombstone on entry, so the tombstone
  // is only ever reached here by the rewind itself.
  const landedState: ClientState = options?.removedFromGroup
    ? { ...toEpoch2.newState, groupActiveState: { kind: "removedFromGroup" } }
    : toEpoch2.newState;
  let current: ClientState = toEpoch2.newState;

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
    getState: () => current,
    setState: (state) => {
      current = state;
    },
    recordCommit: () => {},
    admitDisbandCandidate: () => {},
    recordProposalStaged: () => {},
    createAdminCallback: () => () => "accept",
    resolveFork: async (_forkEpoch, pool) => {
      // Production's `#resolveFork` adopts the winning tip via `#setState`
      // before returning; mirror that so a rewind onto the tombstone becomes
      // observable to the code under test exactly as it would be live.
      current = landedState;
      return {
        outcome: "recovered",
        result: {
          kind: "newState",
          newState: landedState,
          actionTaken: "accept",
          consumed: [],
          aad: new Uint8Array(),
        },
        tipCommitMessage: undefined,
        notifications: APPLIED,
        invalidated: [],
        withdrawnNotifications: [],
        selectedTerminal: options?.selectedTerminal,
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
      };
    },
    recordDeliveredAppPayload: () => {},
    recordStateNotifications: () => {},
    toUnrecoverable: () => {
      throw new Error("toUnrecoverable must not be called");
    },
    dedup: { classify: () => undefined, remember: () => {} },
  };

  const results: IngestResult<Envelope>[] = [];
  for await (const r of ingestEnvelopes(ctx, [envelope])) results.push(r);
  return { results, envelope };
}

describe("ingestEnvelopes – rewind with every pool candidate refused (WR-01)", () => {
  it("still yields the applied chain's notifications when no envelope survives", async () => {
    const { results, envelope } = await runRefusedPoolRewind();

    expect(results).toContainEqual(
      expect.objectContaining({ kind: "rejected", envelope }),
    );
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(results).toContainEqual({
      kind: "appliedNotifications",
      commitDigest: TIP_DIGEST,
      notifications: APPLIED,
      // WR-04: present even when neither terminal fact applies, so a consumer
      // can read them unconditionally.
      selectedTerminal: undefined,
      removedFromGroup: false,
    });
  });

  it("WR-04: carries the selected terminal evidence on the envelope-free result", async () => {
    const selectedTerminal: DisbandCandidateEvidence = {
      actorPubkey: testAccount(6).pubkey,
      commitDigest: new Uint8Array(32).fill(9),
      parentTag: "parent",
      sourceEpoch: 1,
      terminalOutcome: "disbanded",
    };

    const { results } = await runRefusedPoolRewind({ selectedTerminal });

    // Before WR-04 a rewind onto a disband was indistinguishable, on this
    // path, from an ordinary notification delivery.
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "appliedNotifications",
        selectedTerminal,
      }),
    );
  });

  it("WR-04: reports a rewind that landed on the removedFromGroup tombstone", async () => {
    const { results } = await runRefusedPoolRewind({ removedFromGroup: true });

    // The envelope-carrying sibling branch reports this as `kind: "removed"`,
    // which has no envelope-free counterpart.
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "appliedNotifications",
        removedFromGroup: true,
      }),
    );
  });
});
