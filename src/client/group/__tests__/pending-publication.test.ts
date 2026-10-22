import { describe, expect, it, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { seamGroup } from "../../../__tests__/helpers/engine-seam-fixtures.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { deserializeClientState } from "../../../core/client-state.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { MarmotGroup } from "../marmot-group.js";
import { proposeUpdateMetadata } from "../proposals/update-metadata.js";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "../application-message.js";
import type { NostrEvent } from "applesauce-core/helpers/event";

async function setup() {
  const fixture = await seamGroup();
  const network = new MockNetwork();
  const options = {
    ciphersuite: fixture.impl,
    network,
    signer: testAccount(6).signer,
    store: new InMemoryKeyValueStore<Uint8Array>(),
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    rewindStore: new InMemoryKeyValueStore<Uint8Array>(),
  };
  const sender = new MarmotGroup(fixture.adminEpoch1, options);
  const peer = new MarmotGroup(fixture.admin2Epoch1, {
    ...options,
    signer: testAccount(0).signer,
    store: new InMemoryKeyValueStore<Uint8Array>(),
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    rewindStore: new InMemoryKeyValueStore<Uint8Array>(),
  });
  await sender.save(true);
  const proposals = await proposeUpdateMetadata({
    adminPubkeys: [fixture.adminPubkey],
  })(sender.session.proposalContext());
  const intent = {
    kind: "commit" as const,
    actorPubkey: fixture.adminPubkey,
    extraProposals: proposals,
  };
  return { sender, peer, options, intent, fixture, network };
}
async function ingest(group: MarmotGroup, events: NostrEvent[]) {
  const results = [];
  for await (const result of group.ingest(events)) results.push(result);
  return results;
}

describe("exact pending publication recovery", () => {
  it("keeps an ACK-uncertain admin commit gated, retries identical bytes, then catches up peer messages", async () => {
    const { sender, peer, intent, network } = await setup();
    let sent!: NostrEvent;
    const publish = vi
      .fn()
      .mockImplementationOnce(async (_relays, event) => {
        sent = event;
        return {
          "wss://relay.test": {
            from: "wss://relay.test",
            ok: false,
            uncertain: true,
            message: "lost OK",
          },
        };
      })
      .mockImplementation(async (_relays, event) => {
        expect(JSON.stringify(event)).toBe(JSON.stringify(sent));
        return { "wss://relay.test": { from: "wss://relay.test", ok: true } };
      });
    network.publish = publish;
    try {
      await expect(sender.submitIntent(intent)).rejects.toMatchObject({
        name: "PublicationUncertainError",
      });
      expect(sender.lifecycle).toBe("PendingPublish");
      expect(Number(sender.state.groupContext.epoch)).toBe(1);
      await ingest(peer, [sent]);
      const rumor = createChatRumor({
        pubkey: testAccount(0).pubkey,
        content: "after the admin commit",
      });
      const effects = await peer.session.send(
        createApplicationMessageIntent(rumor),
      );
      const message = effects.publish[0]!.envelope;
      await ingest(sender, [sent, message]);
      expect(Number(sender.state.groupContext.epoch)).toBe(1);
      const received: unknown[] = [];
      sender.on("ingestResult", (result) => received.push(result));
      await sender.retryPendingPublication();
      expect(Number(sender.state.groupContext.epoch)).toBe(2);
      expect(sender.groupData?.adminPubkeys).toEqual([testAccount(6).pubkey]);
      await vi.waitFor(() =>
        expect(received).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "processed",
              result: expect.objectContaining({ kind: "applicationMessage" }),
            }),
          ]),
        ),
      );
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      sender.session.dispose();
      peer.session.dispose();
    }
  });

  it("restores the pending gate across restart and republishes the original event", async () => {
    const { sender, peer, options, intent, network } = await setup();
    let sent!: NostrEvent;
    network.publish = async (_relays, event) => {
      sent = event;
      throw new Error("connection lost after send");
    };
    let restarted: MarmotGroup | undefined;
    try {
      await expect(sender.submitIntent(intent)).rejects.toMatchObject({
        name: "PublicationUncertainError",
      });
      sender.session.dispose();
      const prior = deserializeClientState(
        (await options.store.getItem(sender.idStr))!,
      );
      restarted = await MarmotGroup.fromClientState(prior, options);
      expect(restarted.lifecycle).toBe("PendingPublish");
      expect(Number(restarted.state.groupContext.epoch)).toBe(1);
      const publish = vi.fn(async (_relays, event) => {
        expect(JSON.stringify(event)).toBe(JSON.stringify(sent));
        return { "wss://relay.test": { from: "wss://relay.test", ok: true } };
      });
      network.publish = publish;
      await restarted.retryPendingPublication();
      expect(Number(restarted.state.groupContext.epoch)).toBe(2);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(bytesToHex(restarted.state.confirmationTag)).not.toBe(
        bytesToHex(prior.confirmationTag),
      );
      expect(
        (await options.rewindStore.keys()).some((k) =>
          k.endsWith("pending-publication/v1"),
        ),
      ).toBe(false);
    } finally {
      sender.session.dispose();
      restarted?.session.dispose();
      peer.session.dispose();
    }
  });

  it("resumes a durable ACK after restart without republishing or regenerating the commit", async () => {
    const { sender, peer, options, intent, network } = await setup();
    const confirm = vi
      .spyOn(sender.session, "confirmPublished")
      .mockImplementationOnce(() => {
        throw new Error("interrupted before apply");
      });
    const publish = vi.spyOn(network, "publish");
    let restarted: MarmotGroup | undefined;
    try {
      const [result] = await sender.submitIntent(intent);
      expect(result!.persistence.kind).toBe("failed");
      expect(Number(sender.state.groupContext.epoch)).toBe(1);
      sender.session.dispose();
      restarted = await MarmotGroup.fromClientState(
        deserializeClientState((await options.store.getItem(sender.idStr))!),
        options,
      );
      expect(restarted.lifecycle).toBe("PendingPublish");
      await restarted.retryPendingPublication();
      expect(Number(restarted.state.groupContext.epoch)).toBe(2);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      confirm.mockRestore();
      sender.session.dispose();
      restarted?.session.dispose();
      peer.session.dispose();
    }
  });

  it("shares concurrent retries and ignores cancellation after external publication began", async () => {
    const { sender, peer, intent, network } = await setup();
    const controller = new AbortController();
    network.publish = async () => {
      controller.abort();
      throw new Error("lost OK");
    };
    try {
      await expect(
        sender.submitIntent({ ...intent, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "PublicationUncertainError" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const publish = vi.fn(async () => {
        await gate;
        return { "wss://relay.test": { from: "wss://relay.test", ok: true } };
      });
      network.publish = publish;
      const a = sender.retryPendingPublication();
      const b = sender.retryPendingPublication();
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
      release();
      await Promise.all([a, b]);
      expect(Number(sender.state.groupContext.epoch)).toBe(2);
    } finally {
      sender.session.dispose();
      peer.session.dispose();
    }
  });

  it("rejects a corrupted recovery record before admitting a reloaded group", async () => {
    const { sender, peer, options, intent, network } = await setup();
    network.publish = async () => {
      throw new Error("lost OK");
    };
    try {
      await expect(sender.submitIntent(intent)).rejects.toMatchObject({
        name: "PublicationUncertainError",
      });
      const key = (await options.rewindStore.keys()).find((k) =>
        k.endsWith("pending-publication/v1"),
      )!;
      await options.rewindStore.setItem(
        key,
        new TextEncoder().encode('{"version":999}'),
      );
      sender.session.dispose();
      await expect(
        MarmotGroup.fromClientState(
          deserializeClientState((await options.store.getItem(sender.idStr))!),
          options,
        ),
      ).rejects.toThrow("Invalid pending publication record");
    } finally {
      sender.session.dispose();
      peer.session.dispose();
    }
  });

  it("does not turn an earlier uncertain send into failure merely because its retry is rejected", async () => {
    const { sender, peer, intent, network } = await setup();
    network.publish = async () => {
      throw new Error("lost OK");
    };
    try {
      await expect(sender.submitIntent(intent)).rejects.toMatchObject({
        name: "PublicationUncertainError",
      });
      network.publish = async () => ({
        "wss://relay.test": {
          from: "wss://relay.test",
          ok: false,
          message: "blocked",
        },
      });
      await expect(sender.retryPendingPublication()).rejects.toMatchObject({
        name: "PublicationUncertainError",
      });
      expect(sender.lifecycle).toBe("PendingPublish");
      expect(Number(sender.state.groupContext.epoch)).toBe(1);
    } finally {
      sender.session.dispose();
      peer.session.dispose();
    }
  });

  it("does not contact a relay if pending-state persistence fails", async () => {
    const { sender, peer, options, intent, network } = await setup();
    const set = options.rewindStore.setItem.bind(options.rewindStore);
    options.rewindStore.setItem = async (key, value) => {
      if (key.endsWith("pending-publication/v1")) throw new Error("disk full");
      return set(key, value);
    };
    const publish = vi.spyOn(network, "publish");
    try {
      await expect(sender.submitIntent(intent)).rejects.toThrow("disk full");
      expect(publish).not.toHaveBeenCalled();
      expect(sender.lifecycle).toBe("Stable");
    } finally {
      sender.session.dispose();
      peer.session.dispose();
    }
  });
});
