/**
 * Shared engine-seam fixtures for the GRP-02 (D-04) seam-parity matrix
 * (`src/engine/__tests__/account-identity-proof-seams.test.ts`).
 *
 * Copied (not imported) from `src/engine/__tests__/commit-legality-seams.test.ts`
 * and `src/engine/__tests__/send-commit-legality.test.ts` per this plan's
 * explicit instruction not to modify those files -- both already establish
 * these exact patterns for the WIRE-03/CONV-01 seam-parity matrix, and this
 * module re-homes them so the GRP-02 matrix does not re-derive them.
 *
 * Test-only: `__tests__` is excluded from `tsconfig.build.json` and never
 * published.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  mlsMessageEncoder,
  type Proposal,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import type { EdgeSnapshot } from "../../engine/history-tree.js";
import type { GroupPeeler } from "../../engine/types.js";
import { forgeKeyPackage } from "./account-identity-proof-fixtures.js";
import { testAccount } from "./test-accounts.js";

/** A test-only {@link GroupPeeler} over Nostr group-message envelopes. */
export function testPeeler(
  ciphersuite: CiphersuiteImpl,
): GroupPeeler<NostrEvent> {
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
 * A two-admin group at epoch 1 (admin1 = `testAccount(6)`, the engine under
 * test; admin2 = `testAccount(0)`, a genuinely different leaf used to author
 * admin-authorized-but-illegal commits), with an optional third member
 * (`testAccount(9)`) forged with a tampered `0x8009` proof, added in the SAME
 * raw founding commit as admin2 -- bypassing every engine gate entirely, the
 * only way to get an already-invalid leaf into the tree (Pitfall 2,
 * 08-RESEARCH.md). `forgedLeafIndex` is that member's true MLS leaf index,
 * read from `adminEpoch1`'s ratchet tree via `getPubkeyLeafNodeIndexes`.
 */
export async function seamGroup(options?: { forgedMember?: "tampered" }) {
  const adminAccount = testAccount(6);
  const admin2Account = testAccount(0);
  const adminPubkey = adminAccount.pubkey;
  const admin2Pubkey = admin2Account.pubkey;
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
  const { clientState: epoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Seam Fixture Group",
    { adminPubkeys: [admin2Pubkey], relays: ["wss://relay.test"] },
  );

  const admin2Kp = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    signer: admin2Account.signer,
    ciphersuiteImpl: impl,
  });

  const extraProposals: Proposal[] = [
    {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: admin2Kp.publicPackage },
    },
  ];

  let forgedAccount: ReturnType<typeof testAccount> | undefined;
  let forgedKp: Awaited<ReturnType<typeof forgeKeyPackage>> | undefined;
  if (options?.forgedMember === "tampered") {
    forgedAccount = testAccount(9);
    forgedKp = await forgeKeyPackage({
      account: forgedAccount,
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    extraProposals.push({
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: forgedKp.publicPackage },
    });
  }

  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    extraProposals,
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

  let forgedEpoch1: ClientState | undefined;
  let forgedLeafIndex: number | undefined;
  if (forgedAccount && forgedKp) {
    forgedEpoch1 = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: forgedKp.publicPackage,
      privateKeys: forgedKp.privatePackage,
      ratchetTree: undefined,
    });
    [forgedLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      forgedAccount.pubkey,
    );
  }

  return {
    impl,
    ctx,
    adminPubkey,
    admin2Pubkey,
    adminEpoch1,
    admin2Epoch1,
    forgedEpoch1,
    forgedLeafIndex,
  };
}

/**
 * Builds the {@link EdgeSnapshot} `GroupHistoryTree.recordEdge` needs, so a
 * test can inject a branch edge directly into the tree -- simulating a
 * persisted edge written by an earlier build, without going through the
 * engine's normal ingest/replay gates.
 *
 * `childState` MUST be a state reached by replaying `commitMessage` from a
 * perspective OTHER than the commit's own committer (see
 * {@link buildAdmin1PerspectiveChain}'s doc comment) -- never the committer's
 * own `createCommit` result.
 */
export function edgeFromReplay(
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
 * Replays a chain of commits (authored by some OTHER party, e.g. admin2 or a
 * forged member) from `rootState` -- a state belonging to admin1 (the engine
 * under test) -- via raw `processMessage`, with NO Marmot gates (no
 * callback, so ts-mls's own `acceptAll` default applies), simulating a
 * pre-upgrade build that never enforced `validateCommitLegality`. Returns the
 * resulting admin1-perspective `ClientState` after each commit, in order.
 */
export async function buildAdmin1PerspectiveChain(
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

/**
 * A serialize/deserialize round trip, so a `ClientState` handed to
 * `resolveCandidateParent` (or replayed via {@link buildAdmin1PerspectiveChain})
 * is never an object an engine has already consumed/mutated in place.
 */
export function snapshot(state: ClientState): ClientState {
  return deserializeClientState(serializeClientState(state));
}
