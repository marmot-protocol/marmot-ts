/**
 * Same-epoch race resolution must use the full `convergence.md` comparison
 * (depth, witness quorum, witness score, `tip_priority`, `tip_committer`,
 * `tip_digest`) on every path that selects a branch: pool replay when the
 * competing commit arrives, and the tree-fed re-scoring that runs after every
 * ingest. Before this was fixed, pool replay skipped `tip_priority` and the
 * tree pass knew neither the committer nor the priority, so it fell through to
 * the digest and switched the tip to whichever commit hashed lower.
 *
 * Found against MDK (White Noise): a marmot-ts admin's rename raced an MDK
 * member's self-update. MDK kept the admin rename (privileged); marmot-ts kept
 * the self-update and the group split. Two MDK members racing SelfRemove-only
 * commits split the same way: MDK kept the lower committer, marmot-ts the
 * lower digest.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
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
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { groupProfileEntry } from "../../core/components/dictionary.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
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
 * Admin plus two members at epoch 1. Test-account slots sort by pubkey, so the
 * slot numbers fix which account has the lower `tip_committer`.
 */
async function groupAtEpoch1(slots: {
  admin: number;
  memberA: number;
  memberB: number;
}) {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const keyPackage = async (slot: number) => {
    const account = testAccount(slot);
    return generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
  };
  const adminKp = await keyPackage(slots.admin);
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Race",
    {
      adminPubkeys: [testAccount(slots.admin).pubkey],
      relays: ["wss://relay.test"],
    },
  );
  const memberAKp = await keyPackage(slots.memberA);
  const memberBKp = await keyPackage(slots.memberB);
  const add = await createCommit({
    context: ctx,
    state: adminEpoch0,
    wireAsPublicMessage: false,
    extraProposals: [memberAKp, memberBKp].map((kp) => ({
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: kp.publicPackage },
    })),
    ratchetTreeExtension: true,
  });
  const join = (kp: typeof memberAKp) =>
    joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: kp.publicPackage,
      privateKeys: kp.privatePackage,
      ratchetTree: undefined,
    });
  return {
    impl,
    ctx,
    adminEpoch1: add.newState,
    memberAEpoch1: await join(memberAKp),
    memberBEpoch1: await join(memberBKp),
  };
}

type Ctx = Awaited<ReturnType<typeof groupAtEpoch1>>["ctx"];

const digestOf = (message: MlsMessage) =>
  bytesToHex(commitDigest(encode(mlsMessageEncoder, message)));

function selfUpdate(ctx: Ctx, state: ClientState) {
  return createCommit({
    context: ctx,
    state,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
}

function rename(ctx: Ctx, state: ClientState, name: string) {
  const entry = groupProfileEntry({ name, description: "" });
  return createCommit({
    context: ctx,
    state,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: entry.componentId,
          operation: "update",
          update: entry.data,
        },
      },
    ],
  });
}

/**
 * Feeds `first` and `second` to a fresh observer engine in two separate
 * ingests (the competing commit arrives after the first was applied), then
 * runs the persisted-history re-scoring, and returns every tip it held.
 */
async function observe(
  impl: CiphersuiteImpl,
  observerEpoch1: ClientState,
  first: NostrEvent,
  second: NostrEvent,
) {
  const engine = new MarmotGroupEngine({
    state: deserializeClientState(serializeClientState(observerEpoch1)),
    ciphersuite: impl,
    peeler: testPeeler(impl),
  });
  const tips: string[] = [];
  for (const batch of [[first], [second], []]) {
    for await (const _ of engine.ingest(batch)) void _;
    tips.push(bytesToHex(engine.state.confirmationTag));
  }
  await engine.reconvergeFromHistory();
  tips.push(bytesToHex(engine.state.confirmationTag));
  return tips;
}

const MAX_ATTEMPTS = 40;

describe("same-epoch race: tip ordering on every selection path", () => {
  it("keeps the lower committer of two ordinary commits even when the other digest is lower", async () => {
    // memberA (slot 3) sorts before memberB (slot 9); the admin observes.
    const { impl, ctx, adminEpoch1, memberAEpoch1, memberBEpoch1 } =
      await groupAtEpoch1({ admin: 12, memberA: 3, memberB: 9 });
    const peeler = testPeeler(impl);
    const low = await selfUpdate(ctx, memberAEpoch1);
    let high = await selfUpdate(ctx, memberBEpoch1);
    for (
      let i = 0;
      i < MAX_ATTEMPTS && digestOf(high.commit) > digestOf(low.commit);
      i++
    )
      high = await selfUpdate(ctx, memberBEpoch1);
    // The digest favours the higher committer, so a digest-only tie-break
    // would choose the wrong branch.
    expect(digestOf(high.commit) < digestOf(low.commit)).toBe(true);

    const envLow = await peeler.wrapGroupMessage(low.commit, memberAEpoch1);
    const envHigh = await peeler.wrapGroupMessage(high.commit, memberBEpoch1);
    const want = bytesToHex(low.newState.confirmationTag);

    for (const [first, second] of [
      [envLow, envHigh],
      [envHigh, envLow],
    ]) {
      const tips = await observe(impl, adminEpoch1, first, second);
      expect(tips.slice(1)).toEqual([want, want, want]);
    }
  });

  it("keeps an admin's privileged commit over a lower committer's self-update", async () => {
    // The member (slot 2) sorts before the admin (slot 13), so only
    // tip_priority can make the admin's rename win. memberB observes.
    const { impl, ctx, adminEpoch1, memberAEpoch1, memberBEpoch1 } =
      await groupAtEpoch1({ admin: 13, memberA: 2, memberB: 7 });
    const peeler = testPeeler(impl);
    const adminRename = await rename(ctx, adminEpoch1, "renamed by admin");
    const memberUpdate = await selfUpdate(ctx, memberAEpoch1);

    const envAdmin = await peeler.wrapGroupMessage(
      adminRename.commit,
      adminEpoch1,
    );
    const envMember = await peeler.wrapGroupMessage(
      memberUpdate.commit,
      memberAEpoch1,
    );
    const want = bytesToHex(adminRename.newState.confirmationTag);

    for (const [first, second] of [
      [envAdmin, envMember],
      [envMember, envAdmin],
    ]) {
      const tips = await observe(impl, memberBEpoch1, first, second);
      expect(tips.slice(1)).toEqual([want, want, want]);
    }
  });
});
