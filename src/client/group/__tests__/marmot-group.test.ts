import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  createCommit,
  createGroup as mlsCreateGroup,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  getAppDataDictionary,
  isDefaultExtension,
  joinGroup,
  makeAppDataDictionaryExtension,
  processMessage,
  unsafeTestingAuthenticationService,
  type Proposal,
  type Welcome,
  type GroupContextExtension,
  type LeafNodeExtension,
  type MlsMessage,
  type MlsFramedMessage,
  wireformats,
  protocolVersions,
  leafNodeSources,
  makeCustomExtension,
  type LeafNodeKeyPackage,
  type CustomExtension,
  type IncomingMessageCallback,
  type LeafIndex,
  type ProposalAdd,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../../../core/client-state.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  AccountIdentityProofError,
  buildAppDataDictionary,
  componentEntry,
  makeLeafAppComponentsExtension,
  produceAccountIdentityProof,
  validateKeyPackageAccountIdentityProof,
} from "../../../core/components/index.js";
import { createCredential } from "../../../core/credential.js";
import { defaultCapabilities } from "../../../core/default-capabilities.js";
import { createDefaultKeyPackageLifetime } from "../../../utils/timestamp.js";
import { createSimpleGroup } from "../../../core/group.js";
import {
  decodeComponentsList,
  encodeComponentsList,
} from "../../../core/components/app-components-list.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../../../core/components/ids.js";
import { encodeGroupProfileV1 } from "../../../core/components/group-profile.js";
import { createGroupEvent } from "../../../core/group-message.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../nostr-interface.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import {
  createAdminCommitPolicyCallback,
  MarmotGroup,
} from "../marmot-group.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import type {
  WelcomeDeliveryOutcome,
  WelcomeRecipient,
} from "../../transport/nostr/welcome-delivery.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../../core/components/ids.js";
import { GroupsManager } from "../../groups-manager.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { GroupImageTransportRequest } from "../group-image-transport.js";
import { NostrGroupPeeler } from "../nostr-peeler.js";
import { encodeGroupBlossomImage } from "../../../core/components/blossom-image.js";
import { encryptGroupImage } from "../../../core/group-image.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requireFramedMessage(message: MlsMessage): MlsFramedMessage {
  if (
    message.wireformat !== wireformats.mls_public_message &&
    message.wireformat !== wireformats.mls_private_message
  )
    throw new Error("expected a framed MLS message");
  return message;
}

type ProofPolicyCommit = Extract<
  Parameters<IncomingMessageCallback>[0],
  { kind: "commit" }
> & { proposals: { proposal: ProposalAdd; senderLeafIndex: number }[] };

function proofPolicyLeaf(
  pubkey: string,
  signaturePublicKey: Uint8Array,
  extensions: CustomExtension[],
): LeafNodeKeyPackage {
  return {
    credential: createCredential(pubkey),
    hpkePublicKey: new Uint8Array(32),
    signaturePublicKey,
    capabilities: defaultCapabilities(),
    leafNodeSource: leafNodeSources.key_package,
    lifetime: createDefaultKeyPackageLifetime(),
    signature: new Uint8Array(64),
    extensions,
  };
}

async function imageOwner(maxPendingImageMutations?: number) {
  const store = new InMemoryKeyValueStore<SerializedClientState>();
  const network = new MockNetwork();
  const manager = new GroupsManager({
    store,
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
    ingestPersistence: { kind: "durable" },
    network,
    signer: testAccount(6).signer,
    maxPendingImageMutations,
  });
  const group = await manager.create("Image teardown", {
    relays: network.relayUrls,
  });
  return { manager, group, store, network };
}

function uploadDescriptor(request: GroupImageTransportRequest) {
  const hash = bytesToHex(sha256(request.body!));
  return {
    status: 201,
    body: new TextEncoder().encode(
      JSON.stringify({
        sha256: hash,
        size: request.body!.length,
        type: "application/octet-stream",
        uploaded: 1,
        url: `https://images.test/${hash}`,
      }),
    ),
  };
}

async function createTestGroupState(
  account: ReturnType<typeof PrivateKeyAccount.fromKey>,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const adminPubkey = account.pubkey;
  const credential = createCredential(adminPubkey);
  const kp = await generateKeyPackage({
    credential,
    ciphersuiteImpl,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuiteImpl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );
  return { clientState, kp };
}

/**
 * The same group re-created with `app_data_dictionary` as the last
 * GroupContext extension, so an AppDataUpdate commit needs no extension-order
 * repair (which would add a GroupContextExtensions proposal and an UpdatePath
 * that a clone of the committing leaf cannot process).
 */
async function createDictionaryLastGroupState(
  account: PrivateKeyAccount<any>,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const { clientState, kp } = await createTestGroupState(
    account,
    ciphersuiteImpl,
  );
  const extensions = clientState.groupContext.extensions;
  return {
    clientState: await mlsCreateGroup({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: unsafeTestingAuthenticationService,
      },
      groupId: clientState.groupContext.groupId,
      keyPackage: kp.publicPackage,
      privateKeyPackage: kp.privatePackage,
      extensions: [
        ...extensions.filter(
          (e) => e.extensionType !== appDataDictionaryExtensionType,
        ),
        ...extensions.filter(
          (e) => e.extensionType === appDataDictionaryExtensionType,
        ),
      ],
    }),
  };
}

describe("MarmotGroup lifecycle (group-state.md)", () => {
  it("closing an image upload wipes its owned input copy", async () => {
    const { manager, group } = await imageOwner();
    const gate = deferred<void>();
    const bytes = Uint8Array.of(9, 8, 7);
    const copy = vi.spyOn(bytes, "slice");
    let entered = false;
    const operation = manager.replaceGroupImage(group.id, bytes, "image/png", {
      resolveEndpoints: async () => {
        entered = true;
        await gate.promise;
        return ["https://images.test"];
      },
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const owned = copy.mock.results[0]!.value as Uint8Array;
    group.image.close();
    expect(await operation).toEqual({ kind: "unavailable", reason: "closed" });
    gate.resolve();
    group.dispose();
    expect(owned.every((byte) => byte === 0)).toBe(true);
    expect(bytes).toEqual(Uint8Array.of(9, 8, 7));
  });
  it("a late old publication cannot release a newer same-ID mutation queue", async () => {
    const { manager, group, network } = await imageOwner(1);
    const oldAck = deferred<void>();
    const publish = network.publish.bind(network);
    const publisher = vi
      .spyOn(network, "publish")
      .mockImplementationOnce(async (...args) => {
        const response = await publish(...args);
        await oldAck.promise;
        return response;
      });
    const transport = async (request: GroupImageTransportRequest) =>
      uploadDescriptor(request);
    const old = manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      {
        endpoints: ["https://images.test"],
        transport,
      },
    );
    const rejected = expect(old).rejects.toThrow(/unloaded/);
    await vi.waitFor(() => expect(publisher).toHaveBeenCalledOnce());
    await manager.unload(group.id);
    const newer = await manager.get(group.id);
    const upload = deferred<void>();
    const nextTransport = vi.fn(async (request: GroupImageTransportRequest) => {
      await upload.promise;
      return uploadDescriptor(request);
    });
    const next = manager.replaceGroupImage(
      newer.id,
      Uint8Array.of(2),
      "image/png",
      {
        endpoints: ["https://images.test"],
        transport: nextTransport,
      },
    );
    await vi.waitFor(() => expect(nextTransport).toHaveBeenCalledOnce());
    oldAck.resolve();
    await rejected;
    expect(await manager.clearGroupImage(newer.id)).toEqual({
      kind: "unavailable",
      reason: "byte-limit",
    });
    expect(newer.image.source()).toEqual({ kind: "none" });
    upload.resolve();
    expect((await next).kind).toBe("published");
    expect(newer.image.source().kind).toBe("blossom");
    expect(group.image.closedSignal.aborted).toBe(true);
    expect(newer.image.closedSignal.aborted).toBe(false);
    await manager.unload(newer.id);
  });
  it.each(["unload", "destroy"] as const)(
    "%s refuses late actual confirmed Welcome success",
    async (mode) => {
      const { manager, group, store } = await imageOwner();
      const member = testAccount(9);
      const kp = await generateKeyPackage({
        credential: createCredential(member.pubkey),
        ciphersuiteImpl: group.ciphersuite,
        signer: member.signer,
      });
      const gate = deferred<void>();
      const deliver = vi
        .spyOn(group.runtime.welcomeDelivery, "deliverMany")
        .mockImplementationOnce(async () => {
          await gate.promise;
          return [];
        });
      const confirm = vi.spyOn(group.session, "confirmPublished");
      const operation = group.submitIntent({
        kind: "commit",
        actorPubkey: testAccount(6).pubkey,
        welcomeRecipients: [
          {
            pubkey: member.pubkey,
            keyPackageEventId: "kp",
            keyPackageEvent: {} as NostrEvent,
          },
        ],
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: kp.publicPackage },
          },
        ],
      });
      const rejected = expect(operation).rejects.toThrow(
        mode === "unload" ? /unloaded/ : /destroyed/,
      );
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(confirm).toHaveBeenCalledOnce();
      const parent = group.session.parentToken;
      await (mode === "unload"
        ? manager.unload(group.id)
        : manager.destroy(group.id));
      gate.resolve();
      await rejected;
      expect(group.session.parentToken).toBe(parent);
      expect(confirm).toHaveBeenCalledOnce();
      expect((await store.keys()).length).toBe(mode === "unload" ? 1 : 0);
      group.dispose();
    },
  );
  it.each(["builder", "crypto", "wrapper"] as const)(
    "destroy fences a late actual image %s preparation",
    async (stage) => {
      const { manager, group, store, network } = await imageOwner();
      const before = group.session.parentToken;
      const gate = deferred<void>();
      let entered = false;
      const proposal: Proposal = {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
          operation: "update" as const,
          update: encodeGroupBlossomImage({ kind: "empty" }),
        },
      };
      const signature = group.ciphersuite.signature;
      const sign = signature.sign.bind(signature);
      const wrap = NostrGroupPeeler.prototype.wrapGroupMessage;
      const spy =
        stage === "crypto"
          ? vi
              .spyOn(signature, "sign")
              .mockImplementationOnce(async (...args) => {
                const result = await sign(...args);
                entered = true;
                await gate.promise;
                return result;
              })
          : stage === "wrapper"
            ? vi
                .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
                .mockImplementationOnce(async function (
                  this: NostrGroupPeeler,
                  ...args
                ) {
                  const result = await wrap.call(this, ...args);
                  entered = true;
                  await gate.promise;
                  return result;
                })
            : undefined;
      try {
        const operation = group.submitIntent({
          kind: "commit",
          actorPubkey: testAccount(6).pubkey,
          expectedParent: before,
          extraProposals: [
            stage === "builder"
              ? async () => {
                  entered = true;
                  await gate.promise;
                  return proposal;
                }
              : proposal,
          ],
        });
        const rejected = expect(operation).rejects.toThrow(/destroyed/);
        await vi.waitFor(() => expect(entered).toBe(true));
        const destruction = manager.destroy(group.id);
        gate.resolve();
        await Promise.all([rejected, destruction]);
        expect(group.session.parentToken).toBe(before);
        expect(group.lifecycle).toBe("Stable");
        expect(network.events).toHaveLength(0);
        expect(await store.keys()).toEqual([]);
      } finally {
        gate.resolve();
        spy?.mockRestore();
        group.dispose();
      }
    },
  );

  it("a late old image read cannot affect a reloaded group with the same ID", async () => {
    const { manager, group, store } = await imageOwner();
    const image = encryptGroupImage(Uint8Array.of(8), "image/png");
    await manager.commit(group.id, {
      expectedParent: group.session.parentToken,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
            operation: "update",
            update: encodeGroupBlossomImage(image.metadata),
          },
        },
      ],
    });
    const response = deferred<void>();
    let calls = 0;
    const transport = vi.fn(async () => {
      if (++calls === 1) await response.promise;
      return { status: 200, body: image.ciphertext };
    });
    const profile = { endpoints: ["https://images.test"], transport };
    const old = group.image.read(profile);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await manager.unload(group.id);
    expect(await old).toEqual({ kind: "unavailable", reason: "closed" });
    const newer = await manager.get(group.id);
    expect(newer).not.toBe(group);
    const current = await newer.image.read(profile);
    expect(current).toMatchObject({
      kind: "available",
      bytes: Uint8Array.of(8),
    });
    response.resolve();
    await Promise.resolve();
    group.dispose();
    expect((await newer.image.read(profile)).kind).toBe("available");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await store.getItem(group.idStr)).toBeDefined();
    newer.dispose();
  });

  it.each(["publish", "save"] as const)(
    "destroy fences a late actual image %s and preserves the admitted-write barrier",
    async (stage) => {
      const { manager, group, store, network } = await imageOwner();
      const before = group.session.parentToken;
      const gate = deferred<void>();
      let entered = false;
      const saveItem = store.setItem.bind(store);
      const publish = network.publish.bind(network);
      const spy =
        stage === "publish"
          ? vi
              .spyOn(network, "publish")
              .mockImplementationOnce(async (...args) => {
                const response = await publish(...args);
                entered = true;
                await gate.promise;
                return response;
              })
          : vi
              .spyOn(store, "setItem")
              .mockImplementationOnce(
                async (...args: [string, SerializedClientState]) => {
                  entered = true;
                  await gate.promise;
                  return saveItem(...args);
                },
              );
      const confirm = vi.spyOn(group.session, "confirmPublished");
      const saved = vi.fn();
      group.on("stateSaved", saved);
      const transport = async (request: GroupImageTransportRequest) =>
        uploadDescriptor(request);
      const operation = manager.replaceGroupImage(
        group.id,
        Uint8Array.of(4),
        "image/png",
        { endpoints: ["https://images.test"], transport },
      );
      const rejected = expect(operation).rejects.toThrow(/destroyed/);
      await vi.waitFor(() => expect(entered).toBe(true));
      let destroyed = false;
      const destruction = manager.destroy(group.id).then(() => {
        destroyed = true;
      });
      await Promise.resolve();
      if (stage === "save") expect(destroyed).toBe(false);
      gate.resolve();
      await Promise.all([rejected, destruction]);
      expect(await store.keys()).toEqual([]);
      expect(saved).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(stage === "publish" ? 0 : 1);
      if (stage === "publish") expect(group.session.parentToken).toBe(before);
      spy.mockRestore();
      group.dispose();
    },
  );
  it("an unloaded session cannot save after deferred lifecycle hydration", async () => {
    const { group: initial, store } = await imageOwner();
    const impl = initial.ciphersuite;
    const state = initial.state;
    initial.dispose();
    const hydration = deferred<Uint8Array | null>();
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    vi.spyOn(lifecycleStore, "getItem").mockReturnValue(hydration.promise);
    const old = new MarmotGroup(state, {
      store,
      lifecycleStore,
      ciphersuite: impl,
      network: new MockNetwork(),
      signer: testAccount(6).signer,
    });
    const saved = vi.fn();
    old.on("stateSaved", saved);
    const writes = vi.spyOn(store, "setItem");
    const pending = old.save(true);
    old.dispose();
    hydration.resolve(null);
    await pending;
    const oldWrites = writes.mock.calls.length;
    const newer = new MarmotGroup(state, {
      store,
      ciphersuite: impl,
      network: new MockNetwork(),
      signer: testAccount(6).signer,
    });
    await newer.save(true);
    newer.dispose();
    expect(oldWrites).toBe(0);
    expect(saved).not.toHaveBeenCalled();
    expect(writes).toHaveBeenCalledOnce();
  });
  it.each(["resolver", "policy"] as const)(
    "explicit close refuses late upload %s completion",
    async (stage) => {
      const { manager, group, network } = await imageOwner();
      const gate = deferred<void>();
      let signal!: AbortSignal;
      const transport = vi.fn(async (request: GroupImageTransportRequest) =>
        uploadDescriptor(request),
      );
      const wait = async (_source: unknown, owned: AbortSignal) => {
        signal = owned;
        await gate.promise;
      };
      const operation = manager.replaceGroupImage(
        group.id,
        Uint8Array.of(1),
        "image/png",
        {
          endpoints: ["https://images.test"],
          transport,
          ...(stage === "resolver"
            ? {
                resolveEndpoints: async (source, owned) => {
                  await wait(source, owned);
                  return ["https://images.test"];
                },
              }
            : {
                contactPolicy: async (request, owned) => {
                  await wait(request, owned);
                  return true;
                },
              }),
        },
      );
      await vi.waitFor(() => expect(signal).toBeDefined());
      group.image.close();
      expect(await operation).toEqual({
        kind: "unavailable",
        reason: "closed",
      });
      expect(signal.aborted).toBe(true);
      gate.resolve();
      await Promise.resolve();
      expect(transport).not.toHaveBeenCalled();
      expect(network.events).toHaveLength(0);
      group.dispose();
    },
  );

  it.each(["before", "after"] as const)(
    "explicit close releases a blocked identity %s upload and queued work",
    async (stage) => {
      const { manager, group, network } = await imageOwner();
      const identity = deferred<string>();
      const signer = vi.spyOn(manager.signer, "getPublicKey");
      if (stage === "after")
        signer.mockResolvedValueOnce(testAccount(6).pubkey);
      signer.mockReturnValueOnce(identity.promise);
      const transport = vi.fn(async (request: GroupImageTransportRequest) =>
        uploadDescriptor(request),
      );
      const operation = manager.replaceGroupImage(
        group.id,
        Uint8Array.of(1),
        "image/png",
        {
          endpoints: ["https://images.test"],
          transport,
        },
      );
      const first = expect(operation).rejects.toThrow(
        /image mutation cancelled/,
      );
      const second = expect(manager.clearGroupImage(group.id)).rejects.toThrow(
        /image mutation cancelled/,
      );
      await vi.waitFor(() =>
        expect(signer).toHaveBeenCalledTimes(stage === "before" ? 1 : 2),
      );
      group.image.close();
      await Promise.all([first, second]);
      identity.resolve(testAccount(6).pubkey);
      await Promise.resolve();
      expect(network.events).toHaveLength(0);
      expect(transport).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      signer.mockRestore();
      group.dispose();
    },
  );
  it("explicit image close aborts an active upload and releases queued mutations", async () => {
    const { manager, group, network } = await imageOwner();
    const response = deferred<void>();
    let signal!: AbortSignal;
    const transport = vi.fn(async (request: GroupImageTransportRequest) => {
      signal = request.signal;
      await response.promise;
      return uploadDescriptor(request);
    });
    const operation = manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      {
        endpoints: ["https://images.test"],
        transport,
      },
    );
    const queued = manager
      .clearGroupImage(group.id)
      .catch((error) => String(error));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    group.image.close();
    group.image.close();
    const aborted = signal.aborted;
    const early = await Promise.race([
      operation.then((result) => result.kind),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 10),
      ),
    ]);
    response.resolve();
    await operation;
    await queued;
    group.dispose();
    expect(aborted).toBe(true);
    expect(early).toBe("unavailable");
    expect(network.events).toHaveLength(0);
  });

  it.each(["unload", "destroy"] as const)(
    "%s cancels a real upload response stream before storage teardown",
    async (mode) => {
      const { manager, group, store, network } = await imageOwner();
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(stream, { status: 201 }));
      try {
        const operation = manager.replaceGroupImage(
          group.id,
          Uint8Array.of(7),
          "image/png",
          {
            endpoints: ["https://images.test"],
          },
        );
        await vi.waitFor(() => expect(stream.locked).toBe(true));
        const teardown =
          mode === "destroy"
            ? manager.destroy(group.id)
            : manager.unload(group.id);
        expect(await operation).toEqual({
          kind: "unavailable",
          reason: "closed",
        });
        await teardown;
        expect(cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        expect(network.events).toHaveLength(0);
        expect((await store.getItem(group.idStr)) !== null).toBe(
          mode === "unload",
        );
      } finally {
        fetch.mockRestore();
        group.dispose();
      }
    },
  );
  it.each(["profile", "unload"] as const)(
    "rechecks %s after an asynchronous image proposal builder",
    async (change) => {
      const account = testAccount(6);
      const impl = await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      );
      const { clientState } = await createTestGroupState(account, impl);
      const network = new MockNetwork();
      const group = new MarmotGroup(clientState, {
        store: new InMemoryKeyValueStore(),
        signer: account.signer,
        ciphersuite: impl,
        network,
      });
      let release!: () => void;
      let entered = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const operation = group.session.send({
        kind: "commit",
        actorPubkey: account.pubkey,
        expectedParent: group.session.parentToken,
        extraProposals: [
          async () => {
            entered = true;
            await gate;
            return {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                operation: "update",
                update: new Uint8Array(5),
              },
            };
          },
        ],
      });
      const rejected = expect(operation).rejects.toThrow(
        change === "profile" ? /supported group profile/ : /unloaded/,
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      if (change === "profile")
        vi.spyOn(group.session, "profileSupport", "get").mockReturnValue({
          kind: "unsupported",
          proofReason: "missing-requirement",
        });
      else group.dispose();
      release();
      await rejected;
      expect(group.lifecycle).toBe("Stable");
      expect(network.events).toHaveLength(0);
      group.dispose();
    },
  );
  it("closes the image service immediately and idempotently on disposal", async () => {
    const account = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(account, impl);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer: account.signer,
      ciphersuite: impl,
      network: new MockNetwork(),
    });
    const close = vi.spyOn(group.image, "close");
    group.dispose();
    group.dispose();
    expect(close).toHaveBeenCalled();
    expect(
      await group.image.read({ endpoints: ["https://images.test"] }),
    ).toEqual({ kind: "unavailable", reason: "closed" });
  });
  it("preserves a queued image parent token until convergence releases actual preparation", async () => {
    const account = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(account, impl);
    const member = testAccount(9);
    const memberKp = await generateKeyPackage({
      credential: createCredential(member.pubkey),
      ciphersuiteImpl: impl,
      signer: member.signer,
    });
    const context = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const added = await createCommit({
      context,
      state: clientState,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
      ],
    });
    const memberState = await joinGroup({
      context,
      welcome: added.welcome!.welcome!,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });
    let nowMs = 0;
    let scheduled: (() => void) | undefined;
    const network = new MockNetwork(["wss://relay.test"]);
    const group = new MarmotGroup(added.newState, {
      store: new InMemoryKeyValueStore(),
      signer: account.signer,
      ciphersuite: impl,
      network,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      scheduler: {
        setTimer(_ms, callback) {
          scheduled = callback;
          return callback;
        },
        clearTimer(handle) {
          if (scheduled === handle) scheduled = undefined;
        },
      },
    });
    const advance = async () => {
      const effects = await group.session.send({
        kind: "commit",
        actorPubkey: account.pubkey,
      });
      const work = effects.publish[0];
      if (work.kind !== "groupEvolution") throw new Error("expected commit");
      group.session.confirmPublished(work.pending);
    };
    const incoming = await createCommit({
      context,
      state: memberState,
      wireAsPublicMessage: true,
    });
    const event = await createGroupEvent({
      message: incoming.commit,
      state: memberState,
      ciphersuite: impl,
    });
    for await (const _result of group.ingest([event])) {
      /* fully drain canonical transition */
    }
    expect(group.convergenceStatus).toBe("Syncing");
    const intent = {
      kind: "commit" as const,
      actorPubkey: account.pubkey,
      expectedParent: group.session.parentToken,
      extraProposals: [
        {
          proposalType:
            appDataUpdateProposalType as typeof appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
            operation: "update" as const,
            update: new Uint8Array(5),
          },
        },
      ],
    };
    const queued = group.submitIntent(intent);
    const rejected = expect(queued).rejects.toThrow("canonical parent changed");
    await advance();
    const before = serializeClientState(group.state);
    // Mutating the caller's object cannot rewrite already-admitted evidence.
    intent.expectedParent = group.session.parentToken;
    nowMs = 2_000;
    if (!scheduled) throw new Error("expected settlement timer");
    scheduled();
    await rejected;
    expect(serializeClientState(group.state)).toEqual(before);
    expect(group.lifecycle).toBe("Stable");
    expect(network.events).toHaveLength(0);
    group.dispose();
  });

  it("rejects retained lifecycle APIs and publish effects after destruction without network calls", async () => {
    const account = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(account, impl);
    const network = new MockNetwork(["wss://relay.test"]);
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      lifecycleStore,
      ciphersuite: impl,
      signer: account.signer,
      network,
    });
    const effects = await group.session.requestDisband();
    const work = effects.publish[0];
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    const epoch = group.state.groupContext.epoch;
    await group.destroy();
    const publish = vi.spyOn(network, "publish");
    await expect(group.disband()).rejects.toThrow("Group destroyed");
    await expect(group.enableDisbanding()).rejects.toThrow("Group destroyed");
    await group.resumePendingDisband();
    await expect(group.runtime.publishEffects(effects)).rejects.toThrow(
      "Group destroyed",
    );
    expect(() => group.session.confirmPublished(work.pending)).toThrow(
      "Group destroyed",
    );
    group.session.publishFailed(work.pending);
    expect(group.state.groupContext.epoch).toBe(epoch);
    expect(publish).not.toHaveBeenCalled();
    expect(await lifecycleStore.keys()).toEqual([]);
  });

  it("automatically regenerates disband after real convergence selects a deeper active branch", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createDictionaryLastGroupState(
      adminAccount,
      impl,
    );
    const cloneState = () =>
      deserializeClientState(serializeClientState(clientState));
    let nowMs = 100;
    let scheduled: (() => void) | undefined;
    const scheduler = {
      setTimer(_ms: number, callback: () => void) {
        scheduled = callback;
        return callback;
      },
      clearTimer(handle: unknown) {
        if (scheduled === handle) scheduled = undefined;
      },
    };
    const targetNetwork = new MockNetwork(["wss://relay.test"]);
    const target = new MarmotGroup(cloneState(), {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: targetNetwork,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      scheduler,
    });
    await expect(target.disband()).resolves.toMatchObject({
      kind: "acknowledged",
    });
    expect(target.lifecycle).toBe("Recovering");
    expect(targetNetwork.events).toHaveLength(1);

    const competitor = new MarmotGroup(cloneState(), {
      store: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: new MockNetwork(["wss://relay.test"]),
    });
    const activeCommit = (name: string) =>
      competitor.session.send({
        kind: "commit" as const,
        actorPubkey: admin,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_PROFILE_COMPONENT_ID,
              operation: "update" as const,
              update: encodeGroupProfileV1({ name, description: "" }),
            },
          },
        ],
      });
    const first = await activeCommit("Active one");
    const firstWork = first.publish[0];
    if (!firstWork || firstWork.kind !== "groupEvolution")
      throw new Error("expected first active commit");
    competitor.session.confirmPublished(firstWork.pending);
    const second = await activeCommit("Active two");
    const secondWork = second.publish[0];
    if (!secondWork || secondWork.kind !== "groupEvolution")
      throw new Error("expected second active commit");

    for await (const _ of target.ingest([
      firstWork.envelope,
      secondWork.envelope,
    ])) {
      // Drain the real competing-branch ingest path.
    }
    expect(Number(target.state.groupContext.epoch)).toBe(2);
    expect(target.lifecycle).toBe("Recovering");

    nowMs = 5_100;
    const cutoff = scheduled;
    if (!cutoff) throw new Error("expected convergence cutoff");
    cutoff();
    await vi.waitFor(() => expect(targetNetwork.events).toHaveLength(2));
    expect(target.lifecycle).toBe("Recovering");
    expect((await target.session.disbandRequest())?.lastPreparedEpoch).toBe(2);

    nowMs = 10_100;
    const terminalCutoff = scheduled;
    if (!terminalCutoff) throw new Error("expected regenerated cutoff");
    terminalCutoff();
    await vi.waitFor(() => expect(target.status).toBe("disbanded"));
    expect(targetNetwork.events).toHaveLength(2);
  });

  it("rejects public legacy enablement when any resulting leaf lacks lifecycle support", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const memberAccount = testAccount(11);
    const member = memberAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
    const memberPackage = await generateKeyPackage({
      credential: createCredential(member),
      ciphersuiteImpl: impl,
      signer: memberAccount.signer,
    });
    const { clientState } = await createSimpleGroup(
      adminPackage,
      impl,
      "Legacy",
      { adminPubkeys: [admin], relays: ["wss://relay.test"] },
    );
    const added = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: clientState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberPackage.publicPackage },
        },
      ],
    });
    const legacy = added.newState;
    function withoutLifecycle(
      extensions: GroupContextExtension[],
    ): GroupContextExtension[];
    function withoutLifecycle(
      extensions: LeafNodeExtension[],
    ): LeafNodeExtension[];
    function withoutLifecycle(
      extensions: (GroupContextExtension | LeafNodeExtension)[],
    ) {
      return extensions.map((extension) => {
        if (isDefaultExtension(extension)) return extension;
        const dictionary = getAppDataDictionary([extension]);
        if (!dictionary) return extension;
        const entries = dictionary
          .filter((entry) => entry.componentId !== GROUP_LIFECYCLE_COMPONENT_ID)
          .map((entry) =>
            entry.componentId === APP_COMPONENTS_COMPONENT_ID
              ? {
                  ...entry,
                  data: encodeComponentsList(
                    decodeComponentsList(entry.data).filter(
                      (id) => id !== GROUP_LIFECYCLE_COMPONENT_ID,
                    ),
                  ),
                }
              : entry,
          );
        return makeAppDataDictionaryExtension(entries);
      });
    }
    legacy.groupContext.extensions = withoutLifecycle(
      legacy.groupContext.extensions,
    );
    const memberLeaf = legacy.ratchetTree[2];
    if (!memberLeaf || !("leaf" in memberLeaf))
      throw new Error("member leaf missing");
    memberLeaf.leaf.extensions = withoutLifecycle(memberLeaf.leaf.extensions);

    const network = new MockNetwork(["wss://relay.test"]);
    const group = new MarmotGroup(legacy, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });
    await expect(group.enableDisbanding()).resolves.toMatchObject({
      kind: "rejected",
      reason: "unsupportedMembers",
    });
    expect(network.events).toEqual([]);
  });

  it("publishes disband intent once and keeps the durable request pending", async () => {
    const adminAccount = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const network = new MockNetwork(["wss://relay.test"]);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore,
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });

    const result = await group.disband();
    expect(result).toMatchObject({ kind: "acknowledged" });
    expect(network.events).toHaveLength(1);
    expect(
      await lifecycleStore.getItem(`${group.idStr}/disband/request`),
    ).not.toBeNull();

    const repeated = await group.disband();
    expect(repeated.kind).toBe("pending");
    expect(network.events).toHaveLength(1);
  });

  it("retains disband intent and rolls staged state back on publish failure", async () => {
    const adminAccount = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const network = new MockNetwork(["wss://relay.test"]);
    vi.spyOn(network, "publish").mockResolvedValue({
      "wss://relay.test": { from: "wss://relay.test", ok: false },
    });
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore,
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });

    const result = await group.disband();

    expect(result.kind).toBe("publishFailed");
    expect(group.lifecycle).toBe("Stable");
    expect(
      await lifecycleStore.getItem(`${group.idStr}/disband/request`),
    ).not.toBeNull();
  });

  it("reports lifecycle enablement idempotently through the public facade", async () => {
    const adminAccount = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: new MockNetwork(["wss://relay.test"]),
    });

    await expect(group.enableDisbanding()).resolves.toEqual({
      kind: "alreadyEnabled",
    });
  });

  it("starts Stable, returns to Stable after commit, and resets to Stable on publish failure", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://relay.test"],
    });

    let failPublish = true;
    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used");
      },
      subscription: () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
      publish: async () => ({
        "wss://relay.test": failPublish
          ? { from: "wss://relay.test", ok: false, message: "nope" }
          : { from: "wss://relay.test", ok: true },
      }),
    };
    const signer = adminAccount.signer;

    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer,
      ciphersuite: impl,
      network,
    });

    expect(group.lifecycle).toBe("Stable");
    expect(group.info.mls.groupIdHex).toBe(bytesToHex(group.id));
    expect(group.info.mls.epoch).toBe(clientState.groupContext.epoch);
    expect(group.info.mls.cipherSuite).toBe(
      clientState.groupContext.cipherSuite,
    );
    expect(group.info.app.view?.name).toBe("Test Group");
    expect(
      group.info.app.components.map((component) => component.name),
    ).toEqual([
      "app_components",
      "marmot.group.profile.v1",
      "marmot.group.admin-policy.v1",
      "marmot.transport.nostr.routing.v1",
      "marmot.group.encrypted-media.v2",
      "marmot.group.lifecycle.v1",
    ]);
    expect(group.info.nostr.groupIdHex).toHaveLength(64);
    expect(group.info.nostr.relays).toEqual(["wss://relay.test"]);
    expect(group.info.members.pubkeys).toEqual([adminPubkey]);

    // Publish fails (no ack) → PendingPublish is abandoned back to Stable.
    await expect(
      group.runtime.publishEffects(
        await group.session.send({
          kind: "commit",
          actorPubkey: adminPubkey,
          extraProposals: [],
        }),
      ),
    ).rejects.toThrow();
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(clientState.groupContext.epoch);

    // Publish succeeds → Merging → apply → Stable, epoch advanced.
    failPublish = false;
    await group.runtime.publishEffects(
      await group.session.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      }),
    );
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch + 1n,
    );
  });

  it("publishes session effects through the group runtime", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://relay.test"],
    });
    const network: NostrNetworkInterface = {
      request: async () => [],
      subscription: () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
      publish: async () => ({
        "wss://relay.test": { from: "wss://relay.test", ok: true },
      }),
    };
    const signer = adminAccount.signer;
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer,
      ciphersuite: impl,
      network,
    });

    const effects = await group.session.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    expect(effects.publish).toHaveLength(1);
    expect(effects.publish[0].kind).toBe("groupEvolution");

    const results = await group.runtime.publishEffects(effects);

    expect(results).toHaveLength(1);
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch + 1n,
    );
  });
});

describe("MarmotGroup admin verification (protocol-core/group-messaging.md)", () => {
  it("rejects commits from non-admin members", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const nonAdminAccount = testAccount(9);
    const nonAdminPubkey = nonAdminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
      signer: nonAdminAccount.signer,
    });

    const addProposal: Proposal = {
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
      welcome: welcome!.welcome,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Non-admin attempts to create a commit (should be rejected by admin verification)
    // Create a commit that includes proposals (not a self-update), which MUST remain
    // admin-only under `protocol-core/group-messaging.md` (Commit authorization).
    const thirdAccount = testAccount(11);
    const thirdPubkey = thirdAccount.pubkey;
    const thirdCredential = createCredential(thirdPubkey);
    const thirdKeyPackage = await generateKeyPackage({
      credential: thirdCredential,
      ciphersuiteImpl: impl,
      signer: thirdAccount.signer,
    });
    const nonAdminAddProposal: Proposal = {
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
      serializeClientState(adminStateEpoch1),
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

    const signer = adminAccount.signer;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    // Use the same policy MarmotGroup.ingest() uses, but call ts-mls directly.
    // This keeps the test focused on the `protocol-core/group-messaging.md` rule (admin-only commits), and
    // avoids unrelated NIP-44 decryption / retry behavior.
    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: requireFramedMessage(nonAdminCommit),
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("reject");
    // Rejecting must not advance the group epoch.
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
  });

  it("rejects a commit that adds a leaf with a forged account identity proof", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // A leaf whose 0x8009 account-identity-proof signature does not verify
    // for the credential identity it claims (one tampered signature byte).
    const account = testAccount(6);
    const mlsKey = new Uint8Array(32).fill(0xcd);
    const proof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: mlsKey,
      ciphersuite: impl.id,
      createdAt: 1700000000,
    });
    const tampered = proof.slice();
    tampered[tampered.length - 1] ^= 0xff; // forge

    const forgedLeaf = proofPolicyLeaf(account.pubkey, mlsKey, [
      makeLeafAppComponentsExtension(tampered),
    ]);
    const incoming: ProofPolicyCommit = {
      kind: "commit",
      senderLeafIndex: 0 as LeafIndex,
      proposals: [
        {
          proposal: {
            proposalType: defaultProposalTypes.add,
            add: {
              keyPackage: {
                version: protocolVersions.mls10,
                initKey: new Uint8Array(32),
                signature: new Uint8Array(64),
                cipherSuite: impl.id,
                leafNode: forgedLeaf,
                extensions: [],
              },
            },
          },
          senderLeafIndex: 0 as LeafIndex,
        },
      ],
    };

    // The committer is an admin (would otherwise be accepted); the forged proof
    // is rejected regardless, before the admin short-circuit.
    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [],
      adminPubkeys: [account.pubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    expect(callback(incoming)).toBe("reject");
  });

  it("rejects an Add whose proof material is only at the KeyPackage level, matching the invite seam (WR-01)", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const account = testAccount(6);
    const mlsKey = new Uint8Array(32).fill(0xcd);
    const proof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: mlsKey,
      ciphersuite: impl.id,
      createdAt: 1700000000,
    });

    // The leaf itself carries no proof material at all.
    const bareLeaf = proofPolicyLeaf(account.pubkey, mlsKey, []);
    const addCommit = (
      keyPackageExtensions: CustomExtension[],
    ): ProofPolicyCommit => ({
      kind: "commit" as const,
      senderLeafIndex: 0 as LeafIndex,
      proposals: [
        {
          proposal: {
            proposalType: defaultProposalTypes.add,
            add: {
              keyPackage: {
                version: protocolVersions.mls10,
                initKey: new Uint8Array(32),
                signature: new Uint8Array(64),
                cipherSuite: impl.id,
                leafNode: bareLeaf,
                extensions: keyPackageExtensions,
              },
            },
          },
          senderLeafIndex: 0 as LeafIndex,
        },
      ],
    });

    // With an empty ratchet tree the sender lookup after the proof gate is
    // unverifiable, and "retry" makes that path throw instead of returning. So a
    // returned "reject" can only come from the proof gate itself.
    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [],
      adminPubkeys: [account.pubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "retry",
    });

    // Legacy 0xf2f1 extension at the KeyPackage level.
    const legacyAtKeyPackage = addCommit([
      makeCustomExtension({
        extensionType: 0xf2f1,
        extensionData: new Uint8Array([1]),
      }),
    ]);
    expect(callback(legacyAtKeyPackage)).toBe("reject");

    // A 0x8009 dictionary entry misplaced at the KeyPackage level.
    const proofAtKeyPackage = addCommit([
      makeAppDataDictionaryExtension(
        buildAppDataDictionary([
          componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, proof),
        ]),
      ),
    ]);
    expect(callback(proofAtKeyPackage)).toBe("reject");

    // Both KeyPackages are rejected by the invite seam's validator too.
    for (const incoming of [legacyAtKeyPackage, proofAtKeyPackage]) {
      expect(() =>
        validateKeyPackageAccountIdentityProof(
          incoming.proposals[0]!.proposal.add.keyPackage,
          impl.id,
        ),
      ).toThrow(AccountIdentityProofError);
    }

    // Control: per D-08, an Add with no proof material anywhere is rejected by
    // the same validator that gates the invite seam, not skipped.
    expect(callback(addCommit([]))).toBe("reject");
  });

  it("accepts non-admin self-update commits (no proposals) (protocol-core/group-messaging.md)", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const nonAdminAccount = testAccount(9);
    const nonAdminPubkey = nonAdminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
      signer: nonAdminAccount.signer,
    });

    const addProposal: Proposal = {
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
      serializeClientState(adminStateEpoch1),
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

    const signer = adminAccount.signer;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: requireFramedMessage(nonAdminSelfUpdateCommit),
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });

  it("accepts commits from admin members", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const memberAccount = testAccount(9);
    const memberPubkey = memberAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
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
      signer: memberAccount.signer,
    });

    const addProposal: Proposal = {
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
      extraProposals: [addProposal],
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
      welcome: welcome!.welcome,
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
      serializeClientState(memberStateEpoch1),
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

    const signer = memberAccount.signer;

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
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: requireFramedMessage(adminCommit),
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });
});

describe("MarmotGroup founding Welcome delivery report (D-04/D-10/D-12/R-04, FOUND-04)", () => {
  // Minimal, real (never-thrown-away) `Welcome` object. `NostrWelcomeDelivery`
  // only encodes it into a rumor's content — it does not need to be
  // cryptographically joinable for these bookkeeping/retry assertions.
  const WELCOME: Welcome = {
    cipherSuite: 1,
    secrets: [],
    encryptedGroupInfo: new Uint8Array([1, 2, 3, 4]),
  };

  function makeRecipient(
    pubkey: string,
    keyPackageEventId: string,
  ): WelcomeRecipient {
    return {
      pubkey,
      keyPackageEventId,
      keyPackageEvent: {} as NostrEvent,
    };
  }

  async function makeGroup(network: NostrNetworkInterface) {
    const adminAccount = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });
    return { group, adminAccount };
  }

  async function makeFailedGroup(recipients: WelcomeRecipient[]) {
    const network = new MockNetwork(["wss://relay.test"]);
    const owner = await makeGroup(network);
    vi.spyOn(network, "getUserInboxRelays").mockResolvedValue([]);
    await owner.group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: owner.adminAccount.pubkey,
      recipients,
    });
    expect(owner.group.pendingWelcomes).toHaveLength(recipients.length);
    return owner;
  }

  function succeeded(recipient: WelcomeRecipient): WelcomeDeliveryOutcome {
    return {
      kind: "succeeded",
      recipient,
      response: {
        "wss://relay.test": { from: "wss://relay.test", ok: true },
      },
    };
  }

  function changedObligation(
    change: "Welcome" | "author" | "KeyPackage",
    author: string,
    recipient: WelcomeRecipient,
  ) {
    return {
      welcome:
        change === "Welcome"
          ? { ...WELCOME, encryptedGroupInfo: new Uint8Array([5, 6, 7, 8]) }
          : WELCOME,
      author: change === "author" ? testAccount(1).pubkey : author,
      recipients: [
        change === "KeyPackage"
          ? makeRecipient(recipient.pubkey, "b".repeat(64))
          : recipient,
      ],
    };
  }

  it("reports one entry per recipient and no pending entries when every delivery succeeds", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    const first = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const second = makeRecipient(testAccount(1).pubkey, "b".repeat(64));

    const outcomes = await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first, second],
    });

    expect(outcomes).toHaveLength(2);
    expect(group.welcomeDeliveries).toHaveLength(2);
    expect(group.pendingWelcomes).toEqual([]);
    expect(group.welcomeDeliveries.every((o) => o.kind === "succeeded")).toBe(
      true,
    );
  });

  it("pendingWelcomes contains exactly the failed recipient while welcomeDeliveries reports both", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    const first = makeRecipient(testAccount(2).pubkey, "c".repeat(64));
    const second = makeRecipient(testAccount(3).pubkey, "d".repeat(64));
    vi.spyOn(mockNetwork, "getUserInboxRelays").mockImplementation(
      async (pubkey) =>
        pubkey === second.pubkey ? [] : ["wss://mock-inbox.test"],
    );

    const outcomes = await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first, second],
    });

    expect(outcomes).toHaveLength(2);
    expect(group.welcomeDeliveries).toHaveLength(2);
    expect(group.pendingWelcomes).toHaveLength(1);
    expect(group.pendingWelcomes[0]!.recipient).toEqual(second);
  });

  it("retryWelcome re-delivers only the failed recipient and clears pendingWelcomes on success", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    const first = makeRecipient(testAccount(4).pubkey, "e".repeat(64));
    const second = makeRecipient(testAccount(5).pubkey, "f".repeat(64));
    const inboxSpy = vi
      .spyOn(mockNetwork, "getUserInboxRelays")
      .mockImplementation(async (pubkey) =>
        pubkey === second.pubkey ? [] : ["wss://mock-inbox.test"],
      );

    await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first, second],
    });
    expect(group.pendingWelcomes).toHaveLength(1);

    inboxSpy.mockImplementation(async () => ["wss://mock-inbox.test"]);
    const retried = await group.retryWelcome(second.pubkey);

    expect(retried.kind).toBe("succeeded");
    expect(group.pendingWelcomes).toEqual([]);
    expect(group.welcomeDeliveries).toHaveLength(2);
  });

  it("retryWelcome rejects for an unknown pubkey and returns the existing outcome without redelivering when already succeeded", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    const first = makeRecipient(testAccount(7).pubkey, "0".repeat(64));

    await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first],
    });

    await expect(group.retryWelcome(testAccount(8).pubkey)).rejects.toThrow(
      /no retained founding Welcome/,
    );

    const deliverManySpy = vi.spyOn(
      group.runtime.welcomeDelivery,
      "deliverMany",
    );
    const outcome = await group.retryWelcome(first.pubkey);

    expect(outcome.kind).toBe("succeeded");
    expect(deliverManySpy).not.toHaveBeenCalled();
  });

  it("same-recipient overlapping retries share one delivery and its succeeded outcome", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(network);
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    vi.spyOn(network, "getUserInboxRelays").mockResolvedValue([]);
    await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [recipient],
    });
    expect(group.pendingWelcomes).toHaveLength(1);

    const started = deferred<void>();
    const delivery = deferred<WelcomeDeliveryOutcome[]>();
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementation(() => {
        started.resolve();
        return delivery.promise;
      });
    const first = group.retryWelcome(recipient.pubkey);
    const second = group.retryWelcome(recipient.pubkey);
    await started.promise;
    expect(deliverMany).toHaveBeenCalledTimes(1);
    expect(deliverMany).toHaveBeenCalledWith({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      groupRelays: ["wss://relay.test"],
      recipients: [recipient],
    });
    const outcome: WelcomeDeliveryOutcome = {
      kind: "succeeded",
      recipient,
      response: {
        "wss://relay.test": { from: "wss://relay.test", ok: true },
      },
    };
    delivery.resolve([outcome]);

    expect(await Promise.all([first, second])).toEqual([outcome, outcome]);
    expect(group.welcomeDeliveries).toEqual([outcome]);
    expect(group.pendingWelcomes).toEqual([]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      outcome,
    );
    expect(deliverMany).toHaveBeenCalledTimes(1);
  });

  it("same-recipient retries share failure, clear it, and retain a later success", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group } = await makeFailedGroup([recipient]);
    const started = deferred<void>();
    const delivery = deferred<WelcomeDeliveryOutcome[]>();
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      });
    const first = group.retryWelcome(recipient.pubkey);
    const second = group.retryWelcome(recipient.pubkey);
    await started.promise;
    expect(deliverMany).toHaveBeenCalledTimes(1);
    const failure: WelcomeDeliveryOutcome = {
      kind: "failed",
      recipient,
      error: "No relay accepted the Welcome",
    };
    delivery.resolve([failure]);
    expect(await Promise.all([first, second])).toEqual([failure, failure]);
    expect(group.welcomeDeliveries).toEqual([failure]);
    expect(group.pendingWelcomes).toEqual([failure]);

    const success = succeeded(recipient);
    deliverMany.mockResolvedValueOnce([success]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
  });

  it("same-recipient retries clear an unexpectedly rejected delivery before a later attempt", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group } = await makeFailedGroup([recipient]);
    const retained = [...group.welcomeDeliveries];
    const started = deferred<void>();
    const release = deferred<void>();
    const failure = new Error("unexpected transport rejection");
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        throw failure;
      });
    const first = group.retryWelcome(recipient.pubkey);
    const second = group.retryWelcome(recipient.pubkey);
    const settled = Promise.allSettled([first, second]);
    await started.promise;
    expect(deliverMany).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(group.welcomeDeliveries).toEqual(retained);
    expect(group.pendingWelcomes).toEqual(retained);

    const success = succeeded(recipient);
    deliverMany.mockResolvedValueOnce([success]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
  });

  it("clears a synchronously thrown delivery so a later explicit retry can succeed", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group } = await makeFailedGroup([recipient]);
    const retained = [...group.welcomeDeliveries];
    const failure = new Error("synchronous transport failure");
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementationOnce(() => {
        throw failure;
      });
    await expect(group.retryWelcome(recipient.pubkey)).rejects.toBe(failure);
    expect(group.welcomeDeliveries).toEqual(retained);
    expect(group.pendingWelcomes).toEqual(retained);

    const success = succeeded(recipient);
    deliverMany.mockResolvedValueOnce([success]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
  });

  it("same-recipient synchronous transport reentry joins the installed attempt", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group } = await makeFailedGroup([recipient]);
    const started = deferred<void>();
    let reentered: Promise<WelcomeDeliveryOutcome> | undefined;
    const delivery = deferred<WelcomeDeliveryOutcome[]>();
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementationOnce(() => {
        reentered = group.retryWelcome(recipient.pubkey);
        started.resolve();
        return delivery.promise;
      });
    const first = group.retryWelcome(recipient.pubkey);
    await started.promise;
    expect(reentered).toBeDefined();
    expect(deliverMany).toHaveBeenCalledTimes(1);
    const success = succeeded(recipient);
    delivery.resolve([success]);
    expect(await Promise.all([first, reentered!])).toEqual([success, success]);
    expect(deliverMany).toHaveBeenCalledTimes(1);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
  });

  it("different recipients retry independently and a late failure cannot alter another success", async () => {
    const firstRecipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const secondRecipient = makeRecipient(
      testAccount(1).pubkey,
      "b".repeat(64),
    );
    const { group } = await makeFailedGroup([firstRecipient, secondRecipient]);
    const firstRetained = group.welcomeDeliveries[0]!;
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstDelivery = deferred<WelcomeDeliveryOutcome[]>();
    const secondDelivery = deferred<WelcomeDeliveryOutcome[]>();
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementation(({ recipients }) => {
        if (recipients[0]!.pubkey === firstRecipient.pubkey) {
          firstStarted.resolve();
          return firstDelivery.promise;
        }
        secondStarted.resolve();
        return secondDelivery.promise;
      });
    const first = group.retryWelcome(firstRecipient.pubkey);
    await firstStarted.promise;
    const second = group.retryWelcome(secondRecipient.pubkey);
    await secondStarted.promise;
    expect(deliverMany).toHaveBeenCalledTimes(2);
    expect(
      deliverMany.mock.calls.map(([options]) => options.recipients),
    ).toEqual([[firstRecipient], [secondRecipient]]);
    const secondSuccess = succeeded(secondRecipient);
    secondDelivery.resolve([secondSuccess]);
    await expect(second).resolves.toEqual(secondSuccess);
    expect(group.welcomeDeliveries).toEqual([firstRetained, secondSuccess]);
    expect(group.pendingWelcomes).toEqual([firstRetained]);
    await expect(group.retryWelcome(secondRecipient.pubkey)).resolves.toEqual(
      secondSuccess,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);

    const firstFailure: WelcomeDeliveryOutcome = {
      kind: "failed",
      recipient: firstRecipient,
      error: "first recipient unreachable",
    };
    firstDelivery.resolve([firstFailure]);
    await expect(first).resolves.toEqual(firstFailure);
    expect(group.welcomeDeliveries).toEqual([firstFailure, secondSuccess]);
    expect(group.pendingWelcomes).toEqual([firstFailure]);
  });

  it("a late failed retry preserves and returns an already retained recipient success", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group, adminAccount } = await makeFailedGroup([recipient]);
    const started = deferred<void>();
    const delivery = deferred<WelcomeDeliveryOutcome[]>();
    const success = succeeded(recipient);
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      })
      .mockResolvedValueOnce([success]);
    const retry = group.retryWelcome(recipient.pubkey);
    await started.promise;
    // An independently completed public delivery retains success while the
    // older retry is still blocked. Its later failure must not downgrade it.
    await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [recipient],
    });
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);

    delivery.resolve([{ kind: "failed", recipient, error: "late failure" }]);
    await expect(retry).resolves.toEqual(success);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
  });

  it("a late failed fanout preserves and returns an already retained retry success", async () => {
    const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const { group, adminAccount } = await makeFailedGroup([recipient]);
    const delivery = deferred<WelcomeDeliveryOutcome[]>();
    const success = succeeded(recipient);
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockReturnValueOnce(delivery.promise)
      .mockResolvedValueOnce([success]);
    const fanout = group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [recipient],
    });
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);

    delivery.resolve([
      { kind: "failed", recipient, error: "late fanout failure" },
    ]);
    await expect(fanout).resolves.toEqual([success]);
    expect(group.welcomeDeliveries).toEqual([success]);
    expect(group.pendingWelcomes).toEqual([]);
    await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
      success,
    );
    expect(deliverMany).toHaveBeenCalledTimes(2);
  });

  it("same encoded Welcome fanout preserves success and the supplied recipient order", async () => {
    const first = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
    const second = makeRecipient(testAccount(1).pubkey, "b".repeat(64));
    const { group, adminAccount } = await makeFailedGroup([first, second]);
    const success = succeeded(first);
    const secondFailure: WelcomeDeliveryOutcome = {
      kind: "failed",
      recipient: second,
      error: "second unreachable",
    };
    const deliverMany = vi
      .spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockResolvedValueOnce([success])
      .mockResolvedValueOnce([
        secondFailure,
        { kind: "failed", recipient: first, error: "first late failure" },
      ]);
    await group.retryWelcome(first.pubkey);

    await expect(
      group.deliverFoundingWelcomes({
        welcome: {
          ...WELCOME,
          encryptedGroupInfo: WELCOME.encryptedGroupInfo.slice(),
        },
        author: adminAccount.pubkey,
        recipients: [second, { ...first }],
      }),
    ).resolves.toEqual([secondFailure, success]);
    expect(group.welcomeDeliveries).toEqual([secondFailure, success]);
    expect(group.pendingWelcomes).toEqual([secondFailure]);
    await expect(group.retryWelcome(first.pubkey)).resolves.toEqual(success);
    expect(deliverMany).toHaveBeenCalledTimes(2);
  });

  it.each(["Welcome", "author", "KeyPackage"] as const)(
    "a changed %s obligation does not inherit a completed recipient success",
    async (change) => {
      const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
      const { group, adminAccount } = await makeFailedGroup([recipient]);
      const replacement = changedObligation(
        change,
        adminAccount.pubkey,
        recipient,
      );
      const replacementRecipient = replacement.recipients[0]!;
      const failure: WelcomeDeliveryOutcome = {
        kind: "failed",
        recipient: replacementRecipient,
        error: "new obligation failed",
      };
      const success = succeeded(replacementRecipient);
      const deliverMany = vi
        .spyOn(group.runtime.welcomeDelivery, "deliverMany")
        .mockResolvedValueOnce([succeeded(recipient)])
        .mockResolvedValueOnce([failure])
        .mockResolvedValueOnce([success]);
      await group.retryWelcome(recipient.pubkey);
      await expect(group.deliverFoundingWelcomes(replacement)).resolves.toEqual(
        [failure],
      );
      expect(group.welcomeDeliveries).toEqual([failure]);
      expect(group.pendingWelcomes).toEqual([failure]);
      await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
        success,
      );
      expect(deliverMany).toHaveBeenCalledTimes(3);
      expect(deliverMany).toHaveBeenLastCalledWith({
        ...replacement,
        groupRelays: group.relays,
      });
    },
  );

  it.each(["Welcome", "author", "KeyPackage"] as const)(
    "a changed %s obligation starts its own retry while an older retry is pending",
    async (change) => {
      const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
      const { group, adminAccount } = await makeFailedGroup([recipient]);
      const replacement = changedObligation(
        change,
        adminAccount.pubkey,
        recipient,
      );
      const replacementRecipient = replacement.recipients[0]!;
      const failure: WelcomeDeliveryOutcome = {
        kind: "failed",
        recipient: replacementRecipient,
        error: "new obligation failed",
      };
      const oldStarted = deferred<void>();
      const newStarted = deferred<void>();
      const oldDelivery = deferred<WelcomeDeliveryOutcome[]>();
      const newDelivery = deferred<WelcomeDeliveryOutcome[]>();
      const deliverMany = vi
        .spyOn(group.runtime.welcomeDelivery, "deliverMany")
        .mockImplementationOnce(() => {
          oldStarted.resolve();
          return oldDelivery.promise;
        })
        .mockResolvedValueOnce([failure])
        .mockImplementationOnce(() => {
          newStarted.resolve();
          return newDelivery.promise;
        });
      const oldRetry = group.retryWelcome(recipient.pubkey);
      await oldStarted.promise;
      await group.deliverFoundingWelcomes(replacement);
      const newRetry = group.retryWelcome(recipient.pubkey);
      // Flush the deferred retry transport start without a timeout or a wait
      // on a barrier that the broken pubkey-only implementation cannot reach.
      await Promise.resolve();
      expect(deliverMany).toHaveBeenCalledTimes(3);
      await newStarted.promise;
      expect(deliverMany).toHaveBeenLastCalledWith({
        ...replacement,
        groupRelays: group.relays,
      });

      const oldSuccess = succeeded(recipient);
      oldDelivery.resolve([oldSuccess]);
      await expect(oldRetry).resolves.toEqual(oldSuccess);
      expect(group.welcomeDeliveries).toEqual([failure]);
      expect(group.pendingWelcomes).toEqual([failure]);
      const joinedNewRetry = group.retryWelcome(recipient.pubkey);
      await Promise.resolve();
      expect(deliverMany).toHaveBeenCalledTimes(3);
      const success = succeeded(replacementRecipient);
      newDelivery.resolve([success]);
      expect(await Promise.all([newRetry, joinedNewRetry])).toEqual([
        success,
        success,
      ]);
      expect(group.welcomeDeliveries).toEqual([success]);
      expect(group.pendingWelcomes).toEqual([]);
      await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
        success,
      );
      expect(deliverMany).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["Welcome", "author", "KeyPackage"] as const)(
    "a late older fanout cannot overwrite a changed %s obligation or inherit its success",
    async (change) => {
      const recipient = makeRecipient(testAccount(0).pubkey, "a".repeat(64));
      const { group, adminAccount } = await makeFailedGroup([recipient]);
      const replacement = changedObligation(
        change,
        adminAccount.pubkey,
        recipient,
      );
      const success = succeeded(replacement.recipients[0]!);
      const oldDelivery = deferred<WelcomeDeliveryOutcome[]>();
      const deliverMany = vi
        .spyOn(group.runtime.welcomeDelivery, "deliverMany")
        .mockReturnValueOnce(oldDelivery.promise)
        .mockResolvedValueOnce([success]);
      const oldFanout = group.deliverFoundingWelcomes({
        welcome: WELCOME,
        author: adminAccount.pubkey,
        recipients: [recipient],
      });
      await group.deliverFoundingWelcomes(replacement);
      const oldFailure: WelcomeDeliveryOutcome = {
        kind: "failed",
        recipient,
        error: "old obligation failed",
      };
      oldDelivery.resolve([oldFailure]);
      await expect(oldFanout).resolves.toEqual([oldFailure]);
      expect(group.welcomeDeliveries).toEqual([success]);
      expect(group.pendingWelcomes).toEqual([]);
      await expect(group.retryWelcome(recipient.pubkey)).resolves.toEqual(
        success,
      );
      expect(deliverMany).toHaveBeenCalledTimes(2);
    },
  );

  it("a fanout whose deliveries all fail does not throw (D-12)", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    vi.spyOn(mockNetwork, "getUserInboxRelays").mockResolvedValue([]);
    const first = makeRecipient(testAccount(10).pubkey, "1".repeat(64));
    const second = makeRecipient(testAccount(12).pubkey, "2".repeat(64));

    const outcomes = await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first, second],
    });

    expect(outcomes.every((o) => o.kind === "failed")).toBe(true);
    expect(group.pendingWelcomes).toHaveLength(2);
  });

  it("CR-02: an unacknowledged Welcome publish is reported in pendingWelcomes and retryWelcome re-attempts it until a relay acknowledges", async () => {
    const mockNetwork = new MockNetwork(["wss://relay.test"]);
    const { group, adminAccount } = await makeGroup(mockNetwork);
    const first = makeRecipient(testAccount(13).pubkey, "3".repeat(64));
    const second = makeRecipient(testAccount(14).pubkey, "4".repeat(64));

    const originalPublish = mockNetwork.publish.bind(mockNetwork);
    const publishSpy = vi
      .spyOn(mockNetwork, "publish")
      .mockImplementation(async (relays, event) => {
        const recipientOfEvent = event.tags.find((tag) => tag[0] === "p")?.[1];
        if (event.kind === 1059 && recipientOfEvent === second.pubkey) {
          const result: Record<string, PublishResponse> = {};
          for (const relay of relays)
            result[relay] = { from: relay, ok: false, message: "blocked" };
          return result;
        }
        return originalPublish(relays, event);
      });

    const secondGiftWrapCalls = () =>
      publishSpy.mock.calls.filter(
        ([, event]) =>
          event.kind === 1059 &&
          event.tags.find((tag) => tag[0] === "p")?.[1] === second.pubkey,
      ).length;

    const outcomes = await group.deliverFoundingWelcomes({
      welcome: WELCOME,
      author: adminAccount.pubkey,
      recipients: [first, second],
    });

    expect(outcomes).toHaveLength(2);
    expect(group.pendingWelcomes).toHaveLength(1);
    expect(group.pendingWelcomes[0]!.recipient).toEqual(second);
    expect(group.pendingWelcomes[0]!.kind).toBe("failed");
    if (group.pendingWelcomes[0]!.kind !== "failed")
      throw new Error("expected pending entry to be failed");
    expect(group.pendingWelcomes[0]!.error).toMatch(
      /No relay accepted the Welcome/,
    );
    const firstOutcome = outcomes.find(
      (outcome) => outcome.recipient === first,
    );
    expect(firstOutcome?.kind).toBe("succeeded");

    const callsBeforeRetry = secondGiftWrapCalls();
    const retried = await group.retryWelcome(second.pubkey);
    expect(retried.kind).toBe("failed");
    expect(group.pendingWelcomes).toHaveLength(1);
    expect(secondGiftWrapCalls()).toBe(callsBeforeRetry + 1);

    publishSpy.mockRestore();
    const retriedAgain = await group.retryWelcome(second.pubkey);
    expect(retriedAgain.kind).toBe("succeeded");
    expect(group.pendingWelcomes).toEqual([]);
    expect(group.welcomeDeliveries).toHaveLength(2);
  });
});
