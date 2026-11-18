import {
  finalizeEvent,
  generateSecretKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";

import { BoundedIdCache, GroupsManager } from "../client/groups-manager.js";
import { MarmotGroup } from "../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import { fakeVerifyEvent, type VerifyEventMethod } from "../client/verify.js";
import { memoryStorage } from "../utils/storage.js";
import { groupKeys } from "../client/storage/storage-keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { GroupImageTransportRequest } from "../client/group/group-image-transport.js";
import { proposeUpdateMetadata } from "../client/group/proposals/update-metadata.js";
import { encryptGroupImage } from "../core/group-image.js";
import { encodeGroupBlossomImage } from "../core/components/blossom-image.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../core/components/ids.js";
import {
  appDataUpdateProposalType,
  defaultProposalTypes,
  createCommit,
  joinGroup,
} from "ts-mls";
import { NostrGroupPeeler } from "../client/group/nostr-peeler.js";
import { marmotAuthService } from "../core/auth-service.js";
import { createGroupEvent } from "../core/group-message.js";
import type { AuditSink, AuditContextOptions } from "../audit/types.js";
import { generateKeyPackage } from "../core/key-package.js";
import { createCredential } from "../core/credential.js";
import { MockNetwork } from "./helpers/mock-network.js";
import { testAccount } from "./helpers/test-accounts.js";
import {
  disbandTombstoneKey,
  encodeDisbandTombstone,
} from "../engine/disband-tombstone.js";

// A real signer is required (not a getPublicKey-only stub): D-01 has every
// client-built leaf/KeyPackage proven with the client's identity signer, so
// `GroupsManager.create()` now always calls `signer.signEvent` for the
// creator's account identity proof.
const ADMIN_ACCOUNT = testAccount(0);
const ADMIN = ADMIN_ACCOUNT.pubkey;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function imageManager(
  options: {
    maxPendingImageMutations?: number;
    audit?: AuditSink;
    auditContext?: AuditContextOptions;
  } = {},
) {
  const manager = new GroupsManager({
    storage: memoryStorage(),
    signer: ADMIN_ACCOUNT.signer,
    network: new MockNetwork(),
    ...options,
  });
  const group = await manager.create("Image queue", {
    relays: ["wss://relay.test"],
  });
  return { manager, group };
}

describe("group image mutation queue", () => {
  it("copies waiting image bytes and executes replace and clear in FIFO order", async () => {
    const { manager, group } = await imageManager();
    const gate = deferred<never[]>();
    const submit = vi
      .spyOn(group, "submitIntent")
      .mockReturnValueOnce(gate.promise);
    let ciphertext = new Uint8Array();
    const transport = vi.fn(async (request: GroupImageTransportRequest) => {
      if (request.method === "GET") return { status: 200, body: ciphertext };
      ciphertext = request.body!.slice();
      const hash = bytesToHex(sha256(ciphertext));
      return {
        status: 201,
        body: new TextEncoder().encode(
          JSON.stringify({
            sha256: hash,
            size: ciphertext.length,
            type: "application/octet-stream",
            uploaded: 1,
            url: `https://images.test/${hash}`,
          }),
        ),
      };
    });
    const profile = { endpoints: ["https://images.test"], transport };
    const first = manager.clearGroupImage(group.id);
    const bytes = Uint8Array.of(1, 2, 3);
    const replacement = manager.replaceGroupImage(
      group.id,
      bytes,
      "image/png",
      profile,
    );
    bytes.fill(9);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(transport).not.toHaveBeenCalled();
    gate.resolve([]);
    await Promise.all([first, replacement]);
    const read = await group.image.read(profile);
    expect(read.kind).toBe("available");
    if (read.kind === "available")
      expect(read.bytes).toEqual(Uint8Array.of(1, 2, 3));
    const clear = manager.clearGroupImage(group.id);
    const second = manager.replaceGroupImage(
      group.id,
      Uint8Array.of(4),
      "image/png",
      profile,
    );
    await Promise.all([clear, second]);
    expect(group.image.source().kind).toBe("blossom");
    manager.unload(group.id);
  });

  it("allows an independent group and a fresh loaded instance to proceed at capacity", async () => {
    const { manager, group } = await imageManager({
      maxPendingImageMutations: 1,
    });
    const gate = deferred<never[]>();
    vi.spyOn(group, "submitIntent").mockReturnValue(gate.promise);
    const first = manager.clearGroupImage(group.id);
    await vi.waitFor(() => expect(group.submitIntent).toHaveBeenCalledTimes(1));
    expect(await manager.clearGroupImage(group.id)).toEqual({
      kind: "unavailable",
      reason: "byte-limit",
    });
    const other = await manager.create("Independent", {
      relays: ["wss://relay.test"],
    });
    expect((await manager.clearGroupImage(other.id)).kind).toBe("published");
    manager.unload(group.id);
    const reloaded = await manager.get(group.id);
    expect((await manager.clearGroupImage(reloaded.id)).kind).toBe("published");
    gate.resolve([]);
    await first.catch(() => undefined);
    manager.unload(group.id);
    manager.unload(other.id);
  });
  it("bounds admitted mutations at sixteen before retaining another operation", async () => {
    const { manager, group } = await imageManager();
    const gate = deferred<never[]>();
    const submit = vi
      .spyOn(group, "submitIntent")
      .mockReturnValue(gate.promise);
    const queued = Array.from({ length: 16 }, () =>
      manager.clearGroupImage(group.id),
    );
    let refused: unknown;
    const extra = manager.clearGroupImage(group.id).then((result) => {
      refused = result;
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    gate.resolve([]);
    await Promise.all([...queued, extra]);
    expect(JSON.stringify(refused)).toBe(
      JSON.stringify({ kind: "unavailable", reason: "byte-limit" }),
    );
    expect(submit).toHaveBeenCalledTimes(16);
    manager.unload(group.id);
  });

  it("refuses old queued work after unloading instead of applying it to a new instance", async () => {
    const { manager, group } = await imageManager();
    const gate = deferred<never[]>();
    vi.spyOn(group, "submitIntent").mockReturnValueOnce(gate.promise);
    const first = manager.clearGroupImage(group.id);
    const second = manager.clearGroupImage(group.id);
    const rejected = expect(second).rejects.toThrow(
      /unloaded|closed|destroyed/i,
    );
    await vi.waitFor(() => expect(group.submitIntent).toHaveBeenCalledTimes(1));
    manager.unload(group.id);
    const reloaded = await manager.get(group.id);
    const submit = vi.spyOn(reloaded, "submitIntent").mockResolvedValue([]);
    gate.resolve([]);
    await first.catch(() => undefined);
    await rejected;
    expect(submit).not.toHaveBeenCalled();
    manager.unload(group.id);
  });

  it.each([0, -1, Infinity, NaN, 1.5])(
    "rejects invalid queue capacity %s",
    (capacity) => {
      expect(
        () =>
          new GroupsManager({
            storage: memoryStorage(),
            signer: ADMIN_ACCOUNT.signer,
            network: new MockNetwork(),
            maxPendingImageMutations: capacity,
          }),
      ).toThrow(/positive|integer|finite/i);
    },
  );
});

function deferredImageUpload() {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  const transport = vi.fn(async (request: GroupImageTransportRequest) => {
    signal = request.signal;
    await gate.promise;
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
  });
  return {
    gate,
    transport,
    getSignal: () => signal,
    profile: { endpoints: ["https://images.test"], transport },
  };
}

describe("deferred group image authority", () => {
  it.each(["staging", "publication"] as const)(
    "rolls back an image commit cancelled at the actual %s handoff",
    async (stage) => {
      let cancel: (() => void) | undefined;
      const { manager, group } = await imageManager({
        auditContext: { engineId: "image-cancellation" },
        audit: {
          record(event) {
            if (
              (stage === "staging" &&
                event.kind.type === "epoch_state_changed" &&
                event.kind.new_state === "pending_publish") ||
              (stage === "publication" && event.kind.type === "publish_attempt")
            ) {
              const callback = cancel;
              cancel = undefined;
              callback?.();
            }
          },
        },
      });
      const before = group.session.parentToken;
      const publish = vi.spyOn(manager.network, "publish");
      cancel = () => group.image.close();
      const result = await manager
        .clearGroupImage(group.id)
        .catch((error) => error);
      expect(String(result)).toMatch(/unloaded|closed|cancelled/i);
      await vi.waitFor(() => expect(group.lifecycle).toBe("Stable"));
      expect(publish).not.toHaveBeenCalled();
      expect(group.session.parentToken).toBe(before);
      expect(group.image.source().kind).toBe("none");
      await manager.commit(group.id, {
        extraProposals: [
          proposeUpdateMetadata({ name: "Usable after handoff" }),
        ],
      });
      expect(publish).toHaveBeenCalledOnce();
      manager.unload(group.id);
    },
  );
  it.each(
    (["replace", "clear"] as const).flatMap((mutation) =>
      (["closed", "cancelled"] as const).flatMap((reason) =>
        (["queue", "signing", "wrapping"] as const).map((stage) => ({
          mutation,
          reason,
          stage,
        })),
      ),
    ),
  )(
    "fences $mutation on $reason during actual $stage before publication",
    async ({ mutation, reason, stage }) => {
      const { manager, group } = await imageManager();
      const upload = deferredImageUpload();
      upload.gate.resolve();
      if (mutation === "clear")
        await manager.replaceGroupImage(
          group.id,
          Uint8Array.of(7),
          "image/png",
          upload.profile,
        );
      if (stage === "queue") {
        // A real independently prepared inbound MLS commit creates the actual
        // convergence wait; do not mock submitIntent or the session send path.
        const member = testAccount(1);
        const keyPackage = await generateKeyPackage({
          credential: createCredential(member.pubkey),
          ciphersuiteImpl: group.ciphersuite,
          signer: member.signer,
        });
        const [added] = await group.submitIntent({
          kind: "commit",
          actorPubkey: ADMIN,
          extraProposals: [
            {
              proposalType: defaultProposalTypes.add,
              add: { keyPackage: keyPackage.publicPackage },
            },
          ],
        });
        if (added!.work.kind !== "groupEvolution")
          throw new Error("expected member Welcome");
        const parent = await joinGroup({
          context: {
            cipherSuite: group.ciphersuite,
            authService: marmotAuthService,
          },
          welcome: added!.work.welcome!.welcome!,
          keyPackage: keyPackage.publicPackage,
          privateKeys: keyPackage.privatePackage,
          ratchetTree: undefined,
        });
        const incoming = await createCommit({
          context: {
            cipherSuite: group.ciphersuite,
            authService: marmotAuthService,
          },
          state: parent,
          wireAsPublicMessage: true,
        });
        const event = await createGroupEvent({
          message: incoming.commit,
          state: parent,
          ciphersuite: group.ciphersuite,
        });
        for await (const _result of group.ingest([event])) {
          /* drain */
        }
        expect(group.convergenceStatus).toBe("Syncing");
      }
      const before = group.session.parentToken;
      const source = structuredClone(group.image.source());
      const publish = vi.spyOn(manager.network, "publish");
      const send = vi.spyOn(group.session, "send");
      const submitted = vi.spyOn(group, "submitIntent");
      const gate = deferred<void>();
      let entered = false;
      const signature = group.ciphersuite.signature;
      const sign = signature.sign.bind(signature);
      const wrap = NostrGroupPeeler.prototype.wrapGroupMessage;
      const spy =
        stage === "signing"
          ? vi
              .spyOn(signature, "sign")
              .mockImplementationOnce(async (...args) => {
                const value = await sign(...args);
                entered = true;
                await gate.promise;
                return value;
              })
          : stage === "wrapping"
            ? vi
                .spyOn(NostrGroupPeeler.prototype, "wrapGroupMessage")
                .mockImplementationOnce(async function (
                  this: NostrGroupPeeler,
                  ...args
                ) {
                  const value = await wrap.call(this, ...args);
                  entered = true;
                  await gate.promise;
                  return value;
                })
            : undefined;
      const controller = new AbortController();
      try {
        let outcome: unknown;
        const operation = (
          mutation === "replace"
            ? manager.replaceGroupImage(
                group.id,
                Uint8Array.of(1, 2, 3),
                "image/png",
                upload.profile,
                { signal: controller.signal },
              )
            : manager.clearGroupImage(group.id, { signal: controller.signal })
        ).then(
          (result) => {
            outcome = result;
          },
          (error) => {
            outcome = error;
          },
        );
        await vi.waitFor(() => {
          if (stage === "queue") expect(submitted).toHaveBeenCalledOnce();
          else expect(entered).toBe(true);
        });
        // Also release another manager FIFO waiter, without releasing the blocked
        // signing/wrapping continuation or waiting for convergence settlement.
        let follower: unknown;
        const queued = manager
          .clearGroupImage(group.id, { signal: controller.signal })
          .then(
            (result) => {
              follower = result;
            },
            (error) => {
              follower = error;
            },
          );
        if (reason === "closed") group.image.close();
        else controller.abort();
        await vi.waitFor(() => {
          expect(outcome).toBeDefined();
          expect(follower).toBeDefined();
        });
        await Promise.all([operation, queued]);
        if (reason === "cancelled") {
          expect(outcome).toEqual({ kind: "unavailable", reason });
          expect(follower).toEqual({ kind: "unavailable", reason });
        } else {
          expect(String(outcome)).toMatch(/unloaded|closed|cancelled/i);
          expect(String(follower)).toMatch(/unloaded|closed|cancelled/i);
        }
        expect(publish).not.toHaveBeenCalled();
        expect(group.session.parentToken).toBe(before);
        expect(group.image.source()).toEqual(source);
        expect(group.lifecycle).toBe("Stable");
        if (stage === "queue") {
          expect(send).not.toHaveBeenCalled();
          await vi.waitFor(
            () => expect(group.convergenceStatus).toBe("Settled"),
            { timeout: 2000 },
          );
          // Cancelled queue entries must not reach preparation when it drains.
          expect(send).not.toHaveBeenCalled();
        }
        // Ordinary group work remains usable while cancelled crypto is still
        // pending. Its subsequent canonical state must survive late settlement.
        await manager.commit(group.id, {
          extraProposals: [proposeUpdateMetadata({ name: "Still usable" })],
        });
        const afterOrdinary = group.session.parentToken;
        expect(afterOrdinary).not.toBe(before);
        gate.resolve();
        await vi.waitFor(() =>
          expect(
            send.mock.results.filter((result) => result.type === "return")
              .length,
          ).toBeGreaterThan(0),
        );
        await Promise.allSettled(
          send.mock.results
            .filter((result) => result.type === "return")
            .map((result) => result.value),
        );
        expect(publish).toHaveBeenCalledOnce();
        expect(group.session.parentToken).toBe(afterOrdinary);
        expect(group.image.source()).toEqual(source);
        expect(group.lifecycle).toBe("Stable");
      } finally {
        gate.resolve();
        spy?.mockRestore();
        send.mockRestore();
        submitted.mockRestore();
        manager.unload(group.id);
      }
    },
  );

  it.each(["replace", "clear"] as const)(
    "keeps %s publication outcome after image close and caller abort during transport",
    async (mutation) => {
      const { manager, group } = await imageManager();
      const upload = deferredImageUpload();
      upload.gate.resolve();
      await manager.replaceGroupImage(
        group.id,
        Uint8Array.of(7),
        "image/png",
        upload.profile,
      );
      const before = group.session.parentToken;
      const source = structuredClone(group.image.source());
      const controller = new AbortController();
      const gate = deferred<void>();
      const original = manager.network.publish.bind(manager.network);
      const publish = vi
        .spyOn(manager.network, "publish")
        .mockImplementationOnce(async (...args) => {
          await gate.promise;
          return original(...args);
        });
      try {
        const operation =
          mutation === "replace"
            ? manager.replaceGroupImage(
                group.id,
                Uint8Array.of(1),
                "image/png",
                upload.profile,
                { signal: controller.signal },
              )
            : manager.clearGroupImage(group.id, { signal: controller.signal });
        await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
        group.image.close();
        controller.abort();
        gate.resolve();
        const result = await operation;
        expect(result.kind).toBe("published");
        if (result.kind !== "published")
          throw new Error("expected confirmed publication");
        expect(result.publications[0]!.retryPublication).toBe(false);
        expect(result.publications[0]!.persistence).toEqual({
          kind: "succeeded",
        });
        expect(group.session.parentToken).not.toBe(before);
        expect(group.image.source()).not.toEqual(source);
        expect(publish).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        publish.mockRestore();
        manager.unload(group.id);
      }
    },
  );

  it("cancels a manager FIFO waiter promptly without letting its successor overtake an upload", async () => {
    const { manager, group } = await imageManager({
      maxPendingImageMutations: 2,
    });
    const upload = deferredImageUpload();
    const first = manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      upload.profile,
    );
    await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = manager.clearGroupImage(group.id, {
      signal: controller.signal,
    });
    controller.abort();
    expect(await second).toEqual({ kind: "unavailable", reason: "cancelled" });
    const submit = vi.spyOn(group, "submitIntent");
    const third = manager.clearGroupImage(group.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(submit).not.toHaveBeenCalled();
    upload.gate.resolve();
    expect((await first).kind).toBe("published");
    expect((await third).kind).toBe("published");
    expect(group.image.source().kind).toBe("none");
    manager.unload(group.id);
  });

  it("releases queued mutations on closure without waiting for a blocked identity signer", async () => {
    const { manager, group } = await imageManager();
    const identity = deferred<string>();
    const signer = vi
      .spyOn(manager.signer, "getPublicKey")
      .mockReturnValueOnce(identity.promise);
    let settled = 0;
    const first = manager.clearGroupImage(group.id).catch(() => {
      settled++;
    });
    const second = manager.clearGroupImage(group.id).catch(() => {
      settled++;
    });
    await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());
    manager.unload(group.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const released = settled;
    identity.resolve(ADMIN);
    await Promise.all([first, second]);
    signer.mockRestore();
    expect(released).toBe(2);
  });

  it("refuses an upload after real canonical admin demotion", async () => {
    const { manager, group } = await imageManager();
    const member = testAccount(1);
    const keyPackage = await generateKeyPackage({
      credential: createCredential(member.pubkey),
      ciphersuiteImpl: group.ciphersuite,
      signer: member.signer,
    });
    await manager.commit(group.id, {
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: keyPackage.publicPackage },
        },
      ],
    });
    const upload = deferredImageUpload();
    const operation = manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      upload.profile,
    );
    const rejected = expect(operation).rejects.toThrow("active group admin");
    await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
    await manager.commit(group.id, {
      extraProposals: [
        proposeUpdateMetadata({ adminPubkeys: [member.pubkey] }),
      ],
    });
    const before = group.session.parentToken;
    const submit = vi.spyOn(group, "submitIntent");
    upload.gate.resolve();
    await rejected;
    expect(submit).not.toHaveBeenCalled();
    expect(group.session.parentToken).toBe(before);
    expect(group.image.source().kind).toBe("none");
    manager.unload(group.id);
  });

  it.each(["membership", "lifecycle", "identity"] as const)(
    "rechecks %s after deferred upload",
    async (change) => {
      const { manager, group } = await imageManager();
      const upload = deferredImageUpload();
      const operation = manager.replaceGroupImage(
        group.id,
        Uint8Array.of(1),
        "image/png",
        upload.profile,
      );
      const rejected = expect(operation).rejects.toThrow(
        /admin|lifecycle|actor/,
      );
      await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
      if (change === "membership")
        vi.spyOn(group, "status", "get").mockReturnValue("removed");
      if (change === "lifecycle")
        vi.spyOn(group, "lifecycle", "get").mockReturnValue("Recovering");
      const identity =
        change === "identity"
          ? vi
              .spyOn(manager.signer, "getPublicKey")
              .mockResolvedValue(testAccount(1).pubkey)
          : undefined;
      const submit = vi.spyOn(group, "submitIntent");
      upload.gate.resolve();
      await rejected;
      identity?.mockRestore();
      expect(submit).not.toHaveBeenCalled();
      expect(group.image.source().kind).toBe("none");
      manager.unload(group.id);
    },
  );

  it("keeps confirmed image metadata and returns persistence failure without republishing", async () => {
    const { manager, group } = await imageManager();
    const upload = deferredImageUpload();
    upload.gate.resolve();
    vi.spyOn(manager.storage, "batch").mockRejectedValue(
      new Error("disk full"),
    );
    const publish = vi.spyOn(manager.network, "publish");
    const result = await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      upload.profile,
    );
    expect(result.kind).toBe("published");
    if (result.kind !== "published")
      throw new Error("expected publication outcome");
    expect(result.publications[0]!.persistence).toEqual({
      kind: "failed",
      error: "disk full",
    });
    expect(result.publications[0]!.retryPublication).toBe(false);
    expect(group.image.source().kind).toBe("blossom");
    expect(publish).toHaveBeenCalledOnce();
    manager.unload(group.id);
  });

  it("rechecks profile support after upload before submitting any intent", async () => {
    const { manager, group } = await imageManager();
    const upload = deferredImageUpload();
    const submit = vi.spyOn(group, "submitIntent");
    const operation = manager
      .replaceGroupImage(
        group.id,
        Uint8Array.of(1),
        "image/png",
        upload.profile,
      )
      .catch((error) => error);
    await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
    vi.spyOn(group, "profileSupport", "get").mockReturnValue({
      kind: "unsupported",
      proofReason: "missing-requirement",
    });
    upload.gate.resolve();
    await operation;
    expect(submit.mock.calls.length).toBe(0);
    expect(group.image.source().kind).toBe("none");
    manager.unload(group.id);
  });

  it.each(["clear", "url", "replacement"] as const)(
    "refuses an uploaded candidate before submission after canonical %s",
    async (change) => {
      const { manager, group } = await imageManager();
      const upload = deferredImageUpload();
      const operation = manager
        .replaceGroupImage(
          group.id,
          Uint8Array.of(1),
          "image/png",
          upload.profile,
        )
        .catch((error) => error);
      await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
      if (change === "url")
        await manager.commit(group.id, {
          extraProposals: [
            proposeUpdateMetadata({ avatarUrl: "https://avatar.test/a" }),
          ],
        });
      else
        await manager.commit(group.id, {
          expectedParent: group.session.parentToken,
          extraProposals: [
            {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                operation: "update",
                update: encodeGroupBlossomImage(
                  change === "clear"
                    ? { kind: "empty" }
                    : encryptGroupImage(Uint8Array.of(2), "image/png").metadata,
                ),
              },
            },
          ],
        });
      const submit = vi.spyOn(group, "submitIntent");
      const before = group.session.parentToken;
      upload.gate.resolve();
      await operation;
      expect(submit.mock.calls.length).toBe(0);
      expect(group.session.parentToken).toBe(before);
      manager.unload(group.id);
    },
  );

  it("aborts an admitted upload when its owning facade is disposed", async () => {
    const { manager, group } = await imageManager();
    const upload = deferredImageUpload();
    const operation = manager
      .replaceGroupImage(
        group.id,
        Uint8Array.of(1),
        "image/png",
        upload.profile,
      )
      .catch((error) => error);
    await vi.waitFor(() => expect(upload.transport).toHaveBeenCalledOnce());
    manager.unload(group.id);
    const aborted = upload.getSignal()!.aborted;
    upload.gate.resolve();
    await operation;
    expect(aborted).toBe(true);
  });
});

describe("GroupsManager", () => {
  function watchManager() {
    return new GroupsManager({
      storage: memoryStorage(),
      signer: ADMIN_ACCOUNT.signer,
      network: new MockNetwork(),
    });
  }

  it("an already aborted watch yields nothing and retains no listeners", async () => {
    const manager = watchManager();
    const controller = new AbortController();
    controller.abort();
    const watcher = manager.watch({ signal: controller.signal });
    const result = await watcher.next();
    await watcher.return(undefined);
    expect(result.done).toBe(true);
    expect(manager.listenerCount("updated")).toBe(0);
  });

  it("abort releases idle watch listeners and completes next without an update", async () => {
    const manager = watchManager();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const watcher = manager.watch({ signal: controller.signal });
    await watcher.next();
    const pending = watcher.next();
    await Promise.resolve();
    controller.abort();
    const remaining = manager.listenerCount("updated");
    // Release the old implementation for an assertion-based RED, avoiding timeout evidence.
    if (remaining) manager.emit("updated", []);
    const result = await pending;
    await watcher.return(undefined);
    expect(remaining).toBe(0);
    expect(result.done).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]!.slice(0, 2)).toEqual(
      add.mock.calls[0]!.slice(0, 2),
    );
  });

  it("return wakes an outstanding idle next and releases listeners", async () => {
    const manager = watchManager();
    const watcher = manager.watch();
    await watcher.next();
    const pending = watcher.next();
    await Promise.resolve();
    const returned = watcher.return(undefined);
    const remaining = manager.listenerCount("updated");
    if (remaining) manager.emit("updated", []);
    const result = await pending;
    await returned;
    expect(remaining).toBe(0);
    expect(result.done).toBe(true);
  });

  it("retains an update racing with a blocked snapshot", async () => {
    const manager = watchManager();
    let release!: (groups: never[]) => void;
    const snapshot = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    const load = vi
      .spyOn(manager, "loadAll")
      .mockReturnValueOnce(snapshot)
      .mockResolvedValue([]);
    const watcher = manager.watch();
    const initial = watcher.next();
    manager.emit("updated", []);
    release([]);
    await initial;
    const next = watcher.next();
    await Promise.resolve();
    const loads = load.mock.calls.length;
    if (loads === 1) manager.emit("updated", []);
    await next;
    await watcher.return(undefined);
    expect(loads).toBe(2);
  });

  it("return cancels a blocked initial load and repeated watchers release abort listeners", async () => {
    const manager = watchManager();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let release!: (groups: never[]) => void;
    const snapshot = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    vi.spyOn(manager, "loadAll")
      .mockReturnValueOnce(snapshot)
      .mockResolvedValue([]);
    const watcher = manager.watch({ signal: controller.signal });
    const pending = watcher.next();
    const returned = watcher.return(undefined);
    const remaining = manager.listenerCount("updated");
    release([]);
    const result = await pending;
    await returned;
    expect(remaining).toBe(0);
    expect(result.done).toBe(true);
    for (let i = 0; i < 3; i++) {
      const next = manager.watch({ signal: controller.signal });
      await next.next();
      await next.return(undefined);
    }
    expect(manager.listenerCount("updated")).toBe(0);
    expect(add).toHaveBeenCalledTimes(4);
    expect(remove).toHaveBeenCalledTimes(4);
  });

  it("watch emits a new array instance for every update", async () => {
    const manager = new GroupsManager({
      storage: memoryStorage(),
      signer: ADMIN_ACCOUNT.signer,
      network: new MockNetwork(),
    });

    const watcher = manager.watch();

    const first = await watcher.next();
    const secondPromise = watcher.next();
    await Promise.resolve();

    manager.emit("updated", []);
    const second = await secondPromise;

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(second.value).not.toBe(first.value);

    await watcher.return(undefined);
  });
});

describe("GroupsManager session/runtime helpers", () => {
  it("hydrates terminal evidence before a stale persisted group becomes visible", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const storage = memoryStorage();
    const manager = new GroupsManager({
      storage,
      signer: ADMIN_ACCOUNT.signer,
      network,
    });
    const group = await manager.create("Terminal", {
      relays: ["wss://relay.test"],
    });
    const stale = await storage.get(groupKeys.state(group.idStr));
    manager.unload(group.id);
    await storage.set(
      disbandTombstoneKey(group.idStr),
      encodeDisbandTombstone({
        groupId: group.id,
        selectedEpoch: Number(group.state.groupContext.epoch),
        commitDigest: new Uint8Array(32).fill(7),
        actorPubkey: ADMIN,
        notificationState: "pending",
      }),
    );
    await storage.set(groupKeys.state(group.idStr), stale!);

    const get = storage.get.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(storage, "get").mockImplementation(async (key) => {
      if (key.startsWith(`${group.idStr}/disband/`)) await gate;
      return get(key);
    });
    let loaded = false;
    manager.on("loaded", () => {
      loaded = true;
    });
    const loading = manager.get(group.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loaded).toBe(false);
    release();
    const restarted = await loading;
    expect(await restarted.session.disbandTombstone()).toBeDefined();
    expect(await storage.get(groupKeys.state(group.idStr))).toBeUndefined();
  });

  it("destroys only the destroyed group's namespaced keys on a shared backend", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const storage = memoryStorage();
    const manager = new GroupsManager({
      storage,
      signer: ADMIN_ACCOUNT.signer,
      network,
    });
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });
    const other = await manager.create("Other Group", {
      relays: ["wss://relay.test"],
    });
    await storage.set(groupKeys.removed(group.idStr), Uint8Array.of(1));
    await storage.set(groupKeys.removed(other.idStr), Uint8Array.of(1));
    const otherKeys = await storage.list(groupKeys.prefix(other.idStr));
    expect(otherKeys).toContain(groupKeys.state(other.idStr));

    await group.session.destroyLocalState();

    expect(await storage.list(groupKeys.prefix(group.idStr))).toEqual([]);
    expect(await storage.list(groupKeys.prefix(other.idStr))).toEqual(
      otherKeys,
    );
  });
  function makeManager(network: NostrNetworkInterface) {
    const signer = ADMIN_ACCOUNT.signer;
    return new GroupsManager({
      storage: memoryStorage(),
      signer,
      network,
    });
  }

  it("exposes the same session and runtime as the cached group", async () => {
    const manager = makeManager(new MockNetwork(["wss://relay.test"]));
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    expect(await manager.session(group.id)).toBe(group.session);
    expect(await manager.runtime(group.id)).toBe(group.runtime);
  });

  it("drives a send intent through session and runtime to the network", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    const payload = new TextEncoder().encode("hello");
    const results = await manager.send(group.id, {
      kind: "applicationMessage",
      payload,
    });

    expect(results).toHaveLength(1);
    expect(results[0].work.kind).toBe("applicationMessage");
    // The application message envelope reached the mock relay.
    expect(network.events).toHaveLength(1);
    expect(network.events[0].kind).toBe(445);
  });

  it("commits through the manager and advances the group epoch", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    const epochBefore = group.state.groupContext.epoch;
    const response = await manager.commit(group.id, { extraProposals: [] });

    expect(Object.values(response).every((r) => r.ok)).toBe(true);
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(epochBefore + 1n);
  });

  it("ingests transport events through the group session (self-echo)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("echo"),
    });
    const envelope = network.events[0];

    const results = [];
    for await (const result of manager.ingest(group.id, [envelope]))
      results.push(result);

    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("skipped");
    if (results[0].kind !== "skipped") throw new Error("expected skipped");
    expect(results[0].reason).toBe("self-echo");
  });

  it("emits one public removal after concurrently loading a persisted tombstone", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const storage = memoryStorage();
    const signer = ADMIN_ACCOUNT.signer;
    const options = {
      storage,
      signer,
      network,
    };

    const writer = new GroupsManager(options);
    const created = await writer.create("Removed Group", {
      relays: ["wss://relay.test"],
    });
    created.state = {
      ...created.state,
      groupActiveState: { kind: "removedFromGroup" },
    };
    await created.save(true);

    const reader = new GroupsManager(options);
    const removed: Uint8Array[] = [];
    reader.on("removed", (groupId) => removed.push(groupId));

    const [first, second] = await Promise.all([
      reader.get(created.id),
      reader.get(created.id),
    ]);

    expect(first).toBe(second);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(created.id);
    expect(await storage.get(groupKeys.removed(created.idStr))).toEqual(
      Uint8Array.of(1),
    );

    const restarted = new GroupsManager(options);
    const restartRemoved = vi.fn();
    restarted.on("removed", restartRemoved);
    const reloaded = await restarted.get(created.id);

    expect(reloaded.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(restartRemoved).not.toHaveBeenCalled();
    await expect(
      restarted.send(reloaded.id, {
        kind: "applicationMessage",
        payload: new TextEncoder().encode("blocked"),
      }),
    ).rejects.toThrow(/removed/i);
  });

  it("disposes a failed reconvergence activation and retries with a fresh group", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const stateStore = memoryStorage();
    const signer = ADMIN_ACCOUNT.signer;
    const writer = new GroupsManager({
      storage: stateStore,
      signer,
      network,
    });
    const created = await writer.create("Activation Retry", {
      relays: ["wss://relay.test"],
    });
    await created.save(true);

    const activationError = new Error("reconvergence unavailable");
    const tips = vi
      .spyOn(created.forkTree.constructor.prototype, "tips")
      .mockReturnValue(["tip-a", "tip-b"]);
    const reconverge = vi
      .spyOn(MarmotGroup.prototype, "reconverge")
      .mockRejectedValueOnce(activationError)
      .mockResolvedValue(undefined);
    const dispose = vi.spyOn(MarmotGroup.prototype, "dispose");
    const reader = new GroupsManager({
      storage: stateStore,
      signer,
      network,
    });

    const firstAttempt = [reader.get(created.id), reader.get(created.id)];
    await expect(firstAttempt[0]).rejects.toBe(activationError);
    await expect(firstAttempt[1]).rejects.toBe(activationError);
    expect(reader.loaded).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();

    const retried = await reader.get(created.id);
    expect(retried).not.toBe(created);
    expect(reader.loaded).toEqual([retried]);
    expect(reconverge).toHaveBeenCalledTimes(2);

    tips.mockRestore();
  });

  it("disposes a failed removal-marker activation and retries with a fresh group", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const stateStore = memoryStorage();
    const markerError = new Error("marker unavailable");
    const markerReads = vi.fn();
    const signer = ADMIN_ACCOUNT.signer;
    const writer = new GroupsManager({
      storage: stateStore,
      signer,
      network,
    });
    const created = await writer.create("Marker Retry", {
      relays: ["wss://relay.test"],
    });
    created.state = {
      ...created.state,
      groupActiveState: { kind: "removedFromGroup" },
    };
    await created.save(true);

    const get = stateStore.get.bind(stateStore);
    vi.spyOn(stateStore, "get").mockImplementation(async (key) => {
      if (key !== groupKeys.removed(created.idStr)) return get(key);
      markerReads(key);
      if (markerReads.mock.calls.length === 1) throw markerError;
      return undefined;
    });
    const dispose = vi.spyOn(MarmotGroup.prototype, "dispose");
    const reader = new GroupsManager({
      storage: stateStore,
      signer,
      network,
    });
    const firstAttempt = [reader.get(created.id), reader.get(created.id)];

    await expect(firstAttempt[0]).rejects.toBe(markerError);
    await expect(firstAttempt[1]).rejects.toBe(markerError);
    expect(reader.loaded).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();

    const retried = await reader.get(created.id);
    expect(retried).not.toBe(created);
    expect(reader.loaded).toEqual([retried]);
    expect(markerReads).toHaveBeenCalledTimes(2);
  });

  it.each(["reconverge", "realizeRemovalIfNeeded"] as const)(
    "keeps a late cache hit pending until %s activation rejects",
    async (activationStep) => {
      const network = new MockNetwork(["wss://relay.test"]);
      const stateStore = memoryStorage();
      const signer = ADMIN_ACCOUNT.signer;
      const writer = new GroupsManager({
        storage: stateStore,
        signer,
        network,
      });
      const created = await writer.create("Late Activation", {
        relays: ["wss://relay.test"],
      });
      await created.save(true);

      let rejectActivation!: (reason: Error) => void;
      let resolveActivationStarted!: () => void;
      const activationStarted = new Promise<void>((resolve) => {
        resolveActivationStarted = resolve;
      });
      const activation = new Promise<void>((_resolve, reject) => {
        rejectActivation = reject;
      });
      const activationError = new Error(`${activationStep} unavailable`);
      const tips = vi
        .spyOn(created.forkTree.constructor.prototype, "tips")
        .mockReturnValue(
          activationStep === "reconverge" ? ["tip-a", "tip-b"] : ["tip-a"],
        );
      const activationSpy = vi
        .spyOn(MarmotGroup.prototype, activationStep)
        .mockImplementationOnce(async () => {
          resolveActivationStarted();
          await activation;
        })
        .mockResolvedValue(undefined);
      const dispose = vi.spyOn(MarmotGroup.prototype, "dispose");
      const reader = new GroupsManager({
        storage: stateStore,
        signer,
        network,
      });
      const updated = vi.fn();
      const loaded = vi.fn();
      reader.on("updated", updated);
      reader.on("loaded", loaded);

      const activatingGet = reader.get(created.id);
      await activationStarted;
      const lateCacheHit = reader.get(created.id);
      let lateSettled = false;
      void lateCacheHit.then(
        () => {
          lateSettled = true;
        },
        () => {
          lateSettled = true;
        },
      );
      await Promise.resolve();

      expect(lateSettled).toBe(false);
      expect(reader.loaded).toEqual([]);
      expect(updated).not.toHaveBeenCalled();
      expect(loaded).not.toHaveBeenCalled();

      rejectActivation(activationError);
      await expect(activatingGet).rejects.toBe(activationError);
      await expect(lateCacheHit).rejects.toBe(activationError);
      expect(reader.loaded).toEqual([]);
      expect(updated).not.toHaveBeenCalled();
      expect(loaded).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();

      const retried = await reader.get(created.id);
      expect(retried).not.toBe(created);
      expect(reader.loaded).toEqual([retried]);
      expect(updated).toHaveBeenCalledOnce();
      expect(updated).toHaveBeenLastCalledWith([retried]);
      expect(loaded).toHaveBeenCalledOnce();
      expect(loaded).toHaveBeenLastCalledWith(retried);
      expect(activationSpy).toHaveBeenCalledTimes(2);

      tips.mockRestore();
    },
  );
});

describe("GroupsManager #connectGroup drain — trust boundary (SEC-01/WIRE-02)", () => {
  it("bounds accepted and rejected event identities with deterministic LRU eviction", () => {
    const accepted = new BoundedIdCache(2);
    const rejected = new BoundedIdCache(2);

    accepted.add("accepted-1");
    accepted.add("accepted-2");
    accepted.add("accepted-3");
    rejected.add("rejected-1");
    rejected.add("rejected-2");
    rejected.add("rejected-3");

    expect(accepted.size).toBe(2);
    expect(accepted.has("accepted-1")).toBe(false);
    expect(rejected.size).toBe(2);
    expect(rejected.has("rejected-1")).toBe(false);
  });

  /**
   * `finalizeEvent` caches a `true` result under `verifiedSymbol` on the
   * event it just signed; a plain object spread copies that own enumerable
   * symbol property too, so a naive `{ ...real, sig: "bad" }` would silently
   * short-circuit `defaultVerifyEvent` back to `true`. Strip the cache so the
   * corrupted event is actually re-verified from scratch.
   */
  function corruptSignature(event: NostrEvent): NostrEvent {
    const corrupted: NostrEvent = { ...event, sig: "0".repeat(128) };
    delete (corrupted as Record<PropertyKey, unknown>)[verifiedSymbol];
    return corrupted;
  }

  function makeManager(
    network: NostrNetworkInterface,
    verifyEvent?: VerifyEventMethod,
  ) {
    const signer = ADMIN_ACCOUNT.signer;
    return new GroupsManager({
      storage: memoryStorage(),
      signer,
      network,
      verifyEvent,
    });
  }

  it("rejects an inbound 445 event with an invalid signature before ingest", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];
    const corrupted = corruptSignature(real);
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    // Backfill and subscription replay each surface the malformed event once.
    expect(rejections).toHaveLength(2);
    expect(
      rejections.every(([, , reason]) => reason === "invalid-signature"),
    ).toBe(true);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("rejects a properly-signed 445 event carrying a duplicate h tag before ingest", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];

    // Re-sign a modified draft carrying a second `h` tag — a genuinely valid
    // signature (matches how 445 events are actually signed per
    // refs/marmot/protocol-core/group-messaging.md ephemeral
    // keys), but the routing tag itself violates #236 singleton cardinality.
    const draft = {
      kind: real.kind,
      created_at: real.created_at,
      content: real.content,
      tags: [...real.tags, ["h", "duplicate-h-value"]],
    };
    const badEvent = finalizeEvent(draft, generateSecretKey());
    network.clear();
    network.events.push(badEvent);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    // Backfill and subscription replay each surface the malformed event once.
    expect(rejections).toHaveLength(2);
    expect(
      rejections.every(([, , reason]) => reason === "tag-cardinality"),
    ).toBe(true);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // transports/nostr.md: a kind-445 carries one `h` tag and at most one NIP-40
  // `expiration` tag, nothing else. MDK drops anything else before decrypting.
  async function reSignedWithTags(extraTags: string[][]): Promise<{
    manager: ReturnType<typeof makeManager>;
    group: Awaited<ReturnType<ReturnType<typeof makeManager>["create"]>>;
    rejections: string[];
  }> {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });
    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];
    const event = finalizeEvent(
      {
        kind: real.kind,
        created_at: real.created_at,
        content: real.content,
        tags: [...real.tags, ...extraTags],
      },
      generateSecretKey(),
    );
    network.clear();
    network.events.push(event);
    const rejections: string[] = [];
    manager.on("rejected", (_groupId, _event, reason) =>
      rejections.push(reason),
    );
    return { manager, group, rejections };
  }

  it.each([
    ["a p tag", [["p", "ab".repeat(32)]]],
    ["an encoding tag", [["encoding", "base64"]]],
    ["a non-numeric expiration", [["expiration", "soon"]]],
    ["an expiration with an extra value", [["expiration", "1", "2"]]],
    [
      "two expiration tags",
      [
        ["expiration", "1"],
        ["expiration", "2"],
      ],
    ],
  ])(
    "rejects a properly-signed 445 event carrying %s before ingest",
    async (_label, extraTags) => {
      const { manager, group, rejections } = await reSignedWithTags(extraTags);
      const ingestSpy = vi.spyOn(group, "ingest");

      await manager.connect(group.id);

      expect(rejections).toEqual(["tag-cardinality", "tag-cardinality"]);
      expect(ingestSpy).not.toHaveBeenCalled();
    },
  );

  it("accepts a 445 event carrying one NIP-40 expiration tag", async () => {
    const { manager, group, rejections } = await reSignedWithTags([
      ["expiration", "4102444800"],
    ]);
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    expect(rejections).toEqual([]);
    expect(ingestSpy).toHaveBeenCalled();
  });

  it("delegates verification to an injected fakeVerifyEvent (trust-upstream)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network, fakeVerifyEvent);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const real = network.events[0];
    const corrupted = corruptSignature(real);
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );

    await manager.connect(group.id);

    // With signature verification delegated away (fakeVerifyEvent), the
    // invalid-signature rejection must never fire for this event.
    expect(
      rejections.some(([, , reason]) => reason === "invalid-signature"),
    ).toBe(false);
  });

  it("rejects a signed event for a different group before ingest or accepted-id caching", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const genuine = network.events[0];
    const wrongGroup = finalizeEvent(
      {
        kind: genuine.kind,
        created_at: genuine.created_at,
        content: genuine.content,
        tags: genuine.tags.map((tag) =>
          tag[0] === "h" ? ["h", "f".repeat(64)] : tag,
        ),
      },
      generateSecretKey(),
    );
    const unfilteredNetwork: NostrNetworkInterface = {
      ...network,
      publish: network.publish.bind(network),
      getUserInboxRelays: network.getUserInboxRelays.bind(network),
      request: async () => [wrongGroup],
      subscription: () => ({
        subscribe: () => ({ unsubscribe: () => {} }),
      }),
    };
    const unfilteredManager = makeManager(unfilteredNetwork);
    const unfilteredGroup = await unfilteredManager.adoptClientState(
      group.state,
    );

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    unfilteredManager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(unfilteredGroup, "ingest");

    await unfilteredManager.connect(unfilteredGroup.id);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.[2]).toBe("tag-cardinality");
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("does not let a corrupted same-id forgery censor the genuine event that arrives later (WR-01)", async () => {
    const network = new MockNetwork(["wss://relay.test"]);
    const manager = makeManager(network);
    const group = await manager.create("Test Group", {
      relays: ["wss://relay.test"],
    });

    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    const genuine = network.events[0];
    // Same id (NIP-01 ids don't cover `sig`), corrupted signature.
    const corrupted = corruptSignature(genuine);

    // Only the corrupted forgery is present for backfill — the genuine event
    // has not "arrived" yet.
    network.clear();
    network.events.push(corrupted);

    const rejections: Array<[Uint8Array, NostrEvent, string]> = [];
    manager.on("rejected", (groupId, event, reason) =>
      rejections.push([groupId, event, reason]),
    );
    const ingestSpy = vi.spyOn(group, "ingest");

    await manager.connect(group.id);

    // The forgery is rejected and does not reach ingest. MockNetwork's
    // `subscription()` replays every already-matching event on subscribe, so
    // `connect()`'s backfill (`request`) and its immediately-following
    // `subscription().subscribe()` both deliver this SAME corrupted object —
    // T-03-23 removed the object-identity rejection cache that used to
    // collapse that redelivery to one `rejected` emit, so two are now
    // expected (informational, not a protocol-safety regression; see the
    // `seen`/`rejectedEvents` comment in `#connectGroup`).
    expect(rejections).toHaveLength(2);
    expect(
      rejections.every(([, , reason]) => reason === "invalid-signature"),
    ).toBe(true);
    expect(ingestSpy).not.toHaveBeenCalled();

    // The genuine, validly-signed event (same id) now arrives via the live
    // subscription. It must NOT be censored by the poisoned dedup slot.
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    ingestSpy.mockImplementation(async function* () {
      admitted();
    });
    await network.publish(["wss://relay.test"], genuine);
    await admission;

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith([genuine]);

    // A second delivery of the already-verified genuine event is still
    // deduped and does not reach ingest again.
    await network.publish(["wss://relay.test"], genuine);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });
});
