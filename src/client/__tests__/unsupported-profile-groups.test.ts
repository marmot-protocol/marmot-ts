/**
 * D-11/D-12: stored groups outside the current account-identity-proof
 * profile (legacy, mixed, or missing the `0x8009` requirement) load
 * alongside current-profile groups, expose a typed `profileSupport` flag,
 * refuse all outbound and inbound traffic, publish or delete nothing
 * automatically, and are removable via `destroy()`.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  createCommit,
  defaultCryptoProvider,
  defaultExtensionTypes,
  defaultProposalTypes,
  getCiphersuiteImpl,
  selfRemoveProposalType,
  type CiphersuiteImpl,
  type ExtensionRequiredCapabilities,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import { MarmotClient } from "../marmot-client.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { dropAccountIdentityProofRequirement } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { marmotAuthService } from "../../core/auth-service.js";
import {
  serializeClientState,
  type SerializedClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  adminPolicyEntry,
  groupProfileEntry,
} from "../../core/components/index.js";
import { createGroup, createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import {
  disbandRequestKey,
  encodeDisbandRequest,
} from "../../engine/disband-request.js";
import type { StoredKeyPackage } from "../key-package-manager.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
// Legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`) -- referenced only as a literal to build a mixed-profile
// required_capabilities extension (CUT-01: no import from the legacy module).
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

async function currentProfileGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "Current Profile",
    { adminPubkeys: [adminAccount.pubkey] },
  );
  return { impl, adminAccount, state: clientState };
}

/** A "neither" (missing-requirement) group: current-profile, then a commit dropping 0x8009. */
async function neitherProfileGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const ctx = { cipherSuite: impl, authService: marmotAuthService };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "Neither Profile",
    { adminPubkeys: [adminAccount.pubkey] },
  );
  const dropped = await createCommit({
    context: ctx,
    state: clientState,
    wireAsPublicMessage: false,
    extraProposals: [dropAccountIdentityProofRequirement(clientState)],
    ratchetTreeExtension: true,
  });
  return { impl, adminAccount, state: dropped.newState };
}

/** A "mixed" group: 0x8009 required (via the default component set) AND legacy 0xf2f1 required. */
async function mixedProfileGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const mixedRequiredCapabilities: ExtensionRequiredCapabilities = {
    extensionType: defaultExtensionTypes.required_capabilities,
    extensionData: {
      extensionTypes: [
        appDataDictionaryExtensionType,
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ].sort((a, b) => a - b),
      proposalTypes: [appDataUpdateProposalType, selfRemoveProposalType].sort(
        (a, b) => a - b,
      ),
      credentialTypes: [],
    },
  };
  const { clientState } = await createGroup({
    creatorKeyPackage: adminKp,
    components: [
      groupProfileEntry({ name: "Mixed Profile", description: "" }),
      adminPolicyEntry([adminAccount.pubkey]),
    ],
    extensions: [mixedRequiredCapabilities],
    ciphersuiteImpl: impl,
  });
  return { impl, adminAccount, state: clientState };
}

function fakeGroupEvent(groupId: Uint8Array): NostrEvent {
  return {
    id: bytesToHex(groupId).padEnd(64, "0").slice(0, 64),
    pubkey: "a".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 445,
    tags: [],
    content: "irrelevant-ciphertext",
    sig: "b".repeat(128),
  } as unknown as NostrEvent;
}

describe("stored groups outside the account identity proof profile (D-11, D-12)", () => {
  let mockNetwork: MockNetwork;
  let groupStateStore: InMemoryKeyValueStore<SerializedClientState>;
  let client: MarmotClient;
  let currentId: string;
  let neitherId: string;
  let mixedId: string;

  beforeEach(async () => {
    mockNetwork = new MockNetwork();
    groupStateStore = new InMemoryKeyValueStore<SerializedClientState>();

    const { adminAccount, state: currentState } = await currentProfileGroup();
    const { state: neitherState } = await neitherProfileGroup();
    const { state: mixedState } = await mixedProfileGroup();

    currentId = bytesToHex(currentState.groupContext.groupId);
    neitherId = bytesToHex(neitherState.groupContext.groupId);
    mixedId = bytesToHex(mixedState.groupContext.groupId);

    await groupStateStore.setItem(
      currentId,
      serializeClientState(currentState),
    );
    await groupStateStore.setItem(
      neitherId,
      serializeClientState(neitherState),
    );
    await groupStateStore.setItem(mixedId, serializeClientState(mixedState));

    client = new MarmotClient({
      groupStateStore,
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: adminAccount.signer,
      network: mockNetwork,
    });
  });

  it("loads a current-profile group alongside a 'neither' and a 'mixed' stored group via loadAll(), all three listed", async () => {
    const loaded = await client.groups.loadAll();
    expect(loaded).toHaveLength(3);
    expect(client.groups.loaded).toHaveLength(3);
  });

  it("reports profileSupport { kind: 'supported' } for the current group, and unsupported with the right proofReason for 'neither' and 'mixed'", async () => {
    await client.groups.loadAll();
    const current = await client.groups.get(currentId);
    const neither = await client.groups.get(neitherId);
    const mixed = await client.groups.get(mixedId);

    expect(current.profileSupport).toEqual({ kind: "supported" });
    expect(neither.profileSupport).toEqual({
      kind: "unsupported",
      proofReason: "missing-requirement",
    });
    expect(mixed.profileSupport).toEqual({
      kind: "unsupported",
      proofReason: "mixed-profile",
    });
  });

  it("refuses submitIntent and selfUpdate on an unsupported group with UnsupportedGroupProfileError, publishing nothing", async () => {
    await client.groups.loadAll();
    const neither = await client.groups.get(neitherId);
    const beforeEvents = mockNetwork.events.length;

    await expect(
      neither.submitIntent({
        kind: "applicationMessage",
        payload: new TextEncoder().encode("hi"),
      }),
    ).rejects.toMatchObject({ name: "UnsupportedGroupProfileError" });
    await expect(neither.selfUpdate()).rejects.toMatchObject({
      name: "UnsupportedGroupProfileError",
    });

    expect(mockNetwork.events.length).toBe(beforeEvents);
  });

  it("CR-04: rejects disband() and enableDisbanding() on an unsupported group, publishing nothing", async () => {
    // Both reach the engine through `#sendInner`, not `send()`, so before
    // CR-04 they built, wrapped and published a real commit on a group D-11
    // says must refuse all traffic.
    await client.groups.loadAll();
    const neither = await client.groups.get(neitherId);
    const beforeEvents = mockNetwork.events.length;

    expect(await neither.disband()).toMatchObject({ kind: "rejected" });
    expect(await neither.enableDisbanding()).toMatchObject({
      kind: "rejected",
    });

    expect(mockNetwork.events.length).toBe(beforeEvents);
    expect(neither.status).not.toBe("disbanded");
  });

  it("yields a skipped unsupported-profile result (stale disposition) for an inbound event on an unsupported group", async () => {
    await client.groups.loadAll();
    const mixed = await client.groups.get(mixedId);
    const event = fakeGroupEvent(mixed.id);

    const results = [];
    for await (const r of mixed.ingest([event])) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "skipped",
      reason: "unsupported-profile",
      disposition: { kind: "stale" },
    });
  });

  it("destroy() removes an unsupported group's stored state, publishing/removing nothing beforehand", async () => {
    await client.groups.loadAll();
    expect(await groupStateStore.getItem(neitherId)).not.toBeNull();

    await client.groups.destroy(neitherId);

    expect(await groupStateStore.getItem(neitherId)).toBeNull();
    expect(
      client.groups.loaded.some((g) => bytesToHex(g.id) === neitherId),
    ).toBe(false);
  });

  it("does not disband an unsupported group with a persisted pending disband request during load", async () => {
    await groupStateStore.setItem(
      disbandRequestKey(neitherId),
      encodeDisbandRequest({
        status: "pending",
        requestedAtMs: Date.now(),
        lastPreparedEpoch: null,
      }),
    );

    await client.groups.loadAll();
    const neither = await client.groups.get(neitherId);

    expect(neither.status).not.toBe("disbanded");
    expect(mockNetwork.events.length).toBe(0);
  });
});
