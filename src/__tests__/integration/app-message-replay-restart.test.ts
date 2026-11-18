import { bytesToHex } from "@noble/hashes/utils.js";
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
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { memoryStorage, StorageBatch } from "../../utils/storage.js";
import { testAccount } from "../helpers/test-accounts.js";
import { TerminalWrapperLedger } from "../../client/group/wrapper-ledger.js";
import restartFaultFixture from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/restart-delivery-faults.v1.json" with { type: "json" };
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
    expect(expected).toBeDefined();
    if (!expected || expected.member_count === undefined)
      throw new Error("expected pinned client-state member count");

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
    const storage = memoryStorage();
    const groupId = bytesToHex(add.newState.groupContext.groupId);
    await storage.set(`${groupId}/state`, serializeClientState(add.newState));
    const restarted = new MarmotGroup(
      deserializeClientState((await storage.get(`${groupId}/state`))!),
      {
        storage,
        signer: aliceAccount.signer,
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
    expect(Number(restarted.state.groupContext.epoch)).toBe(expected.epoch);
    const snapshot = await projectCanonicalConformanceSnapshot({
      state: restarted.state,
      ciphersuite: impl,
      lifecycle: restarted.lifecycle,
      convergenceStatus: restarted.convergenceStatus,
    });
    expect(snapshot.leaves).toHaveLength(expected.member_count);
  });
  it("makes a wrapper record durable only with the batch that commits its state", async () => {
    const storage = memoryStorage();
    const ledger = new TerminalWrapperLedger(storage, "group");
    const event = "a".repeat(64);

    // A record staged with its producing state is invisible until the batch
    // commits: a crash before the canonical-state write retries the wrapper.
    const failing = new StorageBatch({
      get: (key) => storage.get(key),
      set: (key, value) => storage.set(key, value),
      delete: (key) => storage.delete(key),
      list: (prefix) => storage.list(prefix),
      batch: async () => {
        throw new Error("crash before commit");
      },
    });
    ledger.stage(failing, event, "accepted", 1);
    failing.set("group/state", Uint8Array.of(1));
    await expect(failing.commit()).rejects.toThrow("crash before commit");
    expect(await ledger.get(event)).toBeUndefined();
    expect(await storage.get("group/state")).toBeUndefined();

    // Committed atomically with the state it produced, it suppresses replay.
    const batch = new StorageBatch(storage);
    ledger.stage(batch, event, "accepted", 1);
    batch.set("group/state", Uint8Array.of(1));
    expect(await ledger.get(event)).toBeUndefined();
    await batch.commit();
    expect(await ledger.get(event)).toBe("accepted");
    expect(await storage.get("group/state")).toEqual(Uint8Array.of(1));
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

    const storage = memoryStorage();
    const signer = adminAccount.signer;

    // Session 1: the admin delivers the message exactly once. Ingest persists the
    // advanced ratchet state to `storage`.
    const first = new MarmotGroup(adminEpoch1, {
      storage,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });
    const firstKinds = await collectKinds(first.ingest([event]));
    expect(firstKinds.filter((k) => k === "processed")).toHaveLength(1);
    first.dispose();

    // "Restart": rehydrate canonical state and reuse terminal wrapper evidence.
    const persisted = await storage.get(`${groupId}/state`);
    expect(persisted).toBeDefined();
    const reloaded = new MarmotGroup(deserializeClientState(persisted!), {
      storage,
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
