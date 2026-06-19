import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  type ClientState,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
import { convergenceStatuses } from "../../core/convergence-status.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

const RELAY = "wss://relay.test";
const QUIESCENCE_MS = 1_000;

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

/** A controllable fake clock. */
function fakeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function marmotGroup(
  state: ClientState,
  pubkey: string,
  impl: CiphersuiteImpl,
  published: NostrEvent[],
  now: () => number,
) {
  return new MarmotGroup(state, {
    store: new InMemoryKeyValueStore<SerializedClientState>(),
    signer: { getPublicKey: async () => pubkey } as EventSigner,
    ciphersuite: impl,
    network: recordingNetwork(published),
    now,
    settlementQuiescenceMs: QUIESCENCE_MS,
  });
}

describe("convergence status (B5, increment 2)", () => {
  it("starts Settled, goes Syncing on a commit, then Settled after the quiescence window", async () => {
    const adminPubkey = "a".repeat(64);
    const dPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 2-member group: admin "a" (leaf 0), "d" (leaf 1).
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
    const { newState: adminEpoch1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dKp.publicPackage },
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

    // Admin makes a self-update commit (epoch 1 -> 2) for "d" to ingest, and an
    // application message at epoch 1 (which is NOT convergence-relevant).
    const { commit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const commitEvent = await createGroupEvent({
      message: commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const { message: appMessage } = await createApplicationMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
        externalPsks: {},
      },
      state: adminEpoch1,
      message: new TextEncoder().encode("hi"),
    });
    const appEvent = await createGroupEvent({
      message: appMessage,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const clock = fakeClock(100_000);
    const published: NostrEvent[] = [];
    const dGroup = marmotGroup(dEpoch1, dPubkey, impl, published, clock.now);

    // A freshly loaded group has no pending convergence input -> Settled.
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);

    // An application message is NOT convergence-relevant: it must not reset the
    // quiescence window, so the status stays Settled.
    for await (const _ of dGroup.ingest([appEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);

    // Ingesting a commit IS convergence-relevant: the quiescence window resets,
    // so status is Syncing immediately after.
    for await (const _ of dGroup.ingest([commitEvent])) void _;
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);

    // Still within the window -> still Syncing.
    clock.advance(QUIESCENCE_MS - 1);
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.syncing);

    // Window elapses with a clean fixed point -> Settled.
    clock.advance(1);
    expect(dGroup.convergenceStatus).toBe(convergenceStatuses.settled);
  });
});
