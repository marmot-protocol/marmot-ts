/**
 * CR-02: the pre-apply payload gate (`validatePreApplyProposals`) used to run
 * on five inbound seams and NO outbound seam, so the send path published — and
 * locally applied via `confirmPublished` — commits that its own `ingest()` and
 * every conformant peer reject. That is permanent divergence with no error
 * surfaced, and it is the same "a guard that exists on one seam only is a
 * documented bug" class (mdk#707) this phase closes inbound.
 *
 * These rows drive the real engine seams: `send({ kind: "commit" })`,
 * `send({ kind: "proposal" })`, and `send({ kind: "selfUpdate" })`.
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs `validate_app_data_update_batch_against`
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  type Proposal,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { decodeGroupLifecycleV1 } from "../../core/components/group-lifecycle.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  type AppComponentId,
  GROUP_LIFECYCLE_COMPONENT_ID,
} from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

/** Bytes no component codec in this library accepts (asserted below). */
const UNDECODABLE = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);

/** A component id with no decoder — opaque payloads stay legal (spec "Unknown Data"). */
const OPAQUE_COMPONENT_ID: AppComponentId = 0xbeef;

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

function appDataUpdate(
  componentId: AppComponentId,
  bytes: Uint8Array,
): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "update", update: bytes },
  };
}

/** A single-member current-profile group whose sole member is its admin. */
async function soloAdminGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const adminPubkey = adminAccount.pubkey;

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "Outbound Payload Gate Test",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );

  return { impl, adminPubkey, state: clientState };
}

describe("outbound pre-apply payload gate (CR-02)", () => {
  it("precondition: the undecodable fixture really does not decode", () => {
    expect(() => decodeGroupLifecycleV1(UNDECODABLE)).toThrow();
  });

  it("refuses a commit carrying a by-value AppDataUpdate whose payload does not decode", async () => {
    const { impl, adminPubkey, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const beforeTag = engine.state.confirmationTag;

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          appDataUpdate(GROUP_LIFECYCLE_COMPONENT_ID, UNDECODABLE),
        ],
      }),
    ).rejects.toThrow(CommitLegalityError);

    // Nothing was staged, published, or applied.
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
    expect(engine.state.confirmationTag).toEqual(beforeTag);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("reports the same structured violation the inbound seams report", async () => {
    const { impl, adminPubkey, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const error = await engine
      .send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          appDataUpdate(GROUP_LIFECYCLE_COMPONENT_ID, UNDECODABLE),
        ],
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(CommitLegalityError);
    expect((error as CommitLegalityError).violation).toMatchObject({
      reason: "component-integrity",
    });
  });

  it("refuses a commit whose batch breaks an MDK batch rule (duplicate component id)", async () => {
    const { impl, adminPubkey, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          appDataUpdate(OPAQUE_COMPONENT_ID, new Uint8Array([0x01])),
          appDataUpdate(OPAQUE_COMPONENT_ID, new Uint8Array([0x02])),
        ],
      }),
    ).rejects.toThrow(CommitLegalityError);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("refuses a commit that writes the leaf-only 0x8009 component into GroupContext", async () => {
    const { impl, adminPubkey, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [
          appDataUpdate(
            ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
            new Uint8Array([0x00]),
          ),
        ],
      }),
    ).rejects.toThrow(CommitLegalityError);
  });

  it("refuses a standalone AppDataUpdate proposal whose payload does not decode", async () => {
    const { impl, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      engine.send({
        kind: "proposal",
        proposal: appDataUpdate(GROUP_LIFECYCLE_COMPONENT_ID, UNDECODABLE),
      }),
    ).rejects.toThrow(CommitLegalityError);
  });

  it("prunes an inadmissible STAGED AppDataUpdate instead of blocking every local commit", async () => {
    // WR-05's rationale extended to AppDataUpdates: a proposal staged by an
    // older build or by a rewind onto a pre-upgrade snapshot must not pin the
    // group out of selfUpdate for the rest of the epoch.
    const { impl, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state: {
        ...state,
        unappliedProposals: {
          staged: {
            proposal: appDataUpdate(GROUP_LIFECYCLE_COMPONENT_ID, UNDECODABLE),
            senderLeafIndex: 0,
          },
        },
      },
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const result = await engine.send({ kind: "selfUpdate" });
    expect(result.kind).toBe("selfUpdate");
  });

  it("control: a commit carrying a legal opaque AppDataUpdate still succeeds", async () => {
    const { impl, adminPubkey, state } = await soloAdminGroup();
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const result = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        appDataUpdate(OPAQUE_COMPONENT_ID, new Uint8Array([0x01, 0x02])),
      ],
    });
    expect(result.kind).toBe("groupEvolution");
  });
});
