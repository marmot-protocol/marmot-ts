/**
 * Send-seam tests for the third and final WIRE-03/CONV-01 commit-legality
 * seam: `MarmotGroupEngine#send`'s `case "commit":` staging path
 * (`src/engine/group-engine.ts`).
 *
 * Covers:
 *  - D-05/D-06/D-07/D-08: auto-coupling an admin-policy update into a
 *    removal commit that de-leafs an admin account, account-level admin
 *    survival, and the `AdminDepletionError` guard.
 *  - D-01/D-02: the `validateCommitLegality` gate on the staged commit,
 *    thrown as `UsageError` before the lifecycle transitions to
 *    `PendingPublish` and before the commit is wrapped.
 *  - D-04/D-09: `#treeResolution`'s winner-chain validation on a tree-fed
 *    re-convergence switch.
 *
 * Together with `commit-legality-seams.test.ts` (inbound + replay seams,
 * plan 03-04), this proves all three routes by which a commit becomes
 * canonical state — send, inbound, and convergence/replay — call the same
 * shared adapter (`src/core/components/integrity.ts` `validateCommitLegality`).
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  acceptAll,
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  type IncomingMessageCallback,
  joinGroup,
  type LeafIndex,
  type MlsMessage,
  mlsMessageEncoder,
  processMessage,
  UsageError,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { getAdminPolicy } from "../../core/components/dictionary.js";
import { encodeAdminPolicyV1 } from "../../core/components/admin-policy.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import type { EdgeSnapshot } from "../history-tree.js";
import { ForkRecovery, type RetainedView } from "../fork-recovery.js";
import { AdminDepletionError, MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

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

/**
 * A group at epoch 1 with two admins (`adminPubkey`, `admin2Pubkey`) and one
 * non-admin member (`memberPubkey`), each with a single leaf. `adminPubkey` is
 * the identity behind the engine under test (this device's own leaf), so
 * every `engine.send({ kind: "commit", actorPubkey: adminPubkey, ... })` call
 * below is a genuine local commit-staging call.
 */
async function twoAdminGroup() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
  const memberPubkey = "d".repeat(64);
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
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2Kp = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
    ciphersuiteImpl: impl,
  });

  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2Kp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  return {
    impl,
    ctx,
    adminPubkey,
    admin2Pubkey,
    memberPubkey,
    epoch1: add.newState,
    memberEpoch1,
  };
}

async function stageAdminPolicyProposal(
  engine: MarmotGroupEngine<NostrEvent>,
  admins: string[],
): Promise<string> {
  const staged = await engine.send({
    kind: "proposal",
    proposal: {
      proposalType: appDataUpdateProposalType,
      appDataUpdate: {
        componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
        operation: "update",
        update: encodeAdminPolicyV1(admins),
      },
    },
  });
  engine.confirmPublished(staged.pending);
  const [ref] = Object.keys(engine.state.unappliedProposals);
  if (ref === undefined) throw new Error("expected staged proposal reference");
  return ref;
}

/**
 * A group at epoch 1 with two admins where `admin2Pubkey` occupies TWO
 * separate leaves (two devices under the same account credential) — the
 * fixture D-08's account-level (not leaf-level) survival rule needs.
 */
async function twoLeafAdminGroup() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
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
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2KpA = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const admin2KpB = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });

  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2KpA.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2KpB.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  return { impl, ctx, adminPubkey, admin2Pubkey, epoch1: add.newState };
}

/**
 * A two-admin group at epoch 1 — the root for `#treeResolution`'s
 * winner-chain validation tests. `adminEpoch1` is admin1's state (the engine
 * under test); `admin2Epoch1` is admin2's own independent state, joined via
 * `joinGroup`, used to author the competing sibling chain below. The sibling
 * chain MUST be authored by a genuinely different leaf than the engine's own
 * — replaying a commit through `processMessage` from the SAME leaf that
 * committed it throws (`ValidationError: Could not find common ancestor`),
 * because an `UpdatePath` never encrypts a path secret to the committer's own
 * leaf (RFC 9420) — the same constraint CONV-04 (03-03) works around for
 * `ForkRecovery`'s own-commit replay. Using admin2 as the sibling's author
 * sidesteps it entirely, since `#treeResolution`'s validation replays each
 * winner-chain link from admin1's (the engine's) point of view.
 */
async function twoAdminGroupWithJoin() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
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
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2Kp = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin2Kp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const adminEpoch1 = add.newState;
  const admin2Epoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: admin2Kp.publicPackage,
    privateKeys: admin2Kp.privatePackage,
    ratchetTree: undefined,
  });

  return { impl, ctx, adminPubkey, admin2Pubkey, adminEpoch1, admin2Epoch1 };
}

/**
 * Builds the {@link EdgeSnapshot} `GroupHistoryTree.recordEdge` needs, so a
 * test can inject a branch edge directly into the tree — simulating a
 * persisted edge written by an earlier build, without going through the
 * engine's normal ingest/replay gates (which would refuse a violating commit
 * before it ever became an edge).
 *
 * `childState` MUST be a state reached by replaying `commitMessage` from a
 * perspective OTHER than the commit's own committer (see
 * `buildAdmin1PerspectiveChain`'s doc comment) — never the committer's own
 * `createCommit` result. A commit's `UpdatePath` never encrypts a path secret
 * to its own committer's leaf (RFC 9420), so storing the committer's own
 * resulting state as a chain link's snapshot makes that link unreplayable
 * later (`InternalError: No overlap between provided private keys and update
 * path`) — exactly the CONV-04 (03-03) own-commit-replay constraint, here hit
 * by construction rather than by the real engine.
 */
function edgeFromReplay(
  parentTag: string,
  commitMessage: MlsMessage,
  childState: ClientState,
): EdgeSnapshot {
  const commitBytes = encode(mlsMessageEncoder, commitMessage);
  return {
    parentTag,
    childTag: bytesToHex(childState.confirmationTag),
    childEpoch: Number(childState.groupContext.epoch),
    commitBytes,
    commitDigest: commitDigest(commitBytes),
    childSnapshot: serializeClientState(childState),
  };
}

/**
 * Replays a chain of commits (authored by some OTHER party, e.g. admin2) from
 * `rootState` — a state belonging to admin1 (the engine under test) — via
 * `processMessage`, returning the resulting admin1-perspective `ClientState`
 * after each commit, in order. This is what makes the resulting snapshots
 * safe to record as chain-link children and later re-replay: they are
 * admin1's own view, never the original committer's, so admin1's own leaf is
 * never the committer's leaf on any subsequent replay (see
 * `edgeFromReplay`'s doc comment). Mirrors exactly what the real
 * `ForkRecovery#buildBranches`/`explore()` replay path does when building a
 * genuine candidate branch (`src/engine/fork-recovery.ts`).
 */
async function buildAdmin1PerspectiveChain(
  ctx: {
    cipherSuite: CiphersuiteImpl;
    authService: typeof unsafeTestingAuthenticationService;
  },
  rootState: ClientState,
  commitMessages: MlsMessage[],
): Promise<ClientState[]> {
  const states: ClientState[] = [];
  let current = rootState;
  for (const message of commitMessages) {
    const result = await processMessage({
      context: {
        cipherSuite: ctx.cipherSuite,
        authService: ctx.authService,
        externalPsks: {},
      },
      state: current,
      message,
    });
    if (result.kind !== "newState")
      throw new Error("expected newState while building the test fixture");
    states.push(result.newState);
    current = result.newState;
  }
  return states;
}

describe("send-seam commit legality (WIRE-03/CONV-01) — D-01/D-02/D-05..D-09", () => {
  it("removing a non-admin member produces no spliced admin-policy update", async () => {
    const { impl, adminPubkey, memberPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const [memberLeaf] = getPubkeyLeafNodeIndexes(engine.state, memberPubkey);
    expect(memberLeaf).toBeDefined();
    const beforeAdminPolicy = getAdminPolicy(
      engine.state.groupContext.extensions,
    );

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: memberLeaf as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const afterAdminPolicy = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(afterAdminPolicy).toEqual(beforeAdminPolicy);
  });

  it("removing an admin member splices the admin-policy update into the same commit (D-05)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const [admin2Leaf] = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(admin2Leaf).toBeDefined();

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: admin2Leaf as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const resultingAdmins = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(resultingAdmins).toEqual([adminPubkey]);
    expect(Number(result.pending.newState.groupContext.epoch)).toBe(
      beforeEpoch + 1,
    );
  });

  it("rejects a removal that would empty the admin set with AdminDepletionError before staging (D-07)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const [adminLeaf] = getPubkeyLeafNodeIndexes(engine.state, adminPubkey);
    const [admin2Leaf] = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(adminLeaf).toBeDefined();
    expect(admin2Leaf).toBeDefined();

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.remove,
            remove: { removed: adminLeaf as LeafIndex },
          },
          {
            proposalType: defaultProposalTypes.remove,
            remove: { removed: admin2Leaf as LeafIndex },
          },
        ],
      }),
    ).rejects.toThrow(AdminDepletionError);

    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("does not drop an admin's key when only one of its two leaves is removed (D-08)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } =
      await twoLeafAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const admin2Leaves = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(admin2Leaves.length).toBe(2);
    const beforeAdminPolicy = getAdminPolicy(
      engine.state.groupContext.extensions,
    );

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: admin2Leaves[0] as LeafIndex },
        },
      ],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");

    const afterAdminPolicy = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(afterAdminPolicy).toEqual(beforeAdminPolicy);
    expect(afterAdminPolicy).toContain(admin2Pubkey);
  });

  it("throws UsageError before staging when the resulting extensions would drop a required component (D-01/D-02)", async () => {
    const { impl, adminPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeTag = bytesToHex(engine.state.confirmationTag);

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
              operation: "remove",
            },
          },
        ],
      }),
    ).rejects.toThrow(UsageError);

    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("a benign commit still returns a groupEvolution SendResult with the unchanged field set", async () => {
    const { impl, adminPubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });

    expect(result.kind).toBe("groupEvolution");
    if (result.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    expect(Object.keys(result).sort()).toEqual(
      ["envelope", "kind", "pending", "welcome"].sort(),
    );
    expect(result.pending.kind).toBe("commit");
    expect(result.pending.newState).toBeDefined();
    expect(result.pending.parentState).toBeDefined();
    expect(result.pending.commitMessage).toBeDefined();
  });
});

/**
 * CR-03 regression: `send({ kind: "selfUpdate" })` produces a real commit, and
 * `createCommit` bundles every entry of `state.unappliedProposals` BY REFERENCE
 * in addition to `extraProposals` — so `extraProposals: []` does not make it a
 * proposal-free commit. Before this fix the selfUpdate branch ran none of the
 * D-05 auto-coupling splice, the D-07 depletion guard, or the D-01/D-02
 * `validateCommitLegality` gate that `case "commit"` runs, so the engine would
 * wrap and publish a commit its own inbound seam rejects.
 *
 * `send({kind:"proposal"})` + `confirmPublished` is the shortest route to a
 * genuinely staged unapplied proposal: `createProposal` stages the sender's own
 * proposal into the returned state, which `confirmPublished` then adopts.
 */
describe("selfUpdate seam commit legality (CR-03) — D-01/D-02/D-05/D-07", () => {
  it("rejects a non-admin selfUpdate consuming its staged admin-only proposal by reference", async () => {
    const { impl, memberEpoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: memberEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const staged = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "update",
          update: new Uint8Array([0, 1]),
        },
      },
    });
    engine.confirmPublished(staged.pending);

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const beforeProposalRefs = Object.keys(engine.state.unappliedProposals);
    expect(beforeProposalRefs).toHaveLength(1);

    await expect(engine.send({ kind: "selfUpdate" })).rejects.toThrow(
      "Not a group admin",
    );

    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
    expect(Object.keys(engine.state.unappliedProposals)).toEqual(
      beforeProposalRefs,
    );
  });

  it("allows an admin selfUpdate consuming the same admin-only proposal origin", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } =
      await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const staged = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "update",
          update: encodeAdminPolicyV1([adminPubkey, admin2Pubkey]),
        },
      },
    });
    engine.confirmPublished(staged.pending);

    const result = await engine.send({ kind: "selfUpdate" });
    expect(result.kind).toBe("selfUpdate");
    expect(engine.lifecycle).toBe("PendingPublish");
  });

  it("throws UsageError instead of emitting a commit whose by-reference proposals drop a required component (D-01/D-02)", async () => {
    const { impl, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const staged = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "remove",
        },
      },
    });
    engine.confirmPublished(staged.pending);
    expect(Object.keys(engine.state.unappliedProposals).length).toBe(1);

    const beforeTag = bytesToHex(engine.state.confirmationTag);

    await expect(engine.send({ kind: "selfUpdate" })).rejects.toThrow(
      UsageError,
    );

    // Nothing staged, nothing published, canonical state untouched.
    expect(engine.lifecycle).toBe("Stable");
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("splices the admin-policy update into a selfUpdate that bundles a Remove de-leafing an admin (D-05)", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const [admin2Leaf] = getPubkeyLeafNodeIndexes(engine.state, admin2Pubkey);
    expect(admin2Leaf).toBeDefined();

    const staged = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: admin2Leaf as LeafIndex },
      },
    });
    engine.confirmPublished(staged.pending);
    expect(Object.keys(engine.state.unappliedProposals).length).toBe(1);

    const result = await engine.send({ kind: "selfUpdate" });
    expect(result.kind).toBe("selfUpdate");

    // Without the splice this commit would carry an admin key with no member
    // leaf in the resulting epoch — the admin-leaf-coupling violation every
    // conformant peer rejects.
    const resultingAdmins = getAdminPolicy(
      result.pending.newState.groupContext.extensions,
    );
    expect(resultingAdmins).toEqual([adminPubkey]);
  });

  it("a selfUpdate with no staged proposals is unaffected (MIP-02 post-Welcome path)", async () => {
    const { impl, epoch1 } = await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const result = await engine.send({ kind: "selfUpdate" });

    expect(result.kind).toBe("selfUpdate");
    expect(result.pending.kind).toBe("selfUpdate");
    expect(Number(result.pending.newState.groupContext.epoch)).toBe(
      beforeEpoch + 1,
    );
    expect(
      getAdminPolicy(result.pending.newState.groupContext.extensions),
    ).toEqual(getAdminPolicy(engine.state.groupContext.extensions));
  });
});

describe("outbound exact-union actor authorization matrix", () => {
  it.each([
    { intentKind: "commit", origin: "by-value" },
    { intentKind: "commit", origin: "selected-reference" },
    { intentKind: "commit", origin: "implicit-reference" },
    { intentKind: "selfUpdate", origin: "implicit-reference" },
  ] as const)(
    "rejects a non-admin $intentKind with an admin-only $origin proposal",
    async ({ intentKind, origin }) => {
      const {
        impl,
        adminPubkey,
        admin2Pubkey,
        memberPubkey,
        memberEpoch1,
      } = await twoAdminGroup();
      const engine = new MarmotGroupEngine({
        state: memberEpoch1,
        ciphersuite: impl,
        peeler: testPeeler(impl),
      });
      const proposal = {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "update" as const,
          update: encodeAdminPolicyV1([adminPubkey, admin2Pubkey]),
        },
      };

      let ref: string | undefined;
      if (origin !== "by-value") {
        ref = await stageAdminPolicyProposal(engine, [
          adminPubkey,
          admin2Pubkey,
        ]);
      }
      const beforeTag = bytesToHex(engine.state.confirmationTag);
      const beforeRefs = Object.keys(engine.state.unappliedProposals);

      const send =
        intentKind === "selfUpdate"
          ? engine.send({ kind: "selfUpdate" })
          : engine.send({
              kind: "commit",
              actorPubkey: memberPubkey,
              extraProposals: origin === "by-value" ? [proposal] : undefined,
              proposalRefs:
                origin === "selected-reference" && ref !== undefined
                  ? [ref]
                  : undefined,
            });

      await expect(send).rejects.toThrow("Not a group admin");
      expect(engine.lifecycle).toBe("Stable");
      expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
      expect(Object.keys(engine.state.unappliedProposals)).toEqual(beforeRefs);
    },
  );

  it("does not duplicate a selected reference when the admin commits it", async () => {
    const { impl, adminPubkey, admin2Pubkey, epoch1 } =
      await twoAdminGroup();
    const engine = new MarmotGroupEngine({
      state: epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const ref = await stageAdminPolicyProposal(engine, [
      adminPubkey,
      admin2Pubkey,
    ]);

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      proposalRefs: [ref],
    });

    expect(result.kind).toBe("groupEvolution");
    expect(Number(result.pending.newState.groupContext.epoch)).toBe(
      Number(engine.state.groupContext.epoch) + 1,
    );
  });
});

/**
 * CR-04 regression: the fourth route by which a commit re-enters candidate
 * selection is `ForkRecovery`'s CONV-04 short-circuit, which reuses the
 * already-recorded resulting state for commits on our own canonical path
 * instead of replaying them. That path used to assign the recorded state
 * directly and jump PAST `validateCommitLegality` — while its sibling
 * `#treeResolution` documents and implements a strict fail-closed policy for
 * the very same input class (`RetainedHistoryStore` is rebuilt on load
 * straight from the persisted history tree, so `ours` can contain edges
 * written by a pre-upgrade build that never enforced this gate).
 *
 * Two seams, opposite policies, one input class — exactly the divergence
 * criterion 1 forbids. The commit's proposals are now read off the wire
 * (`framedCommitProposals`) so the shared adapter can run without a replay.
 */
describe("CONV-04 short-circuit re-validates persisted own-path commits (CR-04)", () => {
  it("does not grandfather a violating commit recorded on our own retained canonical path", async () => {
    const { impl, ctx, adminEpoch1, admin2Epoch1 } =
      await twoAdminGroupWithJoin();
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    // A commit that drops a required app component — the WIRE-03 Rule 2
    // violation every other seam refuses. Authored by admin2 (an admin, so
    // the MIP-03 gate accepts it) and wired as a PublicMessage, exactly as
    // Marmot v2 wires handshake content.
    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
            operation: "remove",
          },
        },
      ],
    });

    // A benign sibling at the same fork epoch, so a fork actually exists and
    // `resolveFork` has something to rebuild candidates against.
    const rival = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    // Admin1's own perspective of the violating commit, standing in for the
    // state a pre-upgrade build would have recorded into retained history
    // after accepting it.
    const [violatingState] = await buildAdmin1PerspectiveChain(
      ctx,
      deserializeClientState(serializeClientState(adminEpoch1)),
      [violating.commit],
    );

    const statesByEpoch = new Map<number, ClientState>([
      [1, adminEpoch1],
      [2, violatingState],
    ]);
    const retained: RetainedView = {
      stateAt: (epoch) => statesByEpoch.get(epoch),
      appliedCommitsBetween: () => [violating.commit],
    };

    const recovery = new ForkRecovery(impl, testPeeler(impl));
    const resolution = await recovery.resolveFork({
      forkEpoch: 1,
      pool: [rival.commit],
      currentState: violatingState,
      retained,
      adminCallback: acceptAll,
    });

    expect(resolution.outcome).not.toBe("skip");
    const edges = resolution.outcome === "skip" ? [] : resolution.edges;
    const digestHexOf = (message: MlsMessage) =>
      bytesToHex(commitDigest(encode(mlsMessageEncoder, message)));

    // The violating commit creates no candidate edge, even though it sits on
    // our own already-applied path and the short-circuit had its recorded
    // resulting state in hand.
    expect(
      edges.filter(
        (e) => bytesToHex(e.commitDigest) === digestHexOf(violating.commit),
      ),
    ).toEqual([]);

    // The legal sibling is still rebuilt normally — the gate drops the
    // violating edge only, it does not abandon fork recovery.
    expect(
      edges.some(
        (e) =>
          e.parentTag === rootTag &&
          bytesToHex(e.commitDigest) === digestHexOf(rival.commit),
      ),
    ).toBe(true);
  });

  /**
   * CR-11 regression (the unresolved remainder of CR-04): the short-circuit
   * ran `validateCommitLegality` but still hardcoded `actionTaken: "accept"`,
   * so the MIP-03 admin gate — `createAdminCommitPolicyCallback`, which
   * enforces admin-only commits, the account-identity-proof check on `Add`
   * proposals, and the admin-cannot-self-remove rule — was never consulted.
   *
   * `#treeResolution` does the opposite for the SAME persisted-edge input
   * class: it replays each winner-chain link under
   * `withCapturedProposals(this.#createAdminVerificationCallback())` and
   * abandons the chain on `actionTaken === "reject"`. So a persisted edge
   * written by a build whose admin set differed (or a pre-MIP-03 build) was
   * replayed into a WINNING candidate by ForkRecovery and refused by
   * `#treeResolution` — whichever seam ran first decided whether the group
   * converged, non-deterministically across peers.
   *
   * The commit under test is authored by admin1 — the engine's OWN leaf — so
   * the known-state short-circuit is the ONLY route by which it can produce an
   * edge: replaying it through `processMessage` throws, because an
   * `UpdatePath` never encrypts a path secret to the committer's own leaf
   * (RFC 9420). An edge for it therefore proves the short-circuit fired and
   * accepted without asking the admin callback.
   */
  it("runs the MIP-03 admin callback on the known-state short-circuit, not just commit legality", async () => {
    const { impl, ctx, adminEpoch1, admin2Epoch1 } =
      await twoAdminGroupWithJoin();
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    // Our OWN commit, on our own already-applied canonical path. Perfectly
    // legal per `validateCommitLegality` — the only thing that can refuse it
    // is the admin policy callback.
    const ours = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    // A competing sibling at the same fork epoch, authored by admin2, so a
    // fork genuinely exists and recovery has something else to build.
    const rival = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const statesByEpoch = new Map<number, ClientState>([
      [1, adminEpoch1],
      [2, ours.newState],
    ]);
    const retained: RetainedView = {
      stateAt: (epoch) => statesByEpoch.get(epoch),
      appliedCommitsBetween: () => [ours.commit],
    };

    // Stands in for an admin policy under which OUR leaf (leaf 0) is no longer
    // an admin — the pre-upgrade / diverged-admin-set edge class. Asserting on
    // the sender index also proves the synthesized `incoming` carries the
    // committer leaf the wire actually names.
    const seen: (number | undefined)[] = [];
    const rejectOurLeaf: IncomingMessageCallback = (incoming) => {
      if (incoming.kind !== "commit") return "accept";
      seen.push(
        incoming.senderLeafIndex === undefined
          ? undefined
          : Number(incoming.senderLeafIndex),
      );
      return Number(incoming.senderLeafIndex) === 0 ? "reject" : "accept";
    };

    const recovery = new ForkRecovery(impl, testPeeler(impl));
    const resolution = await recovery.resolveFork({
      forkEpoch: 1,
      pool: [rival.commit],
      currentState: ours.newState,
      retained,
      adminCallback: rejectOurLeaf,
    });

    const edges = resolution.outcome === "skip" ? [] : resolution.edges;
    const digestHexOf = (message: MlsMessage) =>
      bytesToHex(commitDigest(encode(mlsMessageEncoder, message)));

    // The callback was actually consulted for our own commit, with leaf 0 —
    // the committer named on the wire.
    expect(seen).toContain(0);

    // ...and its refusal dropped the candidate: no edge for our own commit,
    // even though the short-circuit had its recorded resulting state in hand.
    expect(
      edges.filter(
        (e) => bytesToHex(e.commitDigest) === digestHexOf(ours.commit),
      ),
    ).toEqual([]);

    // The admin-accepted sibling is still rebuilt normally — the gate drops
    // the refused edge only, it does not abandon fork recovery.
    expect(
      edges.some(
        (e) =>
          e.parentTag === rootTag &&
          bytesToHex(e.commitDigest) === digestHexOf(rival.commit),
      ),
    ).toBe(true);
  });
});

describe("#treeResolution winner-chain validation on tree-fed re-convergence (D-04/D-09)", () => {
  it("switches to a legal winner chain fed entirely from the persisted history tree", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, admin2Epoch1 } =
      await twoAdminGroupWithJoin();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    // The engine's own tip: one benign commit deep (root -> ownTip).
    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    // A competing sibling branch authored by admin2 (a genuinely different
    // leaf than the engine's own — see twoAdminGroupWithJoin's doc comment) —
    // two benign commits deep (root -> sib1 -> sib2), so it strictly
    // outscores the engine's own one-commit-deep tip on validCommitDepth
    // regardless of tip-digest tie-breaking. Recorded straight into the tree
    // via recordEdge, simulating a persisted edge, using admin1-perspective
    // replay snapshots (see buildAdmin1PerspectiveChain/edgeFromReplay).
    const sib1Commit = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sib2Commit = await createCommit({
      context: ctx,
      state: sib1Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const adminRootCopy = deserializeClientState(
      serializeClientState(adminEpoch1),
    );
    const [sib1State, sib2State] = await buildAdmin1PerspectiveChain(
      ctx,
      adminRootCopy,
      [sib1Commit.commit, sib2Commit.commit],
    );
    const sib1Tag = bytesToHex(sib1State.confirmationTag);
    engine.history.recordEdge(
      edgeFromReplay(rootTag, sib1Commit.commit, sib1State),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib1Tag, sib2Commit.commit, sib2State),
    );
    expect(engine.history.tips().sort()).toEqual(
      [
        bytesToHex(engine.state.confirmationTag),
        bytesToHex(sib2State.confirmationTag),
      ].sort(),
    );

    await engine.reconvergeFromHistory();

    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(sib2State.confirmationTag),
    );
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("abandons a tree-fed switch when a winner-chain link fails commit legality", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, admin2Epoch1 } =
      await twoAdminGroupWithJoin();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    // A competing sibling branch (root -> sib1 -> sib2), also authored by
    // admin2: sib2 drops a required app component via an AppDataUpdate
    // "remove" — exactly the WIRE-03 violation
    // `validateAppComponentIntegrity`'s Rule 2 exists to catch. admin2 is an
    // admin, so the MIP-03 admin gate accepts this commit on replay; only the
    // WIRE-03/CONV-01 legality gate below it is meant to catch the violation.
    // Recorded directly into the tree via recordEdge (admin1-perspective
    // replay snapshots), simulating a persisted edge written by a
    // pre-upgrade build — bypassing the normal replay gate that would have
    // refused it as a candidate edge in the first place.
    const sib1Commit = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sib2Commit = await createCommit({
      context: ctx,
      state: sib1Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
            operation: "remove",
          },
        },
      ],
    });

    const adminRootCopy = deserializeClientState(
      serializeClientState(adminEpoch1),
    );
    const [sib1State, sib2State] = await buildAdmin1PerspectiveChain(
      ctx,
      adminRootCopy,
      [sib1Commit.commit, sib2Commit.commit],
    );
    const sib1Tag = bytesToHex(sib1State.confirmationTag);
    engine.history.recordEdge(
      edgeFromReplay(rootTag, sib1Commit.commit, sib1State),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib1Tag, sib2Commit.commit, sib2State),
    );
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    // The switch was abandoned: the engine's own tip is still canonical.
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    expect(engine.lifecycle).toBe("Stable");
  });
});
