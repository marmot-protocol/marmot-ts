import type { NostrEvent } from "applesauce-core/helpers/event";
import { bytesToHex } from "@noble/hashes/utils.js";
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
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
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
  };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("MarmotGroupEngine history tree (full-fork retention)", () => {
  it("captures both branches of a fork as siblings of the shared parent", async () => {
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
      "Fork Group",
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

    // Two competing commits from the same epoch-1 admin state → a fork.
    const commitA = await createCommit({
      context: ctx,
      state: adminE1,
      extraProposals: [],
    });
    const commitB = await createCommit({
      context: ctx,
      state: adminE1,
      extraProposals: [],
    });
    const eventA = await createGroupEvent({
      message: commitA.commit,
      state: adminE1,
      ciphersuite: impl,
    });
    const eventB = await createGroupEvent({
      message: commitB.commit,
      state: adminE1,
      ciphersuite: impl,
    });

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberE1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const rootTag = bytesToHex(memberE1.confirmationTag);
    expect(engine.history.rootTag).toBe(rootTag);
    expect(engine.history.size).toBe(1);

    // Follow branch A onto epoch 2, then receive the competing past-epoch
    // commit B: fork recovery materializes both branches and the tree retains
    // them, even though only one stays canonical.
    await drain(engine.ingest([eventA]));
    await drain(engine.ingest([eventB]));

    const children = engine.history.childrenOf(rootTag);
    expect(children).toHaveLength(2);
    expect(engine.history.size).toBe(3);
    for (const child of children) expect(engine.history.epochOf(child)).toBe(2);
    expect(new Set(engine.history.tips())).toEqual(new Set(children));

    // The current canonical tip is one of the two retained fork branches, and
    // its state rehydrates from the tree.
    const tipTag = bytesToHex(engine.state.confirmationTag);
    expect(children).toContain(tipTag);
    expect(bytesToHex(engine.history.stateAt(tipTag)!.confirmationTag)).toBe(
      tipTag,
    );
  });
});
