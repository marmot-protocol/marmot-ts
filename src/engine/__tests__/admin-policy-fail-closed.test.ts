/**
 * The admin-only-commit gate must not depend on whether cosmetic group
 * components decode, and a component payload that does not decode must never
 * be staged or committed in the first place (08-REVIEW round 2, CR-03).
 *
 * Mirrors MDK: `admins_of_group` decodes only `admin_policy` (an absent policy
 * is an empty admin set, not "accept everything"), and
 * `authorize_staged_commit_proposals` / standalone proposal admission reject an
 * AppDataUpdate whose payload fails its component validator.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `admins_of_group`, `validate_app_data_update_batch`
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type ClientState,
  createCommit,
  createProposal,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  processMessage,
  type Proposal,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testPeeler } from "../../__tests__/helpers/engine-seam-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { encodeGroupProfileV1 } from "../../core/components/group-profile.js";
import {
  GROUP_AVATAR_URL_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { IngestResult } from "../types.js";

/**
 * Creator admin (`testAccount(6)`, the engine under test), a second admin
 * (`testAccount(0)`), and a non-admin member (`testAccount(9)`), all at epoch 1.
 */
async function adminsAndMemberGroup() {
  const admin = testAccount(6);
  const admin2 = testAccount(0);
  const member = testAccount(9);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const keyPackageFor = (account: typeof admin) =>
    generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
  const adminKp = await keyPackageFor(admin);
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Fail Closed Group",
    { adminPubkeys: [admin2.pubkey], relays: ["wss://relay.test"] },
  );
  const admin2Kp = await keyPackageFor(admin2);
  const memberKp = await keyPackageFor(member);
  const add = await createCommit({
    context: ctx,
    state: adminEpoch0,
    wireAsPublicMessage: false,
    ratchetTreeExtension: true,
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
  });
  const join = (kp: typeof adminKp) =>
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
    memberPubkey: member.pubkey,
    adminEpoch1: add.newState,
    admin2Epoch1: await join(admin2Kp),
    memberEpoch1: await join(memberKp),
  };
}

/** Applies `message` to `state` with no Marmot gates at all. */
async function rawApply(
  ctx: Awaited<ReturnType<typeof adminsAndMemberGroup>>["ctx"],
  state: ClientState,
  message: MlsMessage,
): Promise<ClientState> {
  const result = await processMessage({
    context: {
      cipherSuite: ctx.cipherSuite,
      authService: ctx.authService,
      externalPsks: {},
    },
    state,
    message,
  });
  if (result.kind !== "newState") throw new Error("expected newState");
  return result.newState;
}

const malformedAvatar: Proposal = {
  proposalType: appDataUpdateProposalType,
  appDataUpdate: {
    componentId: GROUP_AVATAR_URL_COMPONENT_ID,
    operation: "update",
    update: new Uint8Array([0xff]),
  },
};

const profileRename: Proposal = {
  proposalType: appDataUpdateProposalType,
  appDataUpdate: {
    componentId: GROUP_PROFILE_COMPONENT_ID,
    operation: "update",
    update: encodeGroupProfileV1({ name: "hijacked", description: "" }),
  },
};

async function drain(
  engine: MarmotGroupEngine<NostrEvent>,
  envelope: NostrEvent,
): Promise<IngestResult<NostrEvent>[]> {
  const out: IngestResult<NostrEvent>[] = [];
  for await (const r of engine.ingest([envelope])) out.push(r);
  return out;
}

describe("admin gate fails closed and component payloads are validated (CR-03)", () => {
  it("rejects a non-admin's admin-only commit even when an optional component is malformed", async () => {
    const { impl, ctx, adminEpoch1, admin2Epoch1, memberEpoch1 } =
      await adminsAndMemberGroup();
    const peeler = testPeeler(impl);

    // An epoch whose optional avatar bytes do not decode — reached with no
    // Marmot gates (a pre-upgrade build, or any peer that skipped validation).
    const corrupt = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [malformedAvatar],
    });
    const adminEpoch2 = await rawApply(ctx, adminEpoch1, corrupt.commit);
    const memberEpoch2 = await rawApply(ctx, memberEpoch1, corrupt.commit);
    expect(getMarmotGroupView(adminEpoch2)).toBeNull();

    const engine = new MarmotGroupEngine({
      state: adminEpoch2,
      ciphersuite: impl,
      peeler,
    });

    const nonAdmin = await createCommit({
      context: ctx,
      state: memberEpoch2,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [profileRename],
    });
    const results = await drain(
      engine,
      await peeler.wrapGroupMessage(nonAdmin.commit, memberEpoch2),
    );

    expect(results.filter((r) => r.kind === "processed")).toHaveLength(0);
    expect(results).toContainEqual(
      expect.objectContaining({ kind: "rejected", reason: "admin-policy" }),
    );
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
  });

  it("rejects an inbound standalone AppDataUpdate proposal whose payload does not decode, without staging it", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } =
      await adminsAndMemberGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const { message } = await createProposal({
      context: ctx,
      state: memberEpoch1,
      wireAsPublicMessage: true,
      proposal: malformedAvatar,
    });
    const results = await drain(
      engine,
      await peeler.wrapGroupMessage(message, memberEpoch1),
    );

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "component-integrity",
      }),
    );
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
  });

  it("rejects an inbound admin commit carrying an AppDataUpdate payload that does not decode", async () => {
    const { impl, ctx, adminEpoch1, admin2Epoch1 } =
      await adminsAndMemberGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const corrupt = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [malformedAvatar],
    });
    const results = await drain(
      engine,
      await peeler.wrapGroupMessage(corrupt.commit, admin2Epoch1),
    );

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "component-integrity",
      }),
    );
    expect(Number(engine.state.groupContext.epoch)).toBe(1);
    expect(getMarmotGroupView(engine.state)).not.toBeNull();
  });
});
