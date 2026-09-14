import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import { createChatRumor } from "../../client/group/application-message.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { testAccount } from "../helpers/test-accounts.js";
import { TerminalWrapperLedger } from "../../client/group/wrapper-ledger.js";
import restartFaultFixture from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/restart-delivery-faults.v1.json";
import { projectCanonicalConformanceSnapshot } from "../conformance/snapshot.js";

const NETWORK: NostrNetworkInterface = {
  request: async () => {
    throw new Error("not used");
  },
  subscription: () => {
    throw new Error("not used");
  },
  publish: async () => {
    throw new Error("not used");
  },
  getUserInboxRelays: async () => {
    throw new Error("not used");
  },
};

async function collectKinds(gen: AsyncIterable<{ kind: string }>) {
  const kinds: string[] = [];
  for await (const r of gen) kinds.push(r.kind);
  return kinds;
}

/**
 * Pins the durable outer transport boundary: a terminally accepted verified
 * wrapper is persisted independently of MLS state and suppressed on restart.
 */
describe("application message replay across restart", () => {
  it("executes the pinned withheld/restarted/reordered duplicate delivery exactly once", async () => {
    const payload = restartFaultFixture.scenario.steps.find(
      (step) => step.type === "send_app_message",
    )?.payload;
    expect(payload).toBe("bob:restart-delivery");
    const expected = restartFaultFixture.expected_outcomes.find(
      (outcome) => outcome.type === "client_state",
    );

    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const aliceAccount = PrivateKeyAccount.generateNew();
    const bobAccount = PrivateKeyAccount.generateNew();
    const carolAccount = PrivateKeyAccount.generateNew();
    const alice = await aliceAccount.signer.getPublicKey();
    const bob = await bobAccount.signer.getPublicKey();
    const carol = await carolAccount.signer.getPublicKey();
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const aliceKp = await generateKeyPackage({
      credential: createCredential(alice),
      signer: aliceAccount.signer,
      ciphersuiteImpl: impl,
    });
    const bobKp = await generateKeyPackage({
      credential: createCredential(bob),
      signer: bobAccount.signer,
      ciphersuiteImpl: impl,
    });
    const carolKp = await generateKeyPackage({
      credential: createCredential(carol),
      signer: carolAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      aliceKp,
      impl,
      "restart-delivery-faults",
      { adminPubkeys: [alice], relays: ["wss://relay.test"] },
    );
    const add = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: bobKp.publicPackage },
        },
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: carolKp.publicPackage },
        },
      ],
    });
    const bobState = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: bobKp.publicPackage,
      privateKeys: bobKp.privatePackage,
      ratchetTree: undefined,
    });
    const app = await createApplicationMessage({
      context: ctx,
      state: bobState,
      message: serializeApplicationRumor(
        createChatRumor({ pubkey: bob, content: payload! }),
      ),
    });
    const withheld = await createGroupEvent({
      message: app.message,
      state: bobState,
      ciphersuite: impl,
    });
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const ingestStateStore = new InMemoryKeyValueStore<Uint8Array>();
    const groupId = bytesToHex(add.newState.groupContext.groupId);
    await store.setItem(groupId, serializeClientState(add.newState));
    const restarted = new MarmotGroup(
      deserializeClientState((await store.getItem(groupId))!),
      {
        store,
        ingestStateStore,
        signer: { getPublicKey: async () => alice } as EventSigner,
        ciphersuite: impl,
        network: NETWORK,
      },
    );
    const results = [];
    for await (const result of restarted.ingest([withheld, withheld]))
      results.push(result);
    expect(
      results.filter((result) => result.kind === "processed"),
    ).toHaveLength(1);
    expect(Number(restarted.state.groupContext.epoch)).toBe(expected?.epoch);
    const snapshot = await projectCanonicalConformanceSnapshot({
      state: restarted.state,
      ciphersuite: impl,
      lifecycle: restarted.lifecycle,
      convergenceStatus: restarted.convergenceStatus,
    });
    expect(snapshot.leaves).toHaveLength(expected?.member_count);
  });
  it("recovers a prepared wrapper on either side of the canonical-state write", async () => {
    const ingestStateStore = new InMemoryKeyValueStore<Uint8Array>();
    const ledger = new TerminalWrapperLedger(ingestStateStore, "group");

    await ledger.begin("event", "state-before");
    // Crash before canonical state: the identical durable state retries.
    expect(await ledger.get("event", "state-before")).toBeUndefined();
    // An unrelated durable state change is not evidence that this wrapper was
    // applied and must never suppress it.
    expect(await ledger.get("event", "unrelated-state")).toBeUndefined();
    await ledger.stageApplied(
      "event",
      "state-before",
      "state-after",
      "accepted",
    );
    expect(await ledger.get("event", "unrelated-state")).toBeUndefined();
    // Only this wrapper's exact bound result state suppresses replay after a
    // crash between canonical persistence and terminalization.
    expect(await ledger.get("event", "state-after")).toBe("accepted");
    await ledger.record("event", "accepted");
    expect(await ledger.get("event", "state-before")).toBe("accepted");
  });

  it("does not re-process a terminal wrapper when the ingest ledger is reloaded", async () => {
    const impl: CiphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminAccount = testAccount(6);
    const memberAccount = testAccount(9);
    const adminPubkey = adminAccount.pubkey;
    const memberPubkey = memberAccount.pubkey;
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 2-member group: admin (the persisted receiver under test) + a member whose
    // raw state we drive to produce one application message.
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: adminEpoch0 } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
    );
    const memberKp = await generateKeyPackage({
      credential: createCredential(memberPubkey),
      signer: memberAccount.signer,
      ciphersuiteImpl: impl,
    });
    const add = await createCommit({
      context: ctx,
      state: adminEpoch0,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const adminEpoch1 = add.newState;
    const memberState = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });
    const groupId = bytesToHex(adminEpoch1.groupContext.groupId);

    // One valid Marmot app rumor from the member, wrapped as a kind-445 event.
    const rumor = createChatRumor({ pubkey: memberPubkey, content: "gm" });
    const app = await createApplicationMessage({
      context: ctx,
      state: memberState,
      message: serializeApplicationRumor(rumor),
    });
    const event = await createGroupEvent({
      message: app.message,
      state: memberState,
      ciphersuite: impl,
    });

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const ingestStateStore = new InMemoryKeyValueStore<Uint8Array>();
    const signer = { getPublicKey: async () => adminPubkey } as EventSigner;

    // Session 1: the admin delivers the message exactly once. Ingest persists the
    // advanced ratchet state to `store`.
    const first = new MarmotGroup(adminEpoch1, {
      store,
      ingestStateStore,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });
    const firstKinds = await collectKinds(first.ingest([event]));
    expect(firstKinds.filter((k) => k === "processed")).toHaveLength(1);
    first.dispose();

    // "Restart": rehydrate canonical state and reuse terminal wrapper evidence.
    const persisted = await store.getItem(groupId);
    expect(persisted).toBeDefined();
    const reloaded = new MarmotGroup(deserializeClientState(persisted!), {
      store,
      ingestStateStore,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });

    // Replay the exact same event. The durable outer-wrapper ledger suppresses
    // it before MLS work, including after reconstructing the group.
    const replayKinds = await collectKinds(reloaded.ingest([event]));
    expect(replayKinds).toEqual([]);
    // The replay did not advance or corrupt canonical state.
    expect(reloaded.state.groupContext.epoch).toBe(
      adminEpoch1.groupContext.epoch,
    );
  });
});
