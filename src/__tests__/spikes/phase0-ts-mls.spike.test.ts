/**
 * Phase 0 — ts-mls de-risking spike (executable probes).
 *
 * These are not feature tests. They empirically establish what
 * `ts-mls@2.0.0-rc.10` can and cannot do for the darkmatter / Marmot v2
 * migration, so the Phase 0 decision record rests on observed behavior rather
 * than on reading type declarations. See `migration/phase-0-ts-mls-spike.md`.
 *
 * The two decision-critical questions (MIGRATION_PLAN.md "Phase 0"):
 *   Q1. Can the app-component model — `app_data_dictionary` (0x0006),
 *       `app_data_update` (0x0008), `app_components` (0x0001) — be carried via
 *       ts-mls today, or does it need an upstream contribution / fork?
 *   Q2. Can ts-mls apply a commit to a *retained prior* ClientState (branch
 *       replay), as Phase 9 convergence requires?
 *
 * Each probe documents its finding inline. If a future ts-mls bump changes a
 * capability (e.g. adds native AppData support), the corresponding probe should
 * fail — that failure is the signal to revisit the decision record.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type CiphersuiteImpl,
  type Capabilities,
  type GroupContextExtension,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  makeCustomExtension,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
import { createGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import type { MarmotGroupData } from "../../core/protocol.js";

// draft-ietf-mls-extensions-09 code points the v2 app-component model needs.
const APP_DATA_DICTIONARY_EXTENSION_TYPE = 0x0006;
const APP_DATA_UPDATE_PROPOSAL_TYPE = 0x0008;

const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

const ctx = (impl: CiphersuiteImpl) => ({
  cipherSuite: impl,
  authService: unsafeTestingAuthenticationService,
});

/**
 * v2-aware capabilities: advertise support for the app_data_dictionary
 * extension (0x0006) and app_data_update proposal (0x0008). FINDING (probe run
 * 1): ts-mls enforces MLS leaf-capability validation — a member added to a
 * group whose GroupContext carries extension 0x0006 MUST advertise 0x0006 in
 * its LeafNode capabilities, or the Add is rejected with "Added leaf node that
 * doesn't support extension in GroupContext". The v2 KeyPackage builder must
 * therefore advertise these code points.
 */
function v2Capabilities(): Capabilities {
  const caps = defaultCapabilities();
  return {
    ...caps,
    extensions: [...caps.extensions, APP_DATA_DICTIONARY_EXTENSION_TYPE],
    proposals: [...caps.proposals, APP_DATA_UPDATE_PROPOSAL_TYPE],
  };
}

function sampleGroupData(adminPubkey: string): MarmotGroupData {
  return {
    version: 2,
    nostrGroupId: new Uint8Array(32).fill(9),
    name: "Phase 0 Spike",
    description: "",
    adminPubkeys: [adminPubkey],
    relays: [],
    imageHash: new Uint8Array(0),
    imageKey: new Uint8Array(0),
    imageNonce: new Uint8Array(0),
    imageUploadKey: new Uint8Array(0),
  };
}

/** Builds a 2-member group: admin (creator) + one joined member. */
async function twoMemberGroup(
  impl: CiphersuiteImpl,
  extraExtensions: GroupContextExtension[] = [],
) {
  const adminPubkey = "a".repeat(64);
  const memberPubkey = "b".repeat(64);

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    capabilities: v2Capabilities(),
    ciphersuiteImpl: impl,
  });
  const { clientState: adminEpoch0 } = await createGroup({
    creatorKeyPackage: adminKp,
    marmotGroupData: sampleGroupData(adminPubkey),
    extensions: extraExtensions,
    ciphersuiteImpl: impl,
  });

  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
    capabilities: v2Capabilities(),
    ciphersuiteImpl: impl,
  });
  const addProposal = {
    proposalType: defaultProposalTypes.add,
    add: { keyPackage: memberKp.publicPackage },
  };
  const { newState: adminEpoch1, welcome } = await createCommit({
    context: ctx(impl),
    state: adminEpoch0,
    wireAsPublicMessage: false,
    extraProposals: [addProposal],
    ratchetTreeExtension: true,
  });

  const memberEpoch1 = await joinGroup({
    context: ctx(impl),
    welcome: (welcome as any).welcome ?? (welcome as any),
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  return { adminEpoch1, memberEpoch1, memberKp };
}

function findExt(extensions: GroupContextExtension[], type: number) {
  return extensions.find((e) => e.extensionType === type);
}

describe("Phase 0 spike: ts-mls v2 capability probes", () => {
  let impl: CiphersuiteImpl;
  beforeAll(async () => {
    impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
  });

  // PROBE 1 — Carrier feasibility.
  // Can an unknown custom GroupContext extension (0x0006 app_data_dictionary,
  // carried as opaque bytes) survive createGroup -> add-member commit -> join,
  // arriving byte-identical at the joining member?
  it("PROBE 1: preserves a custom app_data_dictionary (0x0006) extension across commit+join", async () => {
    const dictBytes = new Uint8Array([0x01, 0x02, 0x03, 0xaa, 0xbb]);
    const dictExt = makeCustomExtension({
      extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
      extensionData: dictBytes,
    });

    const { adminEpoch1, memberEpoch1 } = await twoMemberGroup(impl, [dictExt]);

    const adminDict = findExt(
      adminEpoch1.groupContext.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );
    const memberDict = findExt(
      memberEpoch1.groupContext.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );

    expect(adminDict, "admin keeps the dictionary extension").toBeTruthy();
    expect(
      memberDict,
      "joined member receives the dictionary extension",
    ).toBeTruthy();
    expect((memberDict as any).extensionData).toEqual(dictBytes);
    // Both members agree on epoch + confirmation tag => same GroupContext.
    expect(memberEpoch1.groupContext.epoch).toBe(
      adminEpoch1.groupContext.epoch,
    );
    expect(bytesToHex(memberEpoch1.confirmationTag)).toBe(
      bytesToHex(adminEpoch1.confirmationTag),
    );
  });

  // PROBE 2 — Native mutation path.
  // Mutate the dictionary via a native `group_context_extensions` proposal
  // (type 7, which ts-mls supports) and confirm both members converge on the
  // new bytes. This is the pragmatic alternative to app_data_update (0x0008).
  it("PROBE 2: mutates the dictionary via group_context_extensions (type 7) and both members converge", async () => {
    const initialDict = new Uint8Array([0x00]);
    const dictExt = makeCustomExtension({
      extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
      extensionData: initialDict,
    });
    const { adminEpoch1, memberEpoch1 } = await twoMemberGroup(impl, [dictExt]);

    // A GCE proposal REPLACES the whole extension set, so carry forward every
    // existing extension and swap in the updated dictionary bytes.
    const updatedDict = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const nextExtensions: GroupContextExtension[] =
      adminEpoch1.groupContext.extensions.map((e) =>
        e.extensionType === APP_DATA_DICTIONARY_EXTENSION_TYPE
          ? makeCustomExtension({
              extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
              extensionData: updatedDict,
            })
          : e,
      );

    const gceProposal = {
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: { extensions: nextExtensions },
    };

    const { newState: adminEpoch2, commit } = await createCommit({
      context: ctx(impl),
      state: adminEpoch1,
      wireAsPublicMessage: false,
      extraProposals: [gceProposal as any],
      ratchetTreeExtension: true,
    });

    const result = await processMessage({
      context: ctx(impl),
      state: memberEpoch1,
      message: commit as any,
    });
    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    const memberEpoch2 = result.newState;

    const adminDict = findExt(
      adminEpoch2.groupContext.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );
    const memberDict = findExt(
      memberEpoch2.groupContext.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );
    expect((adminDict as any)?.extensionData).toEqual(updatedDict);
    expect((memberDict as any)?.extensionData).toEqual(updatedDict);
    expect(bytesToHex(memberEpoch2.confirmationTag)).toBe(
      bytesToHex(adminEpoch2.confirmationTag),
    );
  });

  // PROBE 3 — Custom proposal (app_data_update 0x0008) behavior.
  // The spec's mutation primitive is the app_data_update proposal. ts-mls has
  // no native handler for it. This probe records what actually happens when a
  // ProposalCustom(0x0008) is injected: does createCommit accept it, does the
  // receiver process it, and crucially does it mutate the dictionary? We expect
  // NO dictionary mutation (ts-mls cannot know the draft semantics), proving the
  // gap that Phase 3 must fill.
  it("PROBE 3: records app_data_update (0x0008) custom-proposal behavior (expected: no native dictionary semantics)", async () => {
    const dictExt = makeCustomExtension({
      extensionType: APP_DATA_DICTIONARY_EXTENSION_TYPE,
      extensionData: new Uint8Array([0x00]),
    });
    const { adminEpoch1, memberEpoch1 } = await twoMemberGroup(impl, [dictExt]);

    const appDataUpdate = {
      proposalType: APP_DATA_UPDATE_PROPOSAL_TYPE,
      proposalData: new Uint8Array([0x01, 0x02, 0x03]),
    };

    let createError: unknown;
    let commit: unknown;
    let adminEpoch2: any;
    try {
      const res = await createCommit({
        context: ctx(impl),
        state: adminEpoch1,
        wireAsPublicMessage: false,
        extraProposals: [appDataUpdate as any],
        ratchetTreeExtension: true,
      });
      commit = res.commit;
      adminEpoch2 = res.newState;
    } catch (e) {
      createError = e;
    }

    // eslint-disable-next-line no-console
    console.log(
      "[PROBE 3] createCommit error:",
      createError instanceof Error ? createError.message : createError,
    );

    if (createError) {
      // Finding: ts-mls rejects unknown custom proposals at commit time.
      expect(createError).toBeInstanceOf(Error);
      return;
    }

    // createCommit accepted it — check whether the receiver accepts and whether
    // the dictionary changed (it must NOT, since ts-mls lacks draft semantics).
    let processError: unknown;
    let memberEpoch2: any;
    try {
      const result = await processMessage({
        context: ctx(impl),
        state: memberEpoch1,
        message: commit as any,
      });
      if (result.kind === "newState") memberEpoch2 = result.newState;
    } catch (e) {
      processError = e;
    }
    // eslint-disable-next-line no-console
    console.log(
      "[PROBE 3] processMessage error:",
      processError instanceof Error ? processError.message : processError,
    );

    const adminDict = findExt(
      adminEpoch2.groupContext.extensions,
      APP_DATA_DICTIONARY_EXTENSION_TYPE,
    );
    expect((adminDict as any)?.extensionData).toEqual(new Uint8Array([0x00]));
    if (memberEpoch2) {
      const memberDict = findExt(
        memberEpoch2.groupContext.extensions,
        APP_DATA_DICTIONARY_EXTENSION_TYPE,
      );
      expect((memberDict as any)?.extensionData).toEqual(
        new Uint8Array([0x00]),
      );
    }
  });

  // PROBE 4 — Branch replay (Phase 9 convergence).
  // Snapshot a prior ClientState, round-trip it through TLS serialization
  // (proving retained states are restorable), then apply a commit to the
  // *restored* state and confirm it reaches the same epoch + confirmation tag
  // as applying it to the live state. This is the core convergence primitive:
  // replaying a commit against an arbitrary retained snapshot.
  it("PROBE 4: applies a commit to a retained, serialized-then-restored prior ClientState (branch replay)", async () => {
    const { adminEpoch1, memberEpoch1 } = await twoMemberGroup(impl);

    // Member creates a self-update commit advancing epoch1 -> epoch2.
    const { commit } = await createCommit({
      context: ctx(impl),
      state: memberEpoch1,
      wireAsPublicMessage: false,
      extraProposals: [],
      ratchetTreeExtension: true,
    });

    // Path A: apply to the live admin state.
    const live = await processMessage({
      context: ctx(impl),
      state: adminEpoch1,
      message: commit as any,
    });
    expect(live.kind).toBe("newState");
    if (live.kind !== "newState") throw new Error("expected newState");

    // Path B: retain epoch1, serialize + restore it, then apply the SAME commit.
    const retained = deserializeClientState(serializeClientState(adminEpoch1));
    const replayed = await processMessage({
      context: ctx(impl),
      state: retained,
      message: commit as any,
    });
    expect(replayed.kind).toBe("newState");
    if (replayed.kind !== "newState") throw new Error("expected newState");

    // Both paths must converge bit-for-bit.
    expect(replayed.newState.groupContext.epoch).toBe(
      live.newState.groupContext.epoch,
    );
    expect(bytesToHex(replayed.newState.confirmationTag)).toBe(
      bytesToHex(live.newState.confirmationTag),
    );
  });
});
