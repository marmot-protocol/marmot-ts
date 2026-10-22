import { marmotAuthService } from "../../../core/auth-service.js";
import { proposeSetEncryptedMediaPolicy } from "../proposals/update-metadata.js";
import { describe, it, expect } from "vitest";
import {
  defaultCryptoProvider,
  getCiphersuiteImpl,
  defaultProposalTypes,
  joinGroup,
} from "ts-mls";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { createSimpleGroup } from "../../../core/group.js";
import { createCredential } from "../../../core/credential.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { encryptedMediaBlossomDefault } from "../../../core/components/encrypted-media-v2.js";
import {
  StaleMediaPreparationError,
  encodeMediaImetaTag,
  mediaSourceStateToken,
} from "../../../core/media.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { GroupRegistry } from "../../group-registry.js";
import { MarmotGroup } from "../marmot-group.js";
import {
  prepareMediaMessage,
  downloadMessageMedia,
  type MediaBlobTransport,
} from "../media-transfer.js";

async function setup() {
  const account = testAccount(6);
  const ciphersuite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    ciphersuiteImpl: ciphersuite,
  });
  const { clientState } = await createSimpleGroup(kp, ciphersuite, "Media", {
    relays: ["wss://relay.test"],
    encryptedMedia: encryptedMediaBlossomDefault([
      "http://localhost:1234/blobs",
    ]),
  });
  const options = {
    store: new InMemoryKeyValueStore<Uint8Array>(),
    rewindStore: new InMemoryKeyValueStore<Uint8Array>(),
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    signer: account.signer,
    ciphersuite,
    network: new MockNetwork(),
    scheduler: { setTimer: () => 1, clearTimer() {} },
  };
  const group = new MarmotGroup(clientState, options);
  const blobs = new Map<string, Uint8Array>();
  const transport: MediaBlobTransport = {
    async upload({ data, ciphertextSha256 }) {
      const url = "http://localhost:1234/blobs/" + ciphertextSha256;
      blobs.set(url, data);
      return url;
    },
    async fetch({ url }) {
      const data = blobs.get(url);
      if (!data) throw new Error("Missing");
      return data;
    },
  };
  const advance = async () => {
    const effects = await group.session.send({ kind: "selfUpdate" });
    const work = effects.publish[0]!;
    if (work.kind !== "selfUpdate") throw new Error("Expected update");
    group.session.confirmPublished(work.pending);
  };
  return { group, transport, advance, blobs, options };
}
const files = [
  {
    blob: new Blob(["hello"], { type: "text/plain" }),
    metadata: { filename: "hello.txt" },
  },
];

describe("source-bound v2 transfer", () => {
  it("uploads, sends a real MLS message, and decrypts with delivery evidence", async () => {
    const { group, transport } = await setup();
    try {
      const prepared = await prepareMediaMessage(group, files, {
        transport,
        caption: "caption",
      });
      const effects = await group.session.send(prepared.intent);
      expect(effects.publish[0]?.kind).toBe("applicationMessage");
      expect(await group.session.mediaSourceForRumor(prepared.rumor.id)).toBe(
        prepared.intent.expectedParent,
      );
      const outcomes = await downloadMessageMedia(
        group,
        prepared.rumor.tags,
        prepared.intent.expectedParent,
        { transport },
      );
      expect(outcomes[0]).toMatchObject({
        status: "ready",
        data: new TextEncoder().encode("hello"),
      });
      expect(prepared.rumor.content).toBe("caption");
    } finally {
      group.dispose();
    }
  });
  it("rejects an epoch advance during upload", async () => {
    const { group, transport, advance } = await setup();
    try {
      await expect(
        prepareMediaMessage(group, files, {
          transport: {
            ...transport,
            async upload(request) {
              await advance();
              return transport.upload(request);
            },
          },
        }),
      ).rejects.toBeInstanceOf(StaleMediaPreparationError);
    } finally {
      group.dispose();
    }
  });
  it("rejects stale prepared sends and same-epoch fork replacement", async () => {
    const { group, transport } = await setup();
    try {
      const prepared = await prepareMediaMessage(group, files, { transport });
      group.state = {
        ...group.state,
        confirmationTag: new Uint8Array(32).fill(93),
      };
      expect(mediaSourceStateToken(group.state)).not.toBe(
        prepared.intent.expectedParent,
      );
      await expect(group.session.send(prepared.intent)).rejects.toBeInstanceOf(
        StaleMediaPreparationError,
      );
    } finally {
      group.dispose();
    }
  });
  it("keeps captions and valid siblings when one blob is corrupt", async () => {
    const { group, transport, blobs } = await setup();
    try {
      const prepared = await prepareMediaMessage(group, [...files, ...files], {
        transport,
        caption: "two files",
      });
      blobs.set(prepared.attachments[0].locators[0].value, new Uint8Array([1]));
      const outcomes = await downloadMessageMedia(
        group,
        prepared.rumor.tags,
        prepared.intent.expectedParent,
        { transport },
      );
      expect(outcomes.map((o) => o.status)).toEqual(["unavailable", "ready"]);
      expect(prepared.rumor.content).toBe("two files");
    } finally {
      group.dispose();
    }
  });
  it("resolves delayed media provenance and retained keys after a durable restart", async () => {
    const { group, transport, advance, options } = await setup();
    let restarted: MarmotGroup | undefined;
    try {
      const prepared = await prepareMediaMessage(group, files, { transport });
      await group.session.send(prepared.intent);
      await advance();
      await group.save(true);
      group.dispose();
      const registry = new GroupRegistry({
        ...options,
        lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
      });
      restarted = await registry.get(group.id);
      const source = await restarted.session.mediaSourceForRumor(
        prepared.rumor.id,
      );
      expect(source).toBe(prepared.intent.expectedParent);
      const outcomes = await downloadMessageMedia(
        restarted,
        prepared.rumor.tags,
        source!,
        { transport },
      );
      expect(outcomes[0]).toMatchObject({
        status: "ready",
        data: new TextEncoder().encode("hello"),
      });
    } finally {
      group.dispose();
      restarted?.dispose();
    }
  });
  it("removes policy and requirement atomically, then refuses new attachment sends", async () => {
    const { group, transport } = await setup();
    try {
      const effects = await group.session.send({
        kind: "commit",
        actorPubkey: await group.signer.getPublicKey(),
        extraProposals: [proposeSetEncryptedMediaPolicy(null)],
      });
      const work = effects.publish[0]!;
      if (work.kind !== "groupEvolution")
        throw new Error("Expected policy update");
      group.session.confirmPublished(work.pending);
      expect(group.groupData?.encryptedMedia).toBeUndefined();
      await expect(
        prepareMediaMessage(group, files, { transport }),
      ).rejects.toThrow(/not enabled/);
    } finally {
      group.dispose();
    }
  });

  it("retains an inbound delayed message's exact source through restart", async () => {
    const { group, transport, advance, options } = await setup();
    const member = testAccount(9);
    const kp = await generateKeyPackage({
      credential: createCredential(member.pubkey),
      signer: member.signer,
      ciphersuiteImpl: options.ciphersuite,
    });
    let peer: MarmotGroup | undefined, restarted: MarmotGroup | undefined;
    try {
      const effects = await group.session.send({
        kind: "commit",
        actorPubkey: await group.signer.getPublicKey(),
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: kp.publicPackage },
          },
        ],
      });
      const add = effects.publish[0]!;
      if (add.kind !== "groupEvolution" || !add.welcome)
        throw new Error("Expected Welcome");
      group.session.confirmPublished(add.pending);
      const joined = await joinGroup({
        context: {
          cipherSuite: options.ciphersuite,
          authService: marmotAuthService,
        },
        welcome: add.welcome.welcome,
        keyPackage: kp.publicPackage,
        privateKeys: kp.privatePackage,
      });
      peer = new MarmotGroup(joined, {
        ...options,
        store: new InMemoryKeyValueStore<Uint8Array>(),
        rewindStore: new InMemoryKeyValueStore<Uint8Array>(),
        ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
        signer: member.signer,
      });
      const prepared = await prepareMediaMessage(peer, files, {
        transport,
        caption: "delayed",
      });
      const sent = await peer.session.send(prepared.intent);
      const message = sent.publish[0]!;
      if (message.kind !== "applicationMessage")
        throw new Error("Expected attachment");
      await advance();
      for await (const result of group.ingest([message.envelope])) {
        if (result.kind === "processed")
          expect(result.sourceParent).toBe(prepared.intent.expectedParent);
      }
      await group.save(true);
      group.dispose();
      const registry = new GroupRegistry({
        ...options,
        lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
      });
      restarted = await registry.get(group.id);
      const source = await restarted.session.mediaSourceForRumor(
        prepared.rumor.id,
      );
      expect(source).toBe(prepared.intent.expectedParent);
      expect(
        (
          await downloadMessageMedia(restarted, prepared.rumor.tags, source!, {
            transport,
          })
        )[0].status,
      ).toBe("ready");
    } finally {
      group.dispose();
      peer?.dispose();
      restarted?.dispose();
    }
  });
  it("honors cancellation after upload before admitting the prepared send", async () => {
    const { group, transport } = await setup();
    const controller = new AbortController();
    try {
      const prepared = await prepareMediaMessage(group, files, {
        transport,
        signal: controller.signal,
      });
      controller.abort(new Error("cancelled by caller"));
      await expect(group.session.send(prepared.intent)).rejects.toThrow(
        /cancelled by caller/,
      );
    } finally {
      group.dispose();
    }
  });
  it("re-evaluates current group policy before retrying a failed fetch", async () => {
    const { group, transport } = await setup();
    let contacts = 0;
    try {
      const prepared = await prepareMediaMessage(group, files, { transport });
      // Force an explicit URL different from the fallback so a stale snapshot
      // would contact a second destination after removal.
      prepared.attachments[0].locators[0].value =
        "https://example.com/explicit";
      const outcomes = await downloadMessageMedia(
        group,
        prepared.attachments.map((attachment) =>
          encodeMediaImetaTag(attachment),
        ),
        prepared.intent.expectedParent,
        {
          transport: {
            ...transport,
            async fetch() {
              contacts++;
              const effects = await group.session.send({
                kind: "commit",
                actorPubkey: await group.signer.getPublicKey(),
                extraProposals: [proposeSetEncryptedMediaPolicy(null)],
              });
              const work = effects.publish[0]!;
              if (work.kind !== "groupEvolution")
                throw new Error("Expected policy removal");
              group.session.confirmPublished(work.pending);
              throw new Error("first fetch failed");
            },
          },
        },
      );
      expect(outcomes[0].status).toBe("unavailable");
      expect(contacts).toBe(1);
    } finally {
      group.dispose();
    }
  });
  it("times out an adapter that does not settle", async () => {
    const { group, transport } = await setup();
    try {
      await expect(
        prepareMediaMessage(group, files, {
          timeoutMs: 10,
          transport: { ...transport, upload: () => new Promise(() => {}) },
        }),
      ).rejects.toThrow();
    } finally {
      group.dispose();
    }
  });
});
