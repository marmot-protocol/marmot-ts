/**
 * Every commit's COMPLETE resulting state must satisfy the current-profile
 * invariants, as MDK checks on every seam
 * (`validate_current_profile_invariants_for_staged_commit`): in particular
 * every resulting leaf advertises every required app component. ts-mls only
 * enforces MLS `required_capabilities`, and only for added leaves, so
 * marmot-ts applied commits MDK rejects, and the group split:
 *
 * - an Add of a KeyPackage that does not advertise a required component;
 * - an AppDataUpdate that makes a component required that a member lacks.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  generateKeyPackageWithKey,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  type Proposal,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { produceAccountIdentityProof } from "../../core/components/account-identity-proof.js";
import { encodeComponentsList } from "../../core/components/app-components-list.js";
import {
  getAppComponents,
  makeLeafAppComponentsExtension,
} from "../../core/components/dictionary.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
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

/** Admin + member at epoch 1; the group requires nostr routing (0x8004). */
async function group() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const kp = (slot: number) =>
    generateKeyPackage({
      credential: createCredential(testAccount(slot).pubkey),
      signer: testAccount(slot).signer,
      ciphersuiteImpl: impl,
    });
  const { clientState: epoch0 } = await createSimpleGroup(
    await kp(6),
    impl,
    "Group",
    { adminPubkeys: [testAccount(6).pubkey], relays: ["wss://relay.test"] },
  );
  expect(getAppComponents(epoch0.groupContext.extensions)).toContain(
    NOSTR_ROUTING_COMPONENT_ID,
  );
  const memberKp = await kp(9);
  const add = await createCommit({
    context: ctx,
    state: epoch0,
    wireAsPublicMessage: false,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
  });
  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { impl, ctx, adminEpoch1: add.newState, memberEpoch1 };
}

type Ctx = Awaited<ReturnType<typeof group>>["ctx"];

/** A raw admin commit (bypassing marmot-ts's own send gate), as another client makes it. */
async function rawCommit(ctx: Ctx, state: ClientState, proposals: Proposal[]) {
  return (
    await createCommit({
      context: ctx,
      state,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: proposals,
    })
  ).commit;
}

async function memberVerdict(
  impl: CiphersuiteImpl,
  memberEpoch1: ClientState,
  adminEpoch1: ClientState,
  commit: MlsMessage,
) {
  const peeler = testPeeler(impl);
  const engine = new MarmotGroupEngine({
    state: memberEpoch1,
    ciphersuite: impl,
    peeler,
  });
  const results: { kind: string; reason?: string }[] = [];
  for await (const result of engine.ingest([
    await peeler.wrapGroupMessage(commit, adminEpoch1),
  ]))
    results.push(result as { kind: string; reason?: string });
  return { engine, results };
}

describe("resulting-state current-profile invariants", () => {
  it("rejects an Add of a KeyPackage that does not advertise a required component", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } = await group();
    // A valid KeyPackage whose leaf supports everything except nostr routing.
    const invitee = testAccount(11);
    const signatureKeyPair = await impl.signature.keygen();
    const proof = await produceAccountIdentityProof({
      signer: invitee.signer,
      accountIdentity: hexToBytes(invitee.pubkey),
      mlsSignatureKey: signatureKeyPair.publicKey,
      ciphersuite: impl.id,
    });
    const narrow = await generateKeyPackageWithKey({
      credential: createCredential(invitee.pubkey),
      capabilities: defaultCapabilities(),
      lifetime: {
        notBefore: BigInt(Math.floor(Date.now() / 1000) - 60),
        notAfter: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      },
      extensions: [],
      signatureKeyPair,
      leafNodeExtensions: [
        makeLeafAppComponentsExtension(proof, [
          GROUP_PROFILE_COMPONENT_ID,
          GROUP_ADMIN_POLICY_COMPONENT_ID,
          GROUP_LIFECYCLE_COMPONENT_ID,
        ]),
      ],
      cipherSuite: impl,
    });
    const commit = await rawCommit(ctx, adminEpoch1, [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: narrow.publicPackage },
      },
    ]);
    const { engine, results } = await memberVerdict(
      impl,
      memberEpoch1,
      adminEpoch1,
      commit,
    );
    expect(results.map((r) => r.kind)).toContain("rejected");
    expect(Number(engine.state.groupContext.epoch)).toBe(1);
  });

  it("rejects an AppDataUpdate that requires a component a member does not advertise", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } = await group();
    const required = [
      ...(getAppComponents(adminEpoch1.groupContext.extensions) ?? []),
      GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
    ].sort((a, b) => a - b);
    const commit = await rawCommit(ctx, adminEpoch1, [
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: APP_COMPONENTS_COMPONENT_ID,
          operation: "update",
          update: encodeComponentsList(required),
        },
      },
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
          operation: "update",
          update: new Uint8Array([0]),
        },
      },
    ]);
    const { engine, results } = await memberVerdict(
      impl,
      memberEpoch1,
      adminEpoch1,
      commit,
    );
    expect(results.map((r) => r.kind)).toContain("rejected");
    expect(Number(engine.state.groupContext.epoch)).toBe(1);
  });

  it("still accepts an ordinary admin commit", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } = await group();
    const commit = await rawCommit(ctx, adminEpoch1, []);
    const { engine, results } = await memberVerdict(
      impl,
      memberEpoch1,
      adminEpoch1,
      commit,
    );
    expect(results.map((r) => r.kind)).not.toContain("rejected");
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
  });
});
