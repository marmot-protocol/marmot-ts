/**
 * `joinFromWelcome` account identity proof profile enforcement (CUT-02, D-07):
 * joining accepts a current-profile group and rejects a mixed-profile group or
 * a group whose member proof is invalid, persisting nothing in either case
 * (T-07-26, T-07-27).
 */
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  createCommit,
  defaultCryptoProvider,
  defaultExtensionTypes,
  defaultProposalTypes,
  getCiphersuiteImpl,
  generateKeyPackageWithKey,
  joinGroupWithExtensions,
  selfRemoveProposalType,
  type CiphersuiteImpl,
  type ExtensionRequiredCapabilities,
} from "ts-mls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";

import { MarmotClient } from "../marmot-client.js";
import {
  memoryStorage,
  type MemoryStorage,
  type StorageOp,
} from "../../utils/storage.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  dropAccountIdentityProofRequirement,
  forgeKeyPackage,
} from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { marmotAuthService } from "../../core/auth-service.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { validateWelcomeGroup } from "../../core/welcome-join.js";
import { createCredential } from "../../core/credential.js";
import { createWelcomeRumor } from "../../core/welcome-event.js";
import { defaultCapabilities } from "../../core/default-capabilities.js";
import { createGroup, createSimpleGroup } from "../../core/group.js";
import {
  calculateKeyPackageRef,
  generateKeyPackage,
} from "../../core/key-package.js";
import {
  classifyGroupAccountIdentityProofProfile,
  produceAccountIdentityProof,
} from "../../core/components/account-identity-proof.js";
import { makeLeafAppComponentsExtension } from "../../core/components/dictionary.js";
import {
  adminPolicyEntry,
  componentEntry,
  groupLifecycleEntry,
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  groupProfileEntry,
  encodeGroupBlossomImage,
  type GroupBlossomImage,
} from "../../core/components/index.js";
import { createDefaultKeyPackageLifetime } from "../../utils/timestamp.js";
import {
  GROUP_PREFIX,
  KEY_PACKAGE_PREFIX,
  groupKeys,
} from "../storage-keys.js";

/** Every key and value under `prefix`, copied. */
async function snapshot(storage: MemoryStorage, prefix: string) {
  return (await storage.list(prefix)).map((key) => [
    key,
    storage.data.get(key)?.slice(),
  ]);
}

/** Ids of the groups whose canonical state is stored. */
async function storedGroupIds(storage: MemoryStorage): Promise<string[]> {
  return (await storage.list(GROUP_PREFIX))
    .filter((key) => key.endsWith("/state"))
    .map((key) => key.slice(GROUP_PREFIX.length, -"/state".length));
}

const isStateWrite = (ops: readonly StorageOp[]) =>
  ops.some(
    (op) =>
      op.type === "set" &&
      op.key.startsWith(GROUP_PREFIX) &&
      op.key.endsWith("/state"),
  );

/** Records every batch that writes a group's canonical state. */
function stateWrites(storage: MemoryStorage) {
  const writes = vi.fn();
  const batch = storage.batch.bind(storage);
  vi.spyOn(storage, "batch").mockImplementation(async (ops) => {
    if (isStateWrite(ops)) writes(ops);
    return batch(ops);
  });
  return writes;
}

/** Makes the next canonical-state batch fail. */
function failNextStateWrite(storage: MemoryStorage, error: Error) {
  const batch = storage.batch.bind(storage);
  let failed = false;
  vi.spyOn(storage, "batch").mockImplementation(async (ops) => {
    if (!failed && isStateWrite(ops)) {
      failed = true;
      throw error;
    }
    return batch(ops);
  });
}

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;
// Legacy `marmot.account-identity-proof.v2` custom LeafNode extension
// (`0xf2f1`) -- referenced only as a literal to build a mixed-profile
// required_capabilities extension (CUT-01: no import from the legacy module).
const LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1;

describe("joinFromWelcome account identity proof profile (CUT-02, D-07)", () => {
  let ciphersuiteImpl: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let inviteeStorage: MemoryStorage;
  let inviteeClient: MarmotClient;

  beforeEach(async () => {
    ciphersuiteImpl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    mockNetwork = new MockNetwork();
    inviteeStorage = memoryStorage();
    const inviteeAccount = testAccount(9);
    inviteeClient = new MarmotClient({
      storage: inviteeStorage,
      signer: inviteeAccount.signer,
      network: mockNetwork,
    });
  });

  /** Adds `inviteeKeyPackage` to `state` via a real MLS commit, returning the Welcome. */
  async function commitInviteeAdd(
    state: Awaited<ReturnType<typeof createSimpleGroup>>["clientState"],
    inviteeKeyPackage: Awaited<
      ReturnType<typeof generateKeyPackage>
    >["publicPackage"],
  ) {
    const add = await createCommit({
      context: { cipherSuite: ciphersuiteImpl, authService: marmotAuthService },
      state,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: inviteeKeyPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    return add.welcome!.welcome!;
  }

  async function joinAsInvitee(
    welcome: Awaited<ReturnType<typeof commitInviteeAdd>>,
    inviteeKp: Awaited<ReturnType<typeof generateKeyPackage>>,
  ) {
    const keyPackageRef = await calculateKeyPackageRef(inviteeKp.publicPackage);
    return inviteeClient.groups.joinFromWelcome({
      welcome,
      candidates: [
        {
          publicPackage: inviteeKp.publicPackage,
          privatePackage: inviteeKp.privatePackage,
          keyPackageRef,
          hasMatchingSecret: true,
        },
      ],
      ciphersuiteImpl,
    });
  }

  async function imageWelcome(required: boolean, data: Uint8Array) {
    const admin = testAccount(6);
    const invitee = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(admin.pubkey),
      ciphersuiteImpl,
      signer: admin.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(invitee.pubkey),
      ciphersuiteImpl,
      signer: invitee.signer,
      isLastResort: false,
    });
    const { clientState } = await createGroup({
      creatorKeyPackage: adminKp,
      ciphersuiteImpl,
      components: [
        groupProfileEntry({ name: "Image Welcome", description: "" }),
        adminPolicyEntry([admin.pubkey]),
        componentEntry(GROUP_BLOSSOM_IMAGE_COMPONENT_ID, data),
      ],
      requiredComponentIds: required ? [GROUP_BLOSSOM_IMAGE_COMPONENT_ID] : [],
    });
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );
    // A real MLS join verifies the GroupInfo signature, tree and confirmation
    // before the independent Marmot complete-state admission check.
    const joined = await joinGroupWithExtensions({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
        externalPsks: {},
      },
      welcome,
      keyPackage: inviteeKp.publicPackage,
      privateKeys: inviteeKp.privatePackage,
    });
    const welcomeRumor = createWelcomeRumor({
      welcome,
      author: admin.pubkey,
      groupRelays: ["wss://relay.test"],
      keyPackageEventId: "ab".repeat(32),
    });
    return { admin, inviteeKp, welcome, welcomeRumor, joined };
  }

  const malformedImages = [
    { shape: "truncated", data: Uint8Array.of(1) },
    { shape: "zero-length", data: new Uint8Array() },
  ];
  it.each(
    [false, true].flatMap((required) =>
      malformedImages.map((image) => ({ required, ...image })),
    ),
  )(
    "rejects a signed $shape image Welcome (required=$required) before all join effects",
    async ({ required, data }) => {
      const existing = await inviteeClient.groups.create("Existing", {
        relays: ["wss://relay.test"],
      });
      const { inviteeKp, welcome, welcomeRumor, joined } = await imageWelcome(
        required,
        data,
      );
      await inviteeClient.keyPackages.add(inviteeKp);
      const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
      const beforeGroups = structuredClone(
        await snapshot(inviteeStorage, GROUP_PREFIX),
      );
      const beforePackages = structuredClone(
        await snapshot(inviteeStorage, KEY_PACKAGE_PREFIX),
      );
      const beforePrivate = structuredClone(
        await inviteeClient.keyPackages.getPrivateKey(ref),
      );
      const beforeAdopt = vi.fn(async () => {});
      const receipt = vi.spyOn(inviteeClient.keyPackages, "recordConsumption");
      const save = vi.spyOn(inviteeStorage, "batch");
      const packageWrite = vi.spyOn(inviteeStorage, "set");
      const joinedEvent = vi.fn();
      const updatedEvent = vi.fn();
      const loadedEvent = vi.fn();
      inviteeClient.groups.on("joined", joinedEvent);
      inviteeClient.groups.on("updated", updatedEvent);
      inviteeClient.groups.on("loaded", loadedEvent);

      expect(() =>
        validateWelcomeGroup(joined.state, joined.groupInfo),
      ).toThrow();
      await expect(
        inviteeClient.groups.joinFromWelcome({
          welcome,
          candidates: [
            { ...inviteeKp, keyPackageRef: ref, hasMatchingSecret: true },
          ],
          ciphersuiteImpl,
          beforeAdopt,
        }),
      ).rejects.toThrow();
      await expect(
        inviteeClient.joinGroupFromWelcome({ welcomeRumor }),
      ).rejects.toThrow();

      expect(beforeAdopt).not.toHaveBeenCalled();
      expect(receipt).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(packageWrite).not.toHaveBeenCalled();
      expect(joinedEvent).not.toHaveBeenCalled();
      expect(updatedEvent).not.toHaveBeenCalled();
      expect(loadedEvent).not.toHaveBeenCalled();
      expect(inviteeClient.groups.loaded).toEqual([existing]);
      expect(await snapshot(inviteeStorage, GROUP_PREFIX)).toEqual(
        beforeGroups,
      );
      expect(await snapshot(inviteeStorage, KEY_PACKAGE_PREFIX)).toEqual(
        beforePackages,
      );
      expect(await inviteeClient.keyPackages.getPrivateKey(ref)).toEqual(
        beforePrivate,
      );
      expect(beforePrivate).not.toBeNull();
    },
  );

  const validImages: GroupBlossomImage[] = [
    { kind: "empty" },
    {
      kind: "present",
      imageHash: new Uint8Array(32).fill(1),
      imageKey: new Uint8Array(32).fill(2),
      imageNonce: new Uint8Array(12).fill(3),
      imageUploadKey: new Uint8Array(32).fill(4),
      mediaType: "image/png",
    },
  ];
  it.each(
    [false, true].flatMap((required) =>
      validImages.map((image) => ({ required, kind: image.kind, image })),
    ),
  )(
    "adopts a signed $kind image Welcome (required=$required) and retires its single-use key",
    async ({ required, image }) => {
      const { admin, inviteeKp, welcomeRumor, joined } = await imageWelcome(
        required,
        encodeGroupBlossomImage(image),
      );
      expect(validateWelcomeGroup(joined.state, joined.groupInfo)).toBe(
        admin.pubkey,
      );
      await inviteeClient.keyPackages.add(inviteeKp);
      const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
      const joinedEvent = vi.fn();
      inviteeClient.groups.on("joined", joinedEvent);
      const { group } = await inviteeClient.joinGroupFromWelcome({
        welcomeRumor,
      });
      expect(getMarmotGroupView(group.state)?.blossomImage).toEqual(image);
      expect(
        await inviteeStorage.get(GROUP_PREFIX + groupKeys.state(group.idStr)),
      ).toBeDefined();
      expect(inviteeClient.groups.loaded).toEqual([group]);
      expect(joinedEvent).toHaveBeenCalledExactlyOnceWith(group);
      expect(await inviteeClient.keyPackages.getPrivateKey(ref)).toBeNull();
      expect((await inviteeClient.keyPackages.get(ref))?.used).toBe(true);
    },
  );

  it("retires single-use private material only after successful persisted adoption and can still send", async () => {
    const admin = testAccount(6);
    const invitee = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(admin.pubkey),
      ciphersuiteImpl,
      signer: admin.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(invitee.pubkey),
      ciphersuiteImpl,
      signer: invitee.signer,
      isLastResort: false,
    });
    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Retirement",
      { adminPubkeys: [admin.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );
    await inviteeClient.keyPackages.add(inviteeKp);
    const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
    const welcomeRumor = createWelcomeRumor({
      welcome,
      author: admin.pubkey,
      groupRelays: ["wss://relay.test"],
      keyPackageEventId: "ab".repeat(32),
    });
    const { group } = await inviteeClient.joinGroupFromWelcome({
      welcomeRumor,
    });
    expect(await inviteeClient.keyPackages.getPrivateKey(ref)).toBeNull();
    expect((await inviteeClient.keyPackages.get(ref))?.used).toBe(true);
    expect(
      await inviteeStorage.get(GROUP_PREFIX + groupKeys.state(group.idStr)),
    ).toBeDefined();
    const { createApplicationMessage } = await import("ts-mls");
    await expect(
      createApplicationMessage({
        state: group.state,
        message: new TextEncoder().encode("after retirement"),
        context: {
          cipherSuite: ciphersuiteImpl,
          authService: marmotAuthService,
        },
      }),
    ).resolves.toBeDefined();
  });

  it.each(["receipt", "adoption"])(
    "preserves single-use private material when %s persistence fails",
    async (point) => {
      const admin = testAccount(6);
      const invitee = testAccount(9);
      const adminKp = await generateKeyPackage({
        credential: createCredential(admin.pubkey),
        ciphersuiteImpl,
        signer: admin.signer,
      });
      const inviteeKp = await generateKeyPackage({
        credential: createCredential(invitee.pubkey),
        ciphersuiteImpl,
        signer: invitee.signer,
        isLastResort: false,
      });
      const { clientState } = await createSimpleGroup(
        adminKp,
        ciphersuiteImpl,
        "Persistence",
        { adminPubkeys: [admin.pubkey] },
      );
      const welcome = await commitInviteeAdd(
        clientState,
        inviteeKp.publicPackage,
      );
      await inviteeClient.keyPackages.add(inviteeKp);
      const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
      const before = structuredClone(
        await inviteeClient.keyPackages.getPrivateKey(ref),
      );
      const save = stateWrites(inviteeStorage);
      if (point === "receipt")
        vi.spyOn(
          inviteeClient.keyPackages,
          "recordConsumption",
        ).mockRejectedValueOnce(new Error("receipt write failed"));
      else
        failNextStateWrite(inviteeStorage, new Error("adoption write failed"));
      const welcomeRumor = createWelcomeRumor({
        welcome,
        author: admin.pubkey,
        groupRelays: ["wss://relay.test"],
        keyPackageEventId: "ab".repeat(32),
      });
      await expect(
        inviteeClient.joinGroupFromWelcome({ welcomeRumor }),
      ).rejects.toThrow("write failed");
      expect(await storedGroupIds(inviteeStorage)).toEqual([]);
      expect(await inviteeClient.keyPackages.getPrivateKey(ref)).toEqual(
        before,
      );
      if (point === "receipt") expect(save).not.toHaveBeenCalled();
      else
        expect(
          (await inviteeClient.keyPackages.get(ref))?.consumptionReceipts,
        ).toHaveLength(1);
      save.mockRestore();
    },
  );

  it("joins a current-profile group", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Current",
      { adminPubkeys: [adminAccount.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    const { group } = await joinAsInvitee(welcome, inviteeKp);

    expect(
      classifyGroupAccountIdentityProofProfile(
        group.state.groupContext.extensions,
      ),
    ).toBe("current");
  });

  it.each([false, true])(
    "authorizes an inviter at leaf 1 only when admin=%s, preserving rejected bytes",
    async (isAdmin) => {
      const adminAccount = testAccount(6);
      const inviterAccount = testAccount(1);
      const adminKp = await generateKeyPackage({
        credential: createCredential(adminAccount.pubkey),
        ciphersuiteImpl,
        signer: adminAccount.signer,
      });
      const inviterKp = await generateKeyPackage({
        credential: createCredential(inviterAccount.pubkey),
        ciphersuiteImpl,
        signer: inviterAccount.signer,
      });
      const inviteeAccount = testAccount(9);
      const inviteeKp = await generateKeyPackage({
        credential: createCredential(inviteeAccount.pubkey),
        ciphersuiteImpl,
        signer: inviteeAccount.signer,
      });
      const { clientState } = await createSimpleGroup(
        adminKp,
        ciphersuiteImpl,
        "Nonadmin",
        {
          adminPubkeys: isAdmin
            ? [adminAccount.pubkey, inviterAccount.pubkey]
            : [adminAccount.pubkey],
        },
      );
      const inviterWelcome = await commitInviteeAdd(
        clientState,
        inviterKp.publicPackage,
      );
      const { joinGroup } = await import("ts-mls");
      const inviterState = await joinGroup({
        context: {
          cipherSuite: ciphersuiteImpl,
          authService: marmotAuthService,
        },
        welcome: inviterWelcome,
        keyPackage: inviterKp.publicPackage,
        privateKeys: inviterKp.privatePackage,
      });
      const welcome = await commitInviteeAdd(
        inviterState,
        inviteeKp.publicPackage,
      );
      await inviteeClient.keyPackages.add(inviteeKp);
      const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
      const before = structuredClone(await inviteeClient.keyPackages.get(ref));
      const { readWelcomeGroupInfo } =
        await import("../../core/welcome-join.js");
      const info = await readWelcomeGroupInfo({
        welcome,
        keyPackage: inviteeKp,
        ciphersuiteImpl,
      });
      expect(info.signer).toBe(1);
      expect(info.signature.length).toBeGreaterThan(0);
      if (isAdmin) {
        const { group } = await joinAsInvitee(welcome, inviteeKp);
        expect(group.state.privatePath.leafIndex).toBe(2);
      } else {
        await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toThrow(
          "active admin",
        );
        expect(await storedGroupIds(inviteeStorage)).toEqual([]);
      }
      expect(await inviteeClient.keyPackages.get(ref)).toEqual(before);
    },
  );

  it.each([
    "missing-admin",
    "orphan-admin",
    "bad-optional-state",
    "disbanded",
    "unsupported-required",
  ])(
    "rejects signed %s state before adoption, preserving key material",
    async (fault) => {
      const admin = testAccount(6);
      const invitee = testAccount(9);
      const adminKp = await generateKeyPackage({
        credential: createCredential(admin.pubkey),
        ciphersuiteImpl,
        signer: admin.signer,
      });
      const inviteeKp = await generateKeyPackage({
        credential: createCredential(invitee.pubkey),
        ciphersuiteImpl,
        signer: invitee.signer,
      });
      const components = [
        groupProfileEntry({ name: "Invalid", description: "" }),
      ];
      if (fault !== "missing-admin")
        components.push(
          adminPolicyEntry(
            fault === "orphan-admin"
              ? [admin.pubkey, testAccount(1).pubkey]
              : [admin.pubkey],
          ),
        );
      if (fault === "bad-optional-state")
        components.push(
          componentEntry(
            GROUP_MESSAGE_RETENTION_COMPONENT_ID,
            new Uint8Array([1]),
          ),
        );
      if (fault === "disbanded")
        components.push(groupLifecycleEntry("disbanded"));
      const { clientState } = await createGroup({
        creatorKeyPackage: adminKp,
        ciphersuiteImpl,
        components,
        ...(fault === "unsupported-required"
          ? { requiredComponentIds: [0x8123] }
          : {}),
      });
      const welcome = await commitInviteeAdd(
        clientState,
        inviteeKp.publicPackage,
      );
      await inviteeClient.keyPackages.add(inviteeKp);
      const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
      const before = structuredClone(await inviteeClient.keyPackages.get(ref));
      await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toThrow();
      expect(await storedGroupIds(inviteeStorage)).toEqual([]);
      expect(await inviteeClient.keyPackages.get(ref)).toEqual(before);
    },
  );

  it("rejects duplicate group adoption without changing retained state or keys", async () => {
    const admin = testAccount(6);
    const invitee = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(admin.pubkey),
      ciphersuiteImpl,
      signer: admin.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(invitee.pubkey),
      ciphersuiteImpl,
      signer: invitee.signer,
    });
    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Duplicate",
      { adminPubkeys: [admin.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );
    const { group } = await joinAsInvitee(welcome, inviteeKp);
    await inviteeClient.keyPackages.add(inviteeKp);
    const ref = await calculateKeyPackageRef(inviteeKp.publicPackage);
    const beforeKey = structuredClone(await inviteeClient.keyPackages.get(ref));
    const beforeGroup = structuredClone(
      await inviteeStorage.get(GROUP_PREFIX + groupKeys.state(group.idStr)),
    );
    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toThrow(
      "already exists",
    );
    expect(
      await inviteeStorage.get(GROUP_PREFIX + groupKeys.state(group.idStr)),
    ).toEqual(beforeGroup);
    expect(await inviteeClient.keyPackages.get(ref)).toEqual(beforeKey);
  });

  it("serializes concurrent duplicate adoption before recording cleanup intent", async () => {
    const admin = testAccount(6);
    const invitee = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(admin.pubkey),
      ciphersuiteImpl,
      signer: admin.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(invitee.pubkey),
      ciphersuiteImpl,
      signer: invitee.signer,
    });
    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Concurrent",
      { adminPubkeys: [admin.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );
    const keyPackageRef = await calculateKeyPackageRef(inviteeKp.publicPackage);
    const beforeAdopt = vi.fn(async () => {});
    const options = {
      welcome,
      ciphersuiteImpl,
      candidates: [{ ...inviteeKp, keyPackageRef, hasMatchingSecret: true }],
      beforeAdopt,
    };
    const results = await Promise.allSettled([
      inviteeClient.groups.joinFromWelcome(options),
      inviteeClient.groups.joinFromWelcome(options),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(beforeAdopt).toHaveBeenCalledTimes(1);
    expect(await storedGroupIds(inviteeStorage)).toHaveLength(1);
  });

  it("GRP-03: rejects a Welcome into a group that does not require 0x8009 without persisting it", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "No Requirement",
      { adminPubkeys: [adminAccount.pubkey] },
    );

    // ts-mls itself has no concept of a "required" component id and accepts
    // this AppDataUpdate generically; only the Marmot-layer join gate refuses
    // a group outside the current profile.
    const dropRequirement = await createCommit({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
      },
      state: clientState,
      wireAsPublicMessage: false,
      extraProposals: [dropAccountIdentityProofRequirement(clientState)],
      ratchetTreeExtension: true,
    });
    const droppedState = dropRequirement.newState;
    expect(
      classifyGroupAccountIdentityProofProfile(
        droppedState.groupContext.extensions,
      ),
    ).toBe("neither");

    const welcome = await commitInviteeAdd(
      droppedState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "missing-requirement",
    });
    expect(await storedGroupIds(inviteeStorage)).toEqual([]);
  });

  it("GRP-03: rejects a Welcome when a current non-creator member's proof is invalid without persisting it", async () => {
    const adminAccount = testAccount(6);
    const badMemberAccount = testAccount(1);
    const inviteeAccount = testAccount(9);
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Bad Member Proof",
      { adminPubkeys: [adminAccount.pubkey] },
    );

    const badKp = await forgeKeyPackage({
      account: badMemberAccount,
      ciphersuiteImpl,
      proof: "tampered",
    });
    const addBadMember = await createCommit({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
      },
      state: clientState,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: badKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const stateWithBadMember = addBadMember.newState;

    const welcome = await commitInviteeAdd(
      stateWithBadMember,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
    });
    expect(await storedGroupIds(inviteeStorage)).toEqual([]);
  });

  it("GRP-03: rejects a group that requires both 0xf2f1 and 0x8009 (mixed profile) without persisting it", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);

    // Both leaves must advertise the legacy 0xf2f1 extension too, so MLS's
    // own capability-negotiation check (independent of the account-identity-
    // proof profile check) passes when the group's required_capabilities
    // names it.
    const mixedCapabilities = {
      ...defaultCapabilities(),
      extensions: [
        ...defaultCapabilities().extensions,
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
      ],
    };

    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      capabilities: mixedCapabilities,
      ciphersuiteImpl,
      signer: adminAccount.signer,
    });
    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      capabilities: mixedCapabilities,
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
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
        groupProfileEntry({ name: "Mixed", description: "" }),
        adminPolicyEntry([adminAccount.pubkey]),
      ],
      extensions: [mixedRequiredCapabilities],
      ciphersuiteImpl,
    });
    // Sanity: the group we just built really is mixed-profile at the source.
    expect(
      classifyGroupAccountIdentityProofProfile(
        clientState.groupContext.extensions,
      ),
    ).toBe("mixed");

    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "mixed-profile",
    });
    expect(await storedGroupIds(inviteeStorage)).toEqual([]);
  });

  it("GRP-03: rejects a group whose creator leaf carries a proof bound to a different signature key", async () => {
    const adminAccount = testAccount(6);
    const inviteeAccount = testAccount(9);

    // A structurally valid leaf (MLS-legal), but its 0x8009 proof is signed
    // for a completely different, unrelated MLS signature key.
    const realSignatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const unrelatedSignatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const mismatchedProof = await produceAccountIdentityProof({
      signer: adminAccount.signer,
      accountIdentity: hexToBytes(adminAccount.pubkey),
      mlsSignatureKey: unrelatedSignatureKeyPair.publicKey,
      ciphersuite: ciphersuiteImpl.id,
    });
    const adminKp = await generateKeyPackageWithKey({
      credential: createCredential(adminAccount.pubkey),
      capabilities: defaultCapabilities(),
      lifetime: createDefaultKeyPackageLifetime(),
      signatureKeyPair: realSignatureKeyPair,
      cipherSuite: ciphersuiteImpl,
      leafNodeExtensions: [makeLeafAppComponentsExtension(mismatchedProof)],
    });

    const inviteeKp = await generateKeyPackage({
      credential: createCredential(inviteeAccount.pubkey),
      ciphersuiteImpl,
      signer: inviteeAccount.signer,
    });

    const { clientState } = await createSimpleGroup(
      adminKp,
      ciphersuiteImpl,
      "Bad Creator Proof",
      { adminPubkeys: [adminAccount.pubkey] },
    );
    const welcome = await commitInviteeAdd(
      clientState,
      inviteeKp.publicPackage,
    );

    await expect(joinAsInvitee(welcome, inviteeKp)).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "invalid-proof",
    });
    expect(await storedGroupIds(inviteeStorage)).toEqual([]);
  });
});
