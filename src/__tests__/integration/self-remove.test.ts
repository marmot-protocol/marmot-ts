import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  type ClientState,
  createSelfRemoveProposal,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { getGroupMembers } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

const RELAY = "wss://relay.test";

/** A mock network that records every published event and acks it. */
function recordingNetwork(published: NostrEvent[]): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async (_relays, event) => {
      published.push(event);
      return { [RELAY]: { ok: true } as PublishResponse };
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

function marmotGroup(
  state: ClientState,
  pubkey: string,
  impl: CiphersuiteImpl,
  published: NostrEvent[],
) {
  return new MarmotGroup(state, {
    store: new InMemoryKeyValueStore<SerializedClientState>(),
    signer: { getPublicKey: async () => pubkey } as EventSigner,
    ciphersuite: impl,
    network: recordingNetwork(published),
  });
}

describe("SelfRemove member departure (B6)", () => {
  it("the elected committer auto-commits a peer's self_remove on ingest, removing them", async () => {
    const adminPubkey = "a".repeat(64);
    const dPubkey = "d".repeat(64);
    const ePubkey = "e".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 3-member group: admin "a" (leaf 0), "d" (leaf 1), "e" (leaf 2).
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const dKp = await generateKeyPackage({
      credential: createCredential(dPubkey),
      ciphersuiteImpl: impl,
    });
    const eKp = await generateKeyPackage({
      credential: createCredential(ePubkey),
      ciphersuiteImpl: impl,
    });
    const { newState: adminEpoch1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dKp.publicPackage },
        },
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: eKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const welcomeMsg = welcome!.welcome ?? (welcome as never);
    const dEpoch1 = await joinGroup({
      context: ctx,
      welcome: welcomeMsg,
      keyPackage: dKp.publicPackage,
      privateKeys: dKp.privatePackage,
      ratchetTree: undefined,
    });
    const eEpoch1 = await joinGroup({
      context: ctx,
      welcome: welcomeMsg,
      keyPackage: eKp.publicPackage,
      privateKeys: eKp.privatePackage,
      ratchetTree: undefined,
    });

    // "e" (non-admin, leaf 2) proposes its own departure via self_remove.
    const selfRemove = await createSelfRemoveProposal({
      context: ctx,
      state: eEpoch1,
    });
    const selfRemoveEvent = await createGroupEvent({
      message: selfRemove.message,
      state: eEpoch1,
      ciphersuite: impl,
    });

    // A non-elected member ("d", leaf 1) just observes — eligible lowest is the
    // admin at leaf 0, so "d" must NOT auto-commit.
    const dPublished: NostrEvent[] = [];
    const dGroup = marmotGroup(dEpoch1, dPubkey, impl, dPublished);
    const dKinds: string[] = [];
    for await (const r of dGroup.ingest([selfRemoveEvent])) dKinds.push(r.kind);
    expect(dKinds).not.toContain("autoCommit");
    expect(dPublished).toHaveLength(0);
    // "d" still holds the self_remove as a pending proposal.
    expect(Object.keys(dGroup.state.unappliedProposals)).toHaveLength(1);

    // The elected committer (admin "a", leaf 0) ingests the same self_remove and
    // auto-commits it.
    const adminPublished: NostrEvent[] = [];
    const adminGroup = marmotGroup(
      adminEpoch1,
      adminPubkey,
      impl,
      adminPublished,
    );
    let sawAutoCommit = false;
    for await (const r of adminGroup.ingest([selfRemoveEvent])) {
      if (r.kind === "autoCommit") sawAutoCommit = true;
    }
    expect(sawAutoCommit).toBe(true);
    // Published exactly the auto-commit (publish-before-apply confirmed it).
    expect(adminPublished).toHaveLength(1);
    expect(adminGroup.state.groupContext.epoch).toBe(
      adminEpoch1.groupContext.epoch + 1n,
    );
    expect(adminGroup.lifecycle).toBe("Stable");
    // "e" is gone from the admin's view; "a" and "d" remain.
    const adminMembers = getGroupMembers(adminGroup.state);
    expect(adminMembers).toContain(adminPubkey);
    expect(adminMembers).toContain(dPubkey);
    expect(adminMembers).not.toContain(ePubkey);

    // "d" applies the admin's auto-commit and converges (same epoch + tag).
    const autoCommitEvent = adminPublished[0]!;
    for await (const _ of dGroup.ingest([autoCommitEvent])) void _;
    expect(dGroup.state.groupContext.epoch).toEqual(
      adminGroup.state.groupContext.epoch,
    );
    expect(dGroup.state.confirmationTag).toEqual(
      adminGroup.state.confirmationTag,
    );
    expect(getGroupMembers(dGroup.state)).not.toContain(ePubkey);

    // "e" applies the commit removing it and detects it is no longer a member.
    // Build from the post-proposal state so e holds its own self_remove in
    // unappliedProposals (the admin's commit references it by ref).
    const ePublished: NostrEvent[] = [];
    const eGroup = marmotGroup(selfRemove.newState, ePubkey, impl, ePublished);
    for await (const _ of eGroup.ingest([autoCommitEvent])) void _;
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
  });
});
