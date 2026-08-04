import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  mlsMessageEncoder,
  type ProposalRemove,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  SerializedClientState,
} from "../../core/client-state.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";
import type { GenericKeyValueStore } from "../../utils/key-value.js";

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
  store = new InMemoryKeyValueStore<SerializedClientState>(),
  removedMarkerStore?: GenericKeyValueStore<boolean>,
) {
  return new MarmotGroup(state, {
    store,
    signer: { getPublicKey: async () => pubkey } as EventSigner,
    ciphersuite: impl,
    network: recordingNetwork(published),
    removedMarkerStore,
  });
}

/**
 * Builds a 3-member group (admin "a", "d", "e"), then has the admin commit a
 * `Remove` targeting "e" — an involuntary removal. Returns "e"'s pre-removal
 * `ClientState`, the wrapped removing-commit envelope, and the raw commit
 * message (so a test can independently compute its expected digest).
 */
async function buildRemovalFixture() {
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
  const eEpoch1 = await joinGroup({
    context: ctx,
    welcome: welcomeMsg,
    keyPackage: eKp.publicPackage,
    privateKeys: eKp.privatePackage,
    ratchetTree: undefined,
  });

  // Admin "a" commits a Remove targeting "e" (leaf 2) — an involuntary removal.
  const removeE: ProposalRemove = {
    proposalType: defaultProposalTypes.remove,
    remove: { removed: eEpoch1.privatePath.leafIndex },
  };
  const { commit } = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [removeE],
  });
  const removeCommitEvent = await createGroupEvent({
    message: commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });

  return { impl, ePubkey, eEpoch1, removeCommitEvent, commit };
}

describe("involuntary removal signal", () => {
  it("emits `removed` and keeps the tombstone when an admin's commit removes us", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    // "e" ingests the commit that removes it.
    const ePublished: NostrEvent[] = [];
    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, ePublished, eStore);
    await eGroup.save(true); // persist initial state so we can assert it survives

    let removedEmitted = false;
    eGroup.on("removed", () => (removedEmitted = true));

    const kinds: string[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      kinds.push(r.kind);

    // The ingest surfaced a `removed` result and fired the event.
    expect(kinds).toContain("removed");
    expect(removedEmitted).toBe(true);

    // State is the tombstone, and it was NOT auto-destroyed: the store still
    // holds the (now removed) group state.
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await eStore.getItem(eGroup.idStr)).not.toBeNull();
  });

  /**
   * CR-05 regression: the removal marker records "realization already
   * happened", so it must never be durable ahead of the tombstone it
   * describes. `GroupSession.ingest` only reaches its trailing `save()` once
   * the generator is fully drained, so writing the marker inside the
   * `removed` branch left a window (a throwing `removed` listener, a consumer
   * that `break`s, a process exit, a rejected save) in which the marker said
   * "realized" while the persisted state was still a live-membership state.
   * On the next load `#realizeRemovalIfNeeded` bails on the state check, and
   * on re-ingest it bails on the marker check — so `removed` is never emitted
   * and queued outbound is never rejected.
   */
  it("persists the tombstone before writing the removal marker (CR-05)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const inner = new InMemoryKeyValueStore<boolean>();

    // Snapshots whatever the state store holds at the exact moment the marker
    // is written.
    let persistedAtMarkerWrite: SerializedClientState | null | undefined;
    let idHex = "";
    const removedMarkerStore: GenericKeyValueStore<boolean> = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        persistedAtMarkerWrite = await eStore.getItem(idHex);
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem(key),
    };

    const eGroup = marmotGroup(
      eEpoch1,
      ePubkey,
      impl,
      [],
      eStore,
      removedMarkerStore,
    );
    idHex = eGroup.idStr;
    await eGroup.save(true);

    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;

    expect(await inner.getItem(idHex)).toBe(true);
    expect(persistedAtMarkerWrite).toBeTruthy();
    expect(
      deserializeClientState(persistedAtMarkerWrite!).groupActiveState.kind,
    ).toBe("removedFromGroup");
  });

  it("attributes a selfRemoved notification to the removing commit's own digest (D-10/D-12)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent, commit } =
      await buildRemovalFixture();

    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, []);
    await eGroup.save(true);

    const removedResults: { notifications?: { kind: string }[] }[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      if (r.kind === "removed") removedResults.push(r as never);

    expect(removedResults).toHaveLength(1);
    const notifications = removedResults[0].notifications ?? [];
    const selfRemoved = notifications.find((n) => n.kind === "selfRemoved") as
      { kind: "selfRemoved"; commitDigest: Uint8Array } | undefined;
    expect(selfRemoved).toBeDefined();

    const expectedDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, commit as MlsMessage)),
    );
    expect(bytesToHex(selfRemoved!.commitDigest)).toBe(expectedDigest);
  });

  it("realizes removal exactly once on a first load with an unset marker, and zero times once the marker is set (D-12)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();

    // Build the removed tombstone WITHOUT a marker store wired, simulating a
    // process that applied the removing commit and then exited before
    // persisting realization state (a crash between commit-apply and
    // notification — D-12's motivating scenario).
    const liveGroup = marmotGroup(eEpoch1, ePubkey, impl, [], eStore);
    await liveGroup.save(true);
    for await (const _ of liveGroup.ingest([removeCommitEvent])) void _;
    await liveGroup.save(true);
    expect(liveGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await removedMarkerStore.getItem(liveGroup.idStr)).toBeNull();

    // `fromClientState` realizes internally (before returning), so a
    // listener attached to the returned instance can never observe that
    // internal emission — spy on the shared EventEmitter prototype instead,
    // which intercepts every `emit` call regardless of when it fires.
    const emitSpy = vi.spyOn(
      EventEmitter.prototype as unknown as { emit: () => boolean },
      "emit",
    );
    try {
      // First load with the marker store wired: marker is unset, so
      // `fromClientState` realizes — sets the marker and emits `removed`
      // exactly once.
      await MarmotGroup.fromClientState(liveGroup.state, {
        store: eStore,
        removedMarkerStore,
        signer: { getPublicKey: async () => ePubkey } as EventSigner,
        network: recordingNetwork([]),
      });
      const removedCallsAfterFirst = emitSpy.mock.calls.filter(
        (call) => call[0] === "removed",
      ).length;
      expect(removedCallsAfterFirst).toBe(1);
      expect(await removedMarkerStore.getItem(liveGroup.idStr)).toBe(true);

      emitSpy.mockClear();

      // Second load, same marker store: marker is already set, so
      // realization is a no-op — zero `removed` emissions.
      await MarmotGroup.fromClientState(liveGroup.state, {
        store: eStore,
        removedMarkerStore,
        signer: { getPublicKey: async () => ePubkey } as EventSigner,
        network: recordingNetwork([]),
      });
      const removedCallsAfterSecond = emitSpy.mock.calls.filter(
        (call) => call[0] === "removed",
      ).length;
      expect(removedCallsAfterSecond).toBe(0);
    } finally {
      emitSpy.mockRestore();
    }
  });
});
