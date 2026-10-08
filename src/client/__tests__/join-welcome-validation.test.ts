/**
 * `joinFromWelcome` validates the Marmot group state a Welcome installs
 * (`protocol-core/joining.md` receiving flow, steps 6 to 8), the way MDK's
 * `do_join_welcome` does: the Welcome author must be an admin, every admin
 * must have a member leaf, every known component must decode, and every
 * required component must be supported and present. A rejected Welcome
 * persists nothing.
 */
import {
  type CiphersuiteImpl,
  type ClientState,
  type ComponentData,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type Welcome,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { MarmotClient } from "../marmot-client.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { marmotAuthService } from "../../core/auth-service.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createGroup } from "../../core/group.js";
import {
  calculateKeyPackageRef,
  type CompleteKeyPackage,
  generateKeyPackage,
} from "../../core/key-package.js";
import {
  joinWelcomeWithAuthor,
  readWelcomeGroupInfo,
} from "../../core/welcome-join.js";
import {
  adminPolicyEntry,
  agentTextStreamEntry,
  groupProfileEntry,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
} from "../../core/components/index.js";
import { SUPPORTED_APP_COMPONENT_IDS } from "../../core/components/ids.js";
import { validateWelcomeGroupState } from "../../engine/welcome-validation.js";
import type { StoredKeyPackage } from "../key-package-manager.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

describe("joinFromWelcome Marmot group-state validation", () => {
  let cs: CiphersuiteImpl;
  let inviteeStore: InMemoryKeyValueStore<SerializedClientState>;
  let invitee: MarmotClient;
  const alice = testAccount(1);
  const bob = testAccount(2);
  const carol = testAccount(3);

  beforeEach(async () => {
    cs = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    inviteeStore = new InMemoryKeyValueStore<SerializedClientState>();
    invitee = new MarmotClient({
      groupStateStore: inviteeStore,
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: carol.signer,
      network: new MockNetwork(),
    });
  });

  const kpOf = (account: ReturnType<typeof testAccount>) =>
    generateKeyPackage({
      credential: createCredential(account.pubkey),
      ciphersuiteImpl: cs,
      signer: account.signer,
    });

  async function addMember(
    state: ClientState,
    kp: CompleteKeyPackage,
  ): Promise<{ state: ClientState; welcome: Welcome }> {
    const result = await createCommit({
      context: { cipherSuite: cs, authService: marmotAuthService },
      state,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: kp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    return { state: result.newState, welcome: result.welcome!.welcome! };
  }

  async function join(welcome: Welcome, kp: CompleteKeyPackage) {
    return invitee.groups.joinFromWelcome({
      welcome,
      candidates: [
        {
          publicPackage: kp.publicPackage,
          privatePackage: kp.privatePackage,
          keyPackageRef: await calculateKeyPackageRef(kp.publicPackage),
          hasMatchingSecret: true,
        },
      ],
      ciphersuiteImpl: cs,
    });
  }

  /** Alice founds a group, adds Bob, and Bob joins: Bob is leaf 1. */
  async function aliceAndBob(adminPubkeys: string[]) {
    const aliceKp = await kpOf(alice);
    const bobKp = await kpOf(bob);
    const { clientState } = await createGroup({
      creatorKeyPackage: aliceKp,
      components: [
        groupProfileEntry({ name: "g", description: "" }),
        adminPolicyEntry(adminPubkeys),
      ],
      ciphersuiteImpl: cs,
    });
    const added = await addMember(clientState, bobKp);
    const bobState = await joinGroup({
      context: {
        cipherSuite: cs,
        authService: marmotAuthService,
        externalPsks: {},
      },
      welcome: added.welcome,
      keyPackage: bobKp.publicPackage,
      privateKeys: bobKp.privatePackage,
    });
    expect(bobState.privatePath.leafIndex).toBe(1);
    return bobState;
  }

  /** A one-member Alice group built from raw components, then Carol is added. */
  async function welcomeFor(
    components: ComponentData[],
    requiredComponentIds?: number[],
  ) {
    const aliceKp = await kpOf(alice);
    const carolKp = await kpOf(carol);
    const { clientState } = await createGroup({
      creatorKeyPackage: aliceKp,
      components,
      requiredComponentIds,
      ciphersuiteImpl: cs,
    });
    const { welcome } = await addMember(clientState, carolKp);
    return { welcome, carolKp };
  }

  it("identifies the Welcome author as the GroupInfo signer, not leaf 0 or the joiner", async () => {
    // Bob (leaf 1) is an admin and invites Carol.
    const bobState = await aliceAndBob([alice.pubkey, bob.pubkey]);
    const carolKp = await kpOf(carol);
    const { welcome } = await addMember(bobState, carolKp);

    const joined = await joinWelcomeWithAuthor({
      welcome,
      keyPackage: carolKp.publicPackage,
      privateKeys: carolKp.privatePackage,
      ciphersuiteImpl: cs,
    });
    expect(joined.authorLeafIndex).toBe(1);
    expect(joined.state.privatePath.leafIndex).toBe(2);

    const info = await readWelcomeGroupInfo({
      welcome,
      keyPackage: carolKp,
      ciphersuiteImpl: cs,
    });
    expect(info.signer).toBe(1);

    const { group } = await join(welcome, carolKp);
    expect(group.state.groupContext.epoch).toBe(2n);
  });

  it("rejects a Welcome whose author is not an admin and persists nothing", async () => {
    // Only Alice is an admin; Bob (leaf 1) adds Carol anyway.
    const bobState = await aliceAndBob([alice.pubkey]);
    const carolKp = await kpOf(carol);
    const { welcome } = await addMember(bobState, carolKp);

    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      name: "WelcomeGroupStateError",
      reason: "author-not-admin",
    });
    expect(await inviteeStore.keys()).toEqual([]);
  });

  it("rejects a group whose admin has no member leaf", async () => {
    const { welcome, carolKp } = await welcomeFor([
      groupProfileEntry({ name: "g", description: "" }),
      adminPolicyEntry([alice.pubkey, bob.pubkey]),
    ]);
    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      reason: "admin-without-member-leaf",
    });
    expect(await inviteeStore.keys()).toEqual([]);
  });

  it("rejects a group that requires a component this client does not support", async () => {
    const { welcome, carolKp } = await welcomeFor(
      [
        groupProfileEntry({ name: "g", description: "" }),
        adminPolicyEntry([alice.pubkey]),
        { componentId: 0xf123, data: new Uint8Array([1]) },
      ],
      [0xf123],
    );
    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      reason: "unsupported-required-component",
    });
  });

  it("rejects a required component that has no GroupContext state", async () => {
    const { welcome, carolKp } = await welcomeFor(
      [
        groupProfileEntry({ name: "g", description: "" }),
        adminPolicyEntry([alice.pubkey]),
      ],
      [GROUP_MESSAGE_RETENTION_COMPONENT_ID],
    );
    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      reason: "missing-required-component",
    });
  });

  it("rejects a known component whose bytes do not decode", async () => {
    const { welcome, carolKp } = await welcomeFor([
      groupProfileEntry({ name: "g", description: "" }),
      adminPolicyEntry([alice.pubkey]),
      // message-retention is exactly 8 bytes
      {
        componentId: GROUP_MESSAGE_RETENTION_COMPONENT_ID,
        data: new Uint8Array(3),
      },
    ]);
    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      reason: "invalid-component",
    });
  });

  it("rejects a group that requires an agent-text-stream role this client does not advertise", async () => {
    const { welcome, carolKp } = await welcomeFor([
      groupProfileEntry({ name: "g", description: "" }),
      adminPolicyEntry([alice.pubkey]),
      // requires receive + send; marmot-ts only advertises receive
      agentTextStreamEntry({
        requiredMemberRoles: 0x03,
        allowedMemberRoles: 0x03,
        maxPlaintextFrameLen: 4096,
        replayTtlSecs: 0,
        paddingBucketBytes: 0,
      }),
    ]);
    await expect(join(welcome, carolKp)).rejects.toMatchObject({
      reason: "unsupported-member-role",
    });
  });

  it("accepts a group that requires the receive role", async () => {
    const { welcome, carolKp } = await welcomeFor([
      groupProfileEntry({ name: "g", description: "" }),
      adminPolicyEntry([alice.pubkey]),
      agentTextStreamEntry({
        requiredMemberRoles: 0x01,
        allowedMemberRoles: 0x03,
        maxPlaintextFrameLen: 4096,
        replayTtlSecs: 0,
        paddingBucketBytes: 0,
      }),
    ]);
    const { group } = await join(welcome, carolKp);
    expect(group.state.groupContext.epoch).toBe(1n);
  });

  it("rejects a group that requires a component a member leaf does not advertise", async () => {
    // 0xf123 is required and "supported" by this client, but no leaf
    // advertises it (MDK validate_resulting_leaf_capabilities).
    const { welcome, carolKp } = await welcomeFor(
      [
        groupProfileEntry({ name: "g", description: "" }),
        adminPolicyEntry([alice.pubkey]),
        { componentId: 0xf123, data: new Uint8Array([1]) },
      ],
      [0xf123],
    );
    await expect(
      invitee.groups.joinFromWelcome({
        welcome,
        candidates: [
          {
            publicPackage: carolKp.publicPackage,
            privatePackage: carolKp.privatePackage,
            keyPackageRef: await calculateKeyPackageRef(carolKp.publicPackage),
            hasMatchingSecret: true,
          },
        ],
        ciphersuiteImpl: cs,
      }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/component/) });
    // and directly, with 0xf123 treated as supported:
    const joined = await joinWelcomeWithAuthor({
      welcome,
      keyPackage: carolKp.publicPackage,
      privateKeys: carolKp.privatePackage,
      ciphersuiteImpl: cs,
    });
    expect(() =>
      validateWelcomeGroupState({
        state: joined.state,
        authorLeafIndex: joined.authorLeafIndex,
        supportedComponentIds: [...SUPPORTED_APP_COMPONENT_IDS, 0xf123],
      }),
    ).toThrow(/does not advertise required app component 0xf123/);
  });
});
