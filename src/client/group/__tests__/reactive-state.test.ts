import { describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  defaultProposalTypes,
  joinGroup,
  unsafeTestingAuthenticationService,
  type Welcome,
} from "ts-mls";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import {
  memoryDatabase,
  memoryGroupDatabase,
} from "../../../__tests__/helpers/database.js";
import { GroupsManager } from "../../groups-manager.js";
import { MarmotGroup, type MarmotGroupSnapshot } from "../marmot-group.js";
import { proposeUpdateMetadata } from "../proposals/update-metadata.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../../core/client-state.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { createCredential } from "../../../core/credential.js";

const account = testAccount(6);
async function owner() {
  const network = new MockNetwork();
  const manager = new GroupsManager({
    database: memoryDatabase(),
    signer: account.signer,
    network,
  });
  const group = await manager.create("Original", { relays: network.relayUrls });
  return { manager, group, network };
}

function record(group: MarmotGroup) {
  const snapshots: MarmotGroupSnapshot[] = [];
  group.on("changed", () => {
    const next = group.snapshot;
    expect(next).toBe(group.snapshot);
    expect(next.version).toBe(group.version);
    if (snapshots.length)
      expect(next.version).toBe(snapshots.at(-1)!.version + 1);
    snapshots.push(next);
  });
  return snapshots;
}

describe("reactive group state", () => {
  it("caches owned snapshots and observes publishing, metadata and member changes", async () => {
    const { manager, group } = await owner();
    const before = group.snapshot;
    expect(group.snapshot).toBe(before);
    expect(before.members).toEqual([account.pubkey]);
    expect(before.groupData).not.toBe(group.groupData);
    expect(Object.isFrozen(before.groupData?.adminPubkeys)).toBe(true);
    const snapshots = record(group);
    await manager.commit(group.id, {
      extraProposals: [
        proposeUpdateMetadata({ name: "Renamed", description: "Description" }),
      ],
    });
    expect(group.snapshot.groupData?.name).toBe("Renamed");
    expect(before.groupData?.name).toBe("Original");
    expect(snapshots.map((s) => s.lifecycle)).toEqual(
      expect.arrayContaining(["PendingPublish", "Merging", "Stable"]),
    );
    // One MLS metadata change, even though publication has multiple UI states.
    expect(
      snapshots.filter(
        (s, i) =>
          s.groupData?.name === "Renamed" &&
          (i === 0 || snapshots[i - 1]!.groupData?.name !== "Renamed"),
      ),
    ).toHaveLength(1);
    const member = testAccount(9);
    const kp = await generateKeyPackage({
      credential: createCredential(member.pubkey),
      ciphersuiteImpl: group.ciphersuite,
      signer: member.signer,
    });
    await manager.commit(group.id, {
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: kp.publicPackage },
        },
      ],
    });
    expect(group.snapshot.members).toContain(member.pubkey);
    await manager.commit(group.id, {
      extraProposals: [
        proposeUpdateMetadata({
          adminPubkeys: [account.pubkey, member.pubkey],
          encryptedMedia: {
            mediaFormat: "encrypted-media-v2",
            allowedLocatorKinds: ["blossom"],
            defaultBlobEndpoints: [
              { locatorKind: "blossom", baseUrl: "https://blobs.test" },
            ],
          },
        }),
      ],
    });
    expect(group.snapshot.groupData?.adminPubkeys).toContain(member.pubkey);
    expect(group.snapshot.groupData?.encryptedMedia).toBeDefined();
    await manager.commit(group.id, {
      extraProposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: 1 } },
      ],
    });
    expect(group.snapshot.members).toEqual([account.pubkey]);
    expect(group.snapshot).toBe(group.snapshot);
    await manager.unload(group.id);
  });

  it("publishes timer-only settlement and coalesces watcher updates", async () => {
    const { manager, group } = await owner();
    let now = 100;
    let timer: (() => void) | undefined;
    const target = new MarmotGroup(
      deserializeClientState(serializeClientState(group.state)),
      {
        database: memoryGroupDatabase(),
        signer: account.signer,
        ciphersuite: group.ciphersuite,
        network: new MockNetwork(),
        now: () => now,
        settlementQuiescenceMs: 100,
        scheduler: {
          setTimer(_ms, cb) {
            timer = cb;
            return cb;
          },
          clearTimer() {
            timer = undefined;
          },
        },
      },
    );
    const changes = record(target);
    const watcher = target.watch();
    expect((await watcher.next()).value).toBe(target.snapshot);
    const effects = await group.session.send({
      kind: "commit",
      actorPubkey: account.pubkey,
      extraProposals: [proposeUpdateMetadata({ name: "Inbound" })],
    });
    const work = effects.publish[0]!;
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    for await (const result of target.ingest([work.envelope])) void result;
    expect(target.snapshot.convergenceStatus).toBe("Syncing");
    expect((await watcher.next()).value).toBe(target.snapshot);
    const waiting = watcher.next();
    now = 200;
    expect(timer).toBeDefined();
    timer!();
    expect((await waiting).value?.convergenceStatus).toBe("Settled");
    expect(changes.some((s) => s.convergenceStatus === "Settled")).toBe(true);
    await watcher.return(undefined);
    target.dispose();
    await manager.unload(group.id);
  });

  it("publishes removal from a real inbound commit", async () => {
    const { manager, group } = await owner();
    const member = testAccount(9);
    const kp = await generateKeyPackage({
      credential: createCredential(member.pubkey),
      ciphersuiteImpl: group.ciphersuite,
      signer: member.signer,
    });
    const added = await group.session.send({
      kind: "commit",
      actorPubkey: account.pubkey,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: kp.publicPackage },
        },
      ],
    });
    const work = added.publish[0]!;
    if (work.kind !== "groupEvolution" || !work.welcome)
      throw new Error("expected Welcome");
    const state = await joinGroup({
      context: {
        cipherSuite: group.ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: work.welcome.welcome!,
      keyPackage: kp.publicPackage,
      privateKeys: kp.privatePackage,
      ratchetTree: undefined,
    });
    await group.session.confirmPublished(work.pending);
    const target = new MarmotGroup(state, {
      database: memoryGroupDatabase(),
      signer: member.signer,
      ciphersuite: group.ciphersuite,
      network: new MockNetwork(),
    });
    const snapshots = record(target);
    const watcher = target.watch();
    await watcher.next();
    const removed = await group.session.send({
      kind: "commit",
      actorPubkey: account.pubkey,
      extraProposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: 1 } },
      ],
    });
    const removal = removed.publish[0]!;
    for await (const result of target.ingest([removal.envelope])) void result;
    expect(target.snapshot.status).toBe("removed");
    expect((await watcher.next()).value?.status).toBe("removed");
    expect(
      snapshots.filter(
        (s, i) =>
          s.status === "removed" &&
          (i === 0 || snapshots[i - 1]!.status !== "removed"),
      ),
    ).toHaveLength(1);
    await watcher.return(undefined);
    target.dispose();
    await manager.unload(group.id);
  });

  it("delivers the disbanded snapshot before disposal ends the watcher", async () => {
    const { manager, group } = await owner();
    const watcher = group.watch();
    await watcher.next();
    const snapshots = record(group);
    await group.session.persistSelectedDisband({
      actorPubkey: account.pubkey,
      commitDigest: new Uint8Array(32).fill(7),
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });
    await group.realizeDisbandIfNeeded();
    expect(group.closedSignal.aborted).toBe(true);
    expect((await watcher.next()).value).toMatchObject({
      status: "disbanded",
      groupData: null,
      members: [],
    });
    expect(manager.snapshot[0]).toBe(group.snapshot);
    expect(
      snapshots.filter(
        (s, i) =>
          s.status === "disbanded" &&
          (i === 0 || snapshots[i - 1]!.status !== "disbanded"),
      ),
    ).toHaveLength(1);
    const waiting = watcher.next();
    group.dispose();
    expect((await waiting).done).toBe(true);
    await manager.unload(group.id);
  });

  it.each(["return", "abort", "dispose", "destroy"] as const)(
    "cleans up an outstanding next on %s",
    async (end) => {
      const { manager, group } = await owner();
      const baseline = group.listenerCount("changed");
      const controller = new AbortController();
      const watcher = group.watch({ signal: controller.signal });
      await watcher.next();
      expect(group.listenerCount("changed")).toBe(baseline + 1);
      const waiting = watcher.next();
      if (end === "return") await watcher.return(undefined);
      if (end === "abort") controller.abort();
      if (end === "dispose") group.dispose();
      if (end === "destroy") await group.destroy();
      expect((await waiting).done).toBe(true);
      expect(group.listenerCount("changed")).toBeLessThanOrEqual(baseline);
      if (end === "dispose" || end === "destroy")
        expect((await group.watch().next()).done).toBe(true);
      await manager.unload(group.id);
    },
  );

  it("notifies Welcome failures and retries without changing MLS state", async () => {
    const { manager, group } = await owner();
    const recipient = {
      pubkey: testAccount(9).pubkey,
      keyPackageEventId: "a".repeat(64),
      keyPackageEvent: {} as NostrEvent,
    };
    const welcome: Welcome = {
      cipherSuite: 1,
      secrets: [],
      encryptedGroupInfo: new Uint8Array([1]),
    };
    vi.spyOn(group.runtime.welcomeDelivery, "deliverMany")
      .mockResolvedValueOnce([{ kind: "failed", recipient, error: "offline" }])
      .mockResolvedValueOnce([{ kind: "succeeded", recipient, response: {} }]);
    const snapshots = record(group);
    await group.deliverFoundingWelcomes({
      welcome,
      author: account.pubkey,
      recipients: [recipient],
    });
    expect(group.snapshot.pendingWelcomes).toHaveLength(1);
    const failed = group.snapshot;
    await group.retryWelcome(recipient.pubkey);
    expect(group.snapshot.pendingWelcomes).toHaveLength(0);
    expect(failed.pendingWelcomes).toHaveLength(1);
    expect(snapshots).toHaveLength(2);
    await manager.unload(group.id);
  });

  it("aggregates loaded snapshots without storage reads and preserves default watch behavior", async () => {
    const { manager, group } = await owner();
    const other = await manager.create("Other", {
      relays: ["wss://relay.test"],
    });
    const before = manager.snapshot;
    const otherBefore = other.snapshot;
    expect(manager.snapshot).toBe(before);
    const load = vi.spyOn(manager, "loadAll");
    const baseline = manager.listenerCount("changed");
    const controller = new AbortController();
    const watcher = manager.watch({
      includeStateChanges: true,
      signal: controller.signal,
    });
    expect((await watcher.next()).value).toEqual([group, other]);
    expect(load).not.toHaveBeenCalled();
    const legacy = manager.watch();
    await legacy.next();
    expect(load).toHaveBeenCalledOnce();
    const updated = vi.fn();
    manager.on("updated", updated);
    const changes = vi.fn();
    manager.on("changed", changes);
    const waiting = watcher.next();
    await manager.commit(group.id, {
      extraProposals: [proposeUpdateMetadata({ name: "New" })],
    });
    expect((await waiting).value).toContain(group);
    expect(manager.snapshot).not.toBe(before);
    expect(manager.snapshot.find((s) => s.id === other.idStr)).toBe(
      otherBefore,
    );
    expect(changes).toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
    await watcher.next();
    const pending = watcher.next();
    controller.abort();
    expect((await pending).done).toBe(true);
    manager.off("changed", changes);
    expect(manager.listenerCount("changed")).toBe(baseline);
    await legacy.return(undefined);
    await manager.unload(group.id);
    expect(group.listenerCount("changed")).toBe(0);
    expect(group.listenerCount("disposed")).toBe(0);
    expect(manager.snapshot).toEqual([other.snapshot]);
    await manager.unload(other.id);
  });
});
