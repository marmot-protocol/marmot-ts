import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { RetainedHistoryStore } from "../retained-store.js";

/**
 * Builds a 2-member group and advances the admin two epochs, recording each
 * transition into a fresh {@link RetainedHistoryStore} (states {0,1,2},
 * applied commits {0,1}).
 */
async function buildStoreWithHistory() {
  const adminPubkey = "a".repeat(64);
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
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: [] },
  );

  const memberKp = await generateKeyPackage({
    credential: createCredential("e".repeat(64)),
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const epoch1 = add.newState;

  const update = await createCommit({
    context: ctx,
    state: epoch1,
    extraProposals: [],
  });
  const epoch2 = update.newState;

  const store = new RetainedHistoryStore(epoch0);
  store.record(epoch0, add.commit, epoch1);
  store.record(epoch1, update.commit, epoch2);

  return { store, epoch0, epoch1, epoch2 };
}

describe("RetainedHistoryStore (in-memory convergence window)", () => {
  it("records states + applied commits and exposes the branch range", async () => {
    const { store, epoch0, epoch1, epoch2 } = await buildStoreWithHistory();

    expect(store.anchorEpoch()).toBe(0);
    expect(store.tipEpoch()).toBe(2);
    expect(store.size).toBe(3);

    for (const [epoch, original] of [
      [0, epoch0],
      [1, epoch1],
      [2, epoch2],
    ] as const) {
      const state = store.stateAt(epoch);
      expect(state, `state at epoch ${epoch}`).toBeDefined();
      expect(Number(state!.groupContext.epoch)).toBe(epoch);
      expect(state!.confirmationTag).toEqual(original.confirmationTag);
    }

    expect(store.hasState(1)).toBe(true);
    expect(store.hasState(99)).toBe(false);
    expect(store.appliedCommitsBetween(0, 2)).toHaveLength(2);
  });

  it("seeds tip-only with no applied commits", async () => {
    const { epoch0 } = await buildStoreWithHistory();
    const fresh = new RetainedHistoryStore(epoch0);
    expect(fresh.tipEpoch()).toBe(0);
    expect(fresh.size).toBe(1);
    expect(fresh.appliedCommitsBetween(0, 1)).toHaveLength(0);
  });
});
