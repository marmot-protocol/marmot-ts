import { describe, expect, it, vi } from "vitest";
import { GroupsManager } from "../../client/groups-manager.js";
import { memoryStorage } from "../../utils/storage.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { testAccount } from "../helpers/test-accounts.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  GroupImageService,
  fetchGroupImageTransport,
  type GroupImageProfile,
  type GroupImageTransportRequest,
} from "../../client/group/index.js";
import { proposeUpdateMetadata } from "../../client/group/proposals/index.js";
import { base64urlnopad } from "@scure/base";
import { verifyEvent } from "applesauce-core/helpers/event";
import { appDataUpdateProposalType } from "ts-mls";
import { encodeGroupBlossomImage } from "../../core/components/blossom-image.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../core/components/ids.js";

async function setup() {
  const network = new MockNetwork();
  const manager = new GroupsManager({
    storage: memoryStorage(),
    signer: testAccount(0).signer,
    network,
  });
  const group = await manager.create("Image tracer", {
    relays: network.relayUrls,
  });
  let ciphertext = new Uint8Array();
  const transport = vi.fn(async (request: GroupImageTransportRequest) => {
    if (request.method === "PUT") {
      ciphertext = request.body!.slice();
      return {
        status: 201,
        body: new TextEncoder().encode(
          JSON.stringify({
            sha256: bytesToHex(sha256(ciphertext)),
            size: ciphertext.length,
            type: "application/octet-stream",
            uploaded: 1,
            url: `https://images.test/${bytesToHex(sha256(ciphertext))}`,
          }),
        ),
      };
    }
    return { status: 200, body: ciphertext.slice() };
  });
  return {
    manager,
    group,
    network,
    transport,
    profile: { endpoints: ["https://images.test"], transport },
  };
}

describe("public group image tracer", () => {
  it("forwards the parent guard for direct manager image commits", async () => {
    const { manager, group, profile } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    let failure: string | undefined;
    try {
      await manager.commit(group.id, {
        expectedParent: group.session.parentToken,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
              operation: "update",
              update: encodeGroupBlossomImage({ kind: "empty" }),
            },
          },
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toBeUndefined();
    expect(group.image.source()).toEqual({ kind: "none" });
  });
  it("refuses a replacement without endpoints before upload or MLS preparation", async () => {
    const { manager, group, transport, network } = await setup();
    const submit = vi.spyOn(group, "submitIntent");
    expect(
      await manager.replaceGroupImage(group.id, Uint8Array.of(1), "image/png", {
        transport,
      }),
    ).toEqual({ kind: "unavailable", reason: "endpoint-absent" });
    expect(transport).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(network.events).toHaveLength(0);
  });
  it.each(["transport", "invalid-response", "byte-limit"] as const)(
    "preserves the prior image and produces no commit after %s upload failure",
    async (reason) => {
      const { manager, group, profile, network } = await setup();
      await manager.replaceGroupImage(
        group.id,
        Uint8Array.of(2),
        "image/png",
        profile,
      );
      const before = group.image.source();
      const epoch = group.state.groupContext.epoch;
      const submit = vi.spyOn(group, "submitIntent");
      const transport = vi.fn(async () => {
        if (reason === "transport") throw new Error("offline");
        return {
          status: 201,
          body:
            reason === "byte-limit"
              ? new Uint8Array(16 * 1024 + 1)
              : new TextEncoder().encode("{}"),
        };
      });
      expect(
        await manager.replaceGroupImage(
          group.id,
          Uint8Array.of(3),
          "image/png",
          { ...profile, transport },
        ),
      ).toEqual({ kind: "unavailable", reason });
      expect(submit).not.toHaveBeenCalled();
      expect(group.image.source()).toEqual(before);
      expect(group.state.groupContext.epoch).toBe(epoch);
      expect(network.events).toHaveLength(1);
    },
  );
  it("does not turn an upload acknowledgement or failed relay publication into confirmation", async () => {
    const { manager, group, profile, network } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(2),
      "image/png",
      profile,
    );
    const before = group.image.source();
    const order: string[] = [];
    const transport = async (request: GroupImageTransportRequest) => {
      order.push("upload");
      const response = await profile.transport(request);
      expect(group.image.source()).toEqual(before);
      return response;
    };
    vi.spyOn(network, "publish").mockImplementation(async () => {
      order.push("publish");
      expect(group.image.source()).toEqual(before);
      return {
        "wss://mock-relay.test": { from: "wss://mock-relay.test", ok: false },
      };
    });
    await expect(
      manager.replaceGroupImage(group.id, Uint8Array.of(3), "image/png", {
        ...profile,
        transport,
      }),
    ).rejects.toThrow("Failed to publish commit");
    expect(order).toEqual(["upload", "publish"]);
    expect(group.image.source()).toEqual(before);
  });
  it("preserves the existing runtime outcome when confirmation fails after relay acknowledgement", async () => {
    const { manager, group, profile } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(2),
      "image/png",
      profile,
    );
    const before = group.image.source();
    vi.spyOn(group.session, "confirmPublished").mockImplementationOnce(() => {
      throw new Error("confirmation refused");
    });
    const result = await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(3),
      "image/png",
      profile,
    );
    expect(result.kind).toBe("published");
    if (result.kind !== "published")
      throw new Error("publication result absent");
    expect(result.publications[0]!.persistence).toEqual({
      kind: "failed",
      error: "confirmation refused",
    });
    expect(result.publications[0]!.retryPublication).toBe(false);
    expect(result.publications[0]!.notifications).toEqual([]);
    expect(group.image.source()).toEqual(before);
  });
  it("keeps URL precedence and clears only Blossom without contacting or deleting the blob", async () => {
    const { manager, group, profile, transport } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    await manager.commit(group.id, {
      extraProposals: [
        proposeUpdateMetadata({ avatarUrl: "https://avatar.test/image.png" }),
      ],
    });
    transport.mockClear();
    expect(group.image.source()).toEqual({
      kind: "url",
      url: "https://avatar.test/image.png",
    });
    expect(await group.image.read(profile)).toEqual({
      kind: "unavailable",
      reason: "url-selected",
    });
    await manager.clearGroupImage(group.id);
    expect(group.image.source()).toEqual({
      kind: "url",
      url: "https://avatar.test/image.png",
    });
    expect(transport).not.toHaveBeenCalled();
    await manager.commit(group.id, {
      extraProposals: [proposeUpdateMetadata({ avatarUrl: "" })],
    });
    expect(group.image.source()).toEqual({ kind: "none" });
  });
  it("uses a signed fresh image upload identity independent from the account and content key", async () => {
    const { manager, group, profile, transport } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    const source = group.image.source();
    if (source.kind !== "blossom") throw new Error("image absent");
    const authorization =
      transport.mock.calls[0]![0].headers.Authorization.slice(6);
    const event = JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(authorization)),
    );
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(24242);
    expect(event.pubkey).not.toBe(testAccount(0).pubkey);
    expect(event.tags).toContainEqual([
      "x",
      bytesToHex(source.metadata.imageHash),
    ]);
    expect(event.tags).toContainEqual(["server", "images.test"]);
    expect(source.metadata.imageKey).not.toEqual(
      source.metadata.imageUploadKey,
    );
    const first = source.metadata.imageUploadKey;
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    const next = group.image.source();
    if (next.kind !== "blossom") throw new Error("image absent");
    expect(next.metadata.imageUploadKey).not.toEqual(first);
  });
  it("includes upload endpoint resolution in the replacement deadline", async () => {
    const { manager, group, profile, transport, network } = await setup();
    const result = await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      {
        ...profile,
        deadlineMs: 5,
        resolveEndpoints: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return profile.endpoints;
        },
      },
    );
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("unexpected publication");
    expect(result.reason).toBe("deadline");
    expect(transport).not.toHaveBeenCalled();
    expect(network.events).toHaveLength(0);
    expect(group.image.source().kind).toBe("none");
  });
  it("exports the service and fetch adapter and reports absent endpoints", async () => {
    const { manager, group, profile, transport } = await setup();
    expect(group.image).toBeInstanceOf(GroupImageService);
    expect(typeof fetchGroupImageTransport).toBe("function");
    expect(await group.image.read({})).toEqual({
      kind: "unavailable",
      reason: "no-image",
    });
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    transport.mockClear();
    const emptyProfile: GroupImageProfile = { transport };
    expect(await group.image.read(emptyProfile)).toEqual({
      kind: "unavailable",
      reason: "endpoint-absent",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("bounds resolver work and rechecks the current caller policy before delivery", async () => {
    const { manager, group, profile } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(1),
      "image/png",
      profile,
    );
    const before = group.image.source();
    expect(
      await group.image.read({
        ...profile,
        endpoints: undefined,
        deadlineMs: 5,
        resolveEndpoints: () => new Promise(() => {}),
      }),
    ).toEqual({ kind: "unavailable", reason: "deadline" });
    let allowed = true;
    const transport = async (request: GroupImageTransportRequest) => {
      const response = await profile.transport(request);
      allowed = false;
      return response;
    };
    expect(
      await group.image.read({
        ...profile,
        transport,
        contactPolicy: () => allowed,
      }),
    ).toEqual({ kind: "unavailable", reason: "contact-denied" });
    expect(group.image.source()).toEqual(before);
  });
  it("keeps caller contact authorization separate from valid image state", async () => {
    const { manager, group, profile, transport } = await setup();
    await manager.replaceGroupImage(
      group.id,
      Uint8Array.of(9),
      "image/png",
      profile,
    );
    const before = group.image.source();
    transport.mockClear();
    const result = await group.image.read({
      ...profile,
      contactPolicy: () => false,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("unexpected image bytes");
    expect(result.reason).toBe("contact-denied");
    expect(transport).not.toHaveBeenCalled();
    expect(group.image.source()).toEqual(before);
  });
  it("replaces reads and clears through the real MLS lifecycle", async () => {
    const { manager, group, network, profile, transport } = await setup();
    expect(typeof manager.replaceGroupImage).toBe("function");
    const plaintext = Uint8Array.of(1, 2, 3, 4);
    const epoch = group.state.groupContext.epoch;
    const result = await manager.replaceGroupImage(
      group.id,
      plaintext,
      " IMAGE/JPG ; x=1",
      profile,
    );
    expect(result.kind).toBe("published");
    if (result.kind !== "published")
      throw new Error("publication result absent");
    expect(result.publications[0].work.kind).toBe("groupEvolution");
    expect(group.state.groupContext.epoch).toBe(epoch + 1n);
    expect(network.events).toHaveLength(1);
    const source = group.image.source();
    expect(source.kind).toBe("blossom");
    if (source.kind !== "blossom") throw new Error("image absent");
    expect(source.metadata.mediaType).toBe("image/jpeg");
    expect(transport.mock.calls[0]![0].body).not.toEqual(plaintext);
    expect(transport.mock.calls[0]![0].headers.Authorization).toMatch(
      /^Nostr /,
    );
    const read = await group.image.read(profile);
    expect(read).toEqual({
      kind: "available",
      bytes: plaintext,
      mediaType: "image/jpeg",
      snapshotIdentity: source.snapshotIdentity,
    });
    expect((await manager.clearGroupImage(group.id)).kind).toBe("published");
    expect(group.image.source()).toEqual({ kind: "none" });
    expect(group.state.groupContext.epoch).toBe(epoch + 2n);
    expect(transport.mock.calls.map(([request]) => request.method)).toEqual([
      "PUT",
      "GET",
    ]);
  });
});
