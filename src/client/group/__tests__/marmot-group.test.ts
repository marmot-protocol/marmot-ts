import { EventSigner } from "applesauce-core/event-factory";
import {
  type ClientState,
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { getMarmotGroupData } from "../../../core/client-state.js";
import { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { replaceExtension } from "../../../core/extensions.js";
import { createSimpleGroup } from "../../../core/group.js";
import { encryptGroupImage } from "../../../core/group-image.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { marmotGroupDataToExtension } from "../../../core/marmot-group-data.js";
import { InMemoryKeyValueStore } from "../../../extra";
import type { NostrNetworkInterface } from "../../nostr-interface.js";
import {
  createAdminCommitPolicyCallback,
  MarmotGroup,
} from "../marmot-group.js";

async function createTestGroupState(
  adminPubkey: string,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const credential = createCredential(adminPubkey);
  const kp = await generateKeyPackage({ credential, ciphersuiteImpl });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuiteImpl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: [] },
  );
  return { clientState, kp };
}

function createUnusedNetwork(): NostrNetworkInterface {
  return {
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
}

function withGroupImage(
  state: ClientState,
  image: {
    imageHash: Uint8Array;
    imageKey: Uint8Array;
    imageNonce: Uint8Array;
    imageUploadKey: Uint8Array;
  },
): ClientState {
  const groupData = getMarmotGroupData(state);
  const extension = marmotGroupDataToExtension({
    ...groupData,
    ...image,
  });

  return {
    ...state,
    groupContext: {
      ...state.groupContext,
      extensions: replaceExtension(
        state.groupContext.extensions,
        extension,
      ) as any,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MarmotGroup group image helpers", () => {
  it("returns null when no group image metadata exists", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminPubkey, impl);

    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: {
        getPublicKey: async () => adminPubkey,
      } as EventSigner,
      ciphersuite: impl,
      network: createUnusedNetwork(),
    });

    expect(group.image).toBeNull();
  });

  it("downloads and decrypts the group image once per hash", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminPubkey, impl);
    const image = new Uint8Array([1, 2, 3, 4]);
    const encryptedImage = encryptGroupImage(image);
    const stateWithImage = withGroupImage(clientState, encryptedImage.metadata);

    const fetchMock = vi.fn(
      async () =>
        new Response(encryptedImage.encrypted, {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const group = new MarmotGroup(stateWithImage, {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: {
        getPublicKey: async () => adminPubkey,
      } as EventSigner,
      ciphersuite: impl,
      network: createUnusedNetwork(),
    });

    expect(group.image?.hasImage()).toBe(true);

    await expect(
      group.image?.download("https://example.com/group-image"),
    ).resolves.toEqual(image);
    await expect(
      group.image?.download("https://example.com/group-image"),
    ).resolves.toEqual(image);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates and reuses a group image object URL until the image changes", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminPubkey, impl);
    const firstImage = encryptGroupImage(new Uint8Array([1, 2, 3]));
    const secondImage = encryptGroupImage(new Uint8Array([4, 5, 6]));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("first")) {
        return new Response(firstImage.encrypted, {
          headers: { "content-type": "image/png; charset=utf-8" },
        });
      }

      return new Response(secondImage.encrypted, {
        headers: { "content-type": "image/jpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const createObjectURL = vi.fn(() => "blob:group-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );

    const group = new MarmotGroup(withGroupImage(clientState, firstImage.metadata), {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: {
        getPublicKey: async () => adminPubkey,
      } as EventSigner,
      ciphersuite: impl,
      network: createUnusedNetwork(),
    });

    const firstGroupImage = group.image;
    expect(firstGroupImage).not.toBeNull();
    if (!firstGroupImage) throw new Error("expected group image");

    await expect(
      firstGroupImage.getObjectUrl("https://example.com/first"),
    ).resolves.toBe("blob:group-image");
    await expect(
      firstGroupImage.getObjectUrl("https://example.com/first"),
    ).resolves.toBe("blob:group-image");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(0);

    group.state = withGroupImage(group.state, secondImage.metadata);

    const secondGroupImage = group.image;
    expect(secondGroupImage).not.toBeNull();
    expect(secondGroupImage).not.toBe(firstGroupImage);

    if (!secondGroupImage) throw new Error("expected group image");

    await secondGroupImage.getObjectUrl("https://example.com/second");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes the group image object URL when destroyed", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminPubkey, impl);
    const encryptedImage = encryptGroupImage(new Uint8Array([1, 2, 3]));

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(encryptedImage.encrypted, {
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:group-image");
        static revokeObjectURL = revokeObjectURL;
      },
    );

    const group = new MarmotGroup(withGroupImage(clientState, encryptedImage.metadata), {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: {
        getPublicKey: async () => adminPubkey,
      } as EventSigner,
      ciphersuite: impl,
      network: createUnusedNetwork(),
    });

    await group.image?.getObjectUrl("https://example.com/group-image");
    await group.destroy();

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("throws when the downloaded encrypted blob hash does not match group metadata", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminPubkey, impl);
    const encryptedImage = encryptGroupImage(new Uint8Array([1, 2, 3]));

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([9, 9, 9]), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const group = new MarmotGroup(withGroupImage(clientState, encryptedImage.metadata), {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: {
        getPublicKey: async () => adminPubkey,
      } as EventSigner,
      ciphersuite: impl,
      network: createUnusedNetwork(),
    });

    await expect(
      group.image?.download("https://example.com/group-image"),
    ).rejects.toThrow("group image hash mismatch");
  });
});

describe("MarmotGroup admin verification (MIP-03)", () => {
  it("rejects commits from non-admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "b".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: nonAdminKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // Non-admin joins from the Welcome
    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: (welcome as any).welcome ?? (welcome as any),
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Non-admin attempts to create a commit (should be rejected by admin verification)
    // Create a commit that includes proposals (not a self-update), which MUST remain
    // admin-only under MIP-03.
    const thirdPubkey = "c".repeat(64);
    const thirdCredential = createCredential(thirdPubkey);
    const thirdKeyPackage = await generateKeyPackage({
      credential: thirdCredential,
      ciphersuiteImpl: impl,
    });
    const nonAdminAddProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: thirdKeyPackage.publicPackage },
    };

    const { commit: nonAdminCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: nonAdminStateEpoch1,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [nonAdminAddProposal],
    });

    // Set up MarmotGroup with admin state
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(adminStateEpoch1.groupContext.groupId),
      adminStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
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

    const signer = {
      getPublicKey: async () => adminPubkey,
    } as EventSigner;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    // Use the same policy MarmotGroup.ingest() uses, but call ts-mls directly.
    // This keeps the test focused on the MIP-03 rule (admin-only commits), and
    // avoids unrelated NIP-44 decryption / retry behavior.
    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: nonAdminCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("reject");
    // Rejecting must not advance the group epoch.
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
  });

  it("accepts non-admin self-update commits (no proposals) (MIP-02)", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "b".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: nonAdminKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    // Non-admin joins from the Welcome
    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: welcome?.welcome!,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Non-admin creates a self-update commit (no proposals)
    const { commit: nonAdminSelfUpdateCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: nonAdminStateEpoch1,
      extraProposals: [],
      ratchetTreeExtension: true,
      wireAsPublicMessage: false,
    });

    // Set up MarmotGroup with admin state and verify the admin will ACCEPT this commit
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(adminStateEpoch1.groupContext.groupId),
      adminStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
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

    const signer = {
      getPublicKey: async () => adminPubkey,
    } as EventSigner;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: nonAdminSelfUpdateCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });

  it("accepts commits from admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const memberPubkey = "b".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Make this a 2-member group.
    // A 1-member group commit from "self" can fail inside ts-mls processing
    // ("Could not find common ancestor") because update paths are defined over
    // paths between distinct leaves.
    const memberCredential = createCredential(memberPubkey);
    const memberKeyPackage = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal as any],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // A receiver (non-admin member) joins from the Welcome and will ingest the admin's commit.
    // Processing your *own* commit against your own state is not a useful scenario here and
    // can fail inside ts-mls because the sender already advanced state locally.
    const memberStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: (welcome as any).welcome ?? (welcome as any),
      keyPackage: memberKeyPackage.publicPackage,
      privateKeys: memberKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Admin creates a commit (should be accepted)
    const { commit: adminCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
    });

    // Set up MarmotGroup with the receiver state
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(memberStateEpoch1.groupContext.groupId),
      memberStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
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

    const signer = {
      getPublicKey: async () => memberPubkey,
    } as EventSigner;

    const group = new MarmotGroup(memberStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    const initialEpoch = group.state.groupContext.epoch;

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      onUnverifiableCommit: "reject",
    });

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: adminCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });
});
