import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  unlockGiftWrap,
  type Rumor,
} from "applesauce-common/helpers/gift-wrap";
import {
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { validateRatchetTree } from "ts-mls/clientState.js";
import { defaultLifetimeConfig } from "ts-mls/lifetimeConfig.js";
import { nodeTypes } from "ts-mls/nodeType.js";
import {
  leafWidth,
  directPath,
  leafToNodeIndex,
  toLeafIndex,
} from "ts-mls/treemath.js";
import { describe, expect, it } from "vitest";

import { MarmotClient } from "../client/marmot-client.js";
import { createCredential } from "../core/credential.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { GROUP_EVENT_KIND, KEY_PACKAGE_KIND } from "../core/protocol.js";
import { readWelcomeGroupInfo } from "../core/welcome.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { KeyValueGroupStateBackend } from "../store/adapters/key-value-group-state-backend.js";
import { MemoryBackend } from "./ingest-commit-race.test.js";
import { ScriptedMockNetwork } from "./helpers/scripted-mock-network.js";

type Variant = "V1" | "V2" | "V3";

type RunResult = { ok: boolean; error?: string };

async function createClient(
  account: PrivateKeyAccount<any>,
  network: ScriptedMockNetwork,
) {
  return new MarmotClient({
    groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
    keyPackageStore: new KeyPackageStore(new MemoryBackend()),
    signer: account.signer,
    network,
  });
}

async function getGiftWrapFor(
  network: ScriptedMockNetwork,
  recipientPubkey: string,
) {
  const giftwraps = await network.request(["wss://mock-inbox.test"], {
    kinds: [1059],
    "#p": [recipientPubkey],
  });
  return giftwraps[giftwraps.length - 1];
}

async function drainGroupIngestFromNetwork(
  group: {
    ingest: (events: any[]) => AsyncGenerator<any>;
    groupData: { nostrGroupId: Uint8Array };
  },
  network: ScriptedMockNetwork,
) {
  const groupEvents = await network.request(["wss://mock-relay.test"], {
    kinds: [GROUP_EVENT_KIND],
    "#h": [Buffer.from(group.groupData.nostrGroupId).toString("hex")],
  });
  for await (const _ of group.ingest(groupEvents)) {
    // drain iterator
  }
}

async function setupTwoAdminGroup() {
  const network = new ScriptedMockNetwork();

  const adminA = PrivateKeyAccount.generateNew();
  const adminB = PrivateKeyAccount.generateNew();
  const inviteeC = PrivateKeyAccount.generateNew();

  const clientA = await createClient(adminA, network);
  const clientB = await createClient(adminB, network);
  const clientC = await createClient(inviteeC, network);

  const adminBPubkey = await adminB.signer.getPublicKey();
  const inviteeCPubkey = await inviteeC.signer.getPublicKey();

  await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();

  const groupA = await clientA.createGroup("drift-r1", {
    adminPubkeys: [adminBPubkey],
    relays: ["wss://mock-relay.test"],
  });

  const keyPkgB = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
  );
  if (!keyPkgB)
    throw new Error("R1 setup failed: missing key package event for admin B");

  await groupA.inviteByKeyPackageEvent(keyPkgB);
  network.stepAll();

  const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
  if (!giftwrapB)
    throw new Error("R1 setup failed: missing welcome giftwrap for admin B");

  const rumorB = (await unlockGiftWrap(giftwrapB, adminB.signer)) as Rumor;
  const { group: groupB } = await clientB.joinGroupFromWelcome({
    welcomeRumor: rumorB,
  });

  return {
    network,
    adminA,
    adminB,
    inviteeC,
    clientA,
    clientB,
    clientC,
    groupA,
    groupB,
    inviteeCPubkey,
  };
}

function treeFingerprint(state: {
  ratchetTree: any[];
  groupContext: { epoch: bigint };
}): string {
  const parents = state.ratchetTree
    .map((node, i) => {
      if (!node || node.nodeType !== nodeTypes.parent) return null;
      const leaves = node.parent.unmergedLeaves ?? [];
      return `${i}[${leaves.map((x: number) => Number(x)).join(",")}]`;
    })
    .filter(Boolean)
    .join("|");
  return `epoch=${state.groupContext.epoch};parents=${parents}`;
}

async function inspectWelcomeTree(options: {
  client: MarmotClient;
  welcomeRumor: Rumor;
}): Promise<string> {
  const ciphersuiteImpl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const keyPackages = await options.client.keyPackages.list();
  for (const pkg of keyPackages) {
    const full = await options.client.keyPackages.get(pkg.keyPackageRef);
    if (!full?.privatePackage) continue;
    try {
      const groupInfo = await readWelcomeGroupInfo({
        welcome: options.welcomeRumor,
        keyPackage: {
          publicPackage: full.publicPackage,
          privatePackage: full.privatePackage,
        },
        ciphersuiteImpl,
      });
      return `welcome-epoch=${groupInfo.groupContext.epoch};extensions=${groupInfo.groupContext.extensions.length}`;
    } catch {
      // try next key package
    }
  }
  return "welcome-inspection=unavailable";
}

async function runR1(variant: Variant): Promise<RunResult> {
  const {
    network,
    clientA,
    clientB,
    clientC,
    groupA,
    groupB,
    inviteeC,
    inviteeCPubkey,
  } = await setupTwoAdminGroup();

  await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();

  const keyPkgC = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeCPubkey,
  );
  if (!keyPkgC)
    throw new Error("R1 setup failed: missing key package event for invitee C");

  const publishCut = network.events.length;

  await groupA.inviteByKeyPackageEvent(keyPkgC);
  await groupB.selfUpdate();

  const raceEvents = network.events.slice(publishCut);
  const raceCommits = raceEvents.filter((e) => e.kind === GROUP_EVENT_KIND);
  const commitA = raceCommits[0];
  const commitB = raceCommits[1];
  const welcomeC = raceEvents.find(
    (e) =>
      e.kind === 1059 &&
      e.tags.some((t) => t[0] === "p" && t[1] === inviteeCPubkey),
  );

  if (!commitA || !commitB || !welcomeC) {
    throw new Error(
      `R1 setup failed: race window events not found. commits=${raceCommits.length} adminACommit=${Boolean(
        commitA,
      )} secondCommit=${Boolean(commitB)} welcomeC=${Boolean(welcomeC)} events=${JSON.stringify(
        raceEvents.map((e) => ({
          id: e.id,
          kind: e.kind,
          pubkey: e.pubkey.slice(0, 16),
          p: e.tags.filter((t) => t[0] === "p").map((t) => t[1].slice(0, 16)),
        })),
      )}`,
    );
  }

  if (variant === "V1") {
    network.stepWhere((e) => e.id === commitA.id);
    network.stepWhere((e) => e.id === welcomeC.id);
    network.stepWhere((e) => e.id === commitB.id);
  } else if (variant === "V2") {
    network.stepWhere((e) => e.id === commitB.id);
    network.stepWhere((e) => e.id === welcomeC.id);
    network.stepWhere((e) => e.id === commitA.id);
  } else {
    network.stepWhere((e) => e.id === welcomeC.id);
    network.stepWhere((e) => e.id === commitB.id);
    network.stepWhere((e) => e.id === commitA.id);
  }

  const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
  if (!giftwrapC) {
    throw new Error(`R1 ${variant}: welcome was not visible to invitee C`);
  }

  const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
  const fpA = treeFingerprint(groupA.state as any);
  const fpB = treeFingerprint(groupB.state as any);
  const welcomeFp = await inspectWelcomeTree({
    client: clientC as any,
    welcomeRumor: rumorC,
  });

  try {
    await clientC.joinGroupFromWelcome({ welcomeRumor: rumorC });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)} | ${fpA} | ${fpB} | ${welcomeFp}`,
    };
  }
}

async function runR2(staleDepth: 1 | 2): Promise<RunResult> {
  const {
    network,
    clientA,
    clientB,
    clientC,
    groupA,
    groupB,
    inviteeC,
    inviteeCPubkey,
  } = await setupTwoAdminGroup();

  // B advances the group while A remains stale.
  for (let i = 0; i < staleDepth; i++) {
    await groupB.selfUpdate();
  }

  await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();

  const keyPkgC = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeCPubkey,
  );
  if (!keyPkgC)
    throw new Error("R2 setup failed: missing key package event for invitee C");

  // A produces welcome from stale state view.
  await groupA.inviteByKeyPackageEvent(keyPkgC);
  network.stepAll();

  const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
  if (!giftwrapC)
    throw new Error("R2 setup failed: missing welcome giftwrap for invitee C");

  const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
  try {
    await clientC.joinGroupFromWelcome({ welcomeRumor: rumorC });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runR3(variant: Variant): Promise<RunResult> {
  const network = new ScriptedMockNetwork();

  const adminA = PrivateKeyAccount.generateNew();
  const adminB = PrivateKeyAccount.generateNew();
  const inviteeC = PrivateKeyAccount.generateNew();
  const inviteeD = PrivateKeyAccount.generateNew();

  const clientA = await createClient(adminA, network);
  const clientB = await createClient(adminB, network);
  const clientC = await createClient(inviteeC, network);
  const clientD = await createClient(inviteeD, network);

  const adminBPubkey = await adminB.signer.getPublicKey();
  const inviteeCPubkey = await inviteeC.signer.getPublicKey();
  const inviteeDPubkey = await inviteeD.signer.getPublicKey();

  await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();

  const groupA = await clientA.createGroup("drift-r3", {
    adminPubkeys: [adminBPubkey],
    relays: ["wss://mock-relay.test"],
  });

  const keyPkgB = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
  );
  if (!keyPkgB)
    throw new Error("R3 setup failed: missing key package event for admin B");

  await groupA.inviteByKeyPackageEvent(keyPkgB);
  network.stepAll();

  const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
  if (!giftwrapB)
    throw new Error("R3 setup failed: missing welcome for admin B");
  const rumorB = (await unlockGiftWrap(giftwrapB, adminB.signer)) as Rumor;
  const { group: groupB } = await clientB.joinGroupFromWelcome({
    welcomeRumor: rumorB,
  });

  await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();

  const keyPkgC = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeCPubkey,
  );
  const keyPkgD = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeDPubkey,
  );
  if (!keyPkgC || !keyPkgD)
    throw new Error("R3 setup failed: missing invitee key package(s)");

  const publishCut = network.events.length;
  await groupA.inviteByKeyPackageEvent(keyPkgC);
  await groupB.inviteByKeyPackageEvent(keyPkgD);

  const raceEvents = network.events.slice(publishCut);
  const cWelcome = raceEvents.find(
    (e) =>
      e.kind === 1059 &&
      e.tags.some((t) => t[0] === "p" && t[1] === inviteeCPubkey),
  );
  const dWelcome = raceEvents.find(
    (e) =>
      e.kind === 1059 &&
      e.tags.some((t) => t[0] === "p" && t[1] === inviteeDPubkey),
  );
  const commits = raceEvents.filter((e) => e.kind === GROUP_EVENT_KIND);
  if (!cWelcome || !dWelcome || commits.length < 2) {
    throw new Error("R3 setup failed: overlapping race events missing");
  }

  if (variant === "V1") {
    network.stepWhere((e) => e.id === commits[0]!.id);
    network.stepWhere((e) => e.id === cWelcome.id);
    network.stepWhere((e) => e.id === commits[1]!.id);
    network.stepWhere((e) => e.id === dWelcome.id);
  } else if (variant === "V2") {
    network.stepWhere((e) => e.id === commits[1]!.id);
    network.stepWhere((e) => e.id === dWelcome.id);
    network.stepWhere((e) => e.id === commits[0]!.id);
    network.stepWhere((e) => e.id === cWelcome.id);
  } else {
    network.stepWhere((e) => e.id === cWelcome.id);
    network.stepWhere((e) => e.id === dWelcome.id);
    network.stepWhere((e) => e.id === commits[0]!.id);
    network.stepWhere((e) => e.id === commits[1]!.id);
  }

  const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
  if (!giftwrapC) throw new Error("R3 setup failed: welcome for C not visible");

  const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
  try {
    await clientC.joinGroupFromWelcome({ welcomeRumor: rumorC });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runR1BranchDriftSweep(params: {
  aSelfUpdates: number;
  bSelfUpdates: number;
  releaseOrder:
    | "welcome-first"
    | "a-then-welcome-then-b"
    | "b-then-welcome-then-a";
}): Promise<RunResult> {
  const { network, clientC, groupA, groupB, inviteeC, inviteeCPubkey } =
    await setupTwoAdminGroup();

  // Build divergent local branches before invite by committing without releasing
  // events to the other admin.
  for (let i = 0; i < params.aSelfUpdates; i++) {
    await groupA.selfUpdate();
  }
  for (let i = 0; i < params.bSelfUpdates; i++) {
    await groupB.selfUpdate();
  }

  await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();
  const keyPkgC = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeCPubkey,
  );
  if (!keyPkgC) {
    throw new Error(
      "R1 branch drift setup failed: missing key package event for invitee C",
    );
  }

  const publishCut = network.events.length;
  await groupA.inviteByKeyPackageEvent(keyPkgC);
  await groupB.selfUpdate();

  const raceEvents = network.events.slice(publishCut);
  const commits = raceEvents.filter((e) => e.kind === GROUP_EVENT_KIND);
  const welcome = raceEvents.find(
    (e) =>
      e.kind === 1059 &&
      e.tags.some((t) => t[0] === "p" && t[1] === inviteeCPubkey),
  );
  if (!welcome || commits.length < 2) {
    throw new Error("R1 branch drift setup failed: missing race events");
  }

  if (params.releaseOrder === "welcome-first") {
    network.stepWhere((e) => e.id === welcome.id);
    network.stepWhere((e) => e.id === commits[0]!.id);
    network.stepWhere((e) => e.id === commits[1]!.id);
  } else if (params.releaseOrder === "a-then-welcome-then-b") {
    network.stepWhere((e) => e.id === commits[0]!.id);
    network.stepWhere((e) => e.id === welcome.id);
    network.stepWhere((e) => e.id === commits[1]!.id);
  } else {
    network.stepWhere((e) => e.id === commits[1]!.id);
    network.stepWhere((e) => e.id === welcome.id);
    network.stepWhere((e) => e.id === commits[0]!.id);
  }

  const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
  if (!giftwrapC) {
    throw new Error(
      "R1 branch drift setup failed: welcome not visible for invitee C",
    );
  }
  const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;

  try {
    await clientC.joinGroupFromWelcome({ welcomeRumor: rumorC });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runR5RealWorldSequence(): Promise<RunResult> {
  const signature =
    "non-blank intermediate node must list leaf node in its unmerged_leaves";

  const network = new ScriptedMockNetwork();

  const adminA = PrivateKeyAccount.generateNew();
  const adminB = PrivateKeyAccount.generateNew();
  const buggyC = PrivateKeyAccount.generateNew();
  const inviteeD = PrivateKeyAccount.generateNew();

  const clientA = await createClient(adminA, network);
  const clientB = await createClient(adminB, network);
  const clientC = await createClient(buggyC, network);
  const clientD = await createClient(inviteeD, network);

  const adminBPubkey = await adminB.signer.getPublicKey();
  const buggyCPubkey = await buggyC.signer.getPublicKey();
  const inviteeDPubkey = await inviteeD.signer.getPublicKey();

  // 1) A creates group and invites B admin.
  await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();
  const groupA = await clientA.createGroup("drift-r5", {
    adminPubkeys: [adminBPubkey, buggyCPubkey],
    relays: ["wss://mock-relay.test"],
  });
  const keyPkgB = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
  );
  if (!keyPkgB)
    throw new Error("R5 setup failed: missing key package for admin B");
  await groupA.inviteByKeyPackageEvent(keyPkgB);
  const keyPkgCAdmin = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === buggyCPubkey,
  );
  if (!keyPkgCAdmin)
    throw new Error("R5 setup failed: missing key package for admin C");
  await groupA.inviteByKeyPackageEvent(keyPkgCAdmin);
  network.stepAll();
  const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
  if (!giftwrapB)
    throw new Error("R5 setup failed: missing welcome for admin B");
  const rumorB = (await unlockGiftWrap(giftwrapB, adminB.signer)) as Rumor;
  const { group: groupB } = await clientB.joinGroupFromWelcome({
    welcomeRumor: rumorB,
  });

  // 2) Buggy C joins as admin and sends traffic.
  const giftwrapC = await getGiftWrapFor(network, buggyCPubkey);
  if (!giftwrapC)
    throw new Error("R5 setup failed: missing welcome for buggy C");
  const rumorC = (await unlockGiftWrap(giftwrapC, buggyC.signer)) as Rumor;
  const { group: groupC } = await clientC.joinGroupFromWelcome({
    welcomeRumor: rumorC,
  });

  await groupC.selfUpdate();
  await groupA.selfUpdate();
  await groupB.selfUpdate();

  // 3) Simulate buggy aggressive self-update fork by corrupting C local direct-path metadata.
  const tree = groupC.state.ratchetTree;
  let mutated = false;
  for (let nodeIndex = 0; nodeIndex < tree.length && !mutated; nodeIndex++) {
    const node = tree[nodeIndex];
    if (node?.nodeType !== nodeTypes.leaf) continue;
    const leafIndex = toLeafIndex(Math.floor(nodeIndex / 2));
    const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
    if (dp.length < 2) continue;

    const firstIdx = dp[0]!;
    const secondIdx = dp[1]!;

    if (tree[firstIdx]?.nodeType !== nodeTypes.parent) {
      tree[firstIdx] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((firstIdx % 251) + 1),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }
    if (tree[secondIdx]?.nodeType !== nodeTypes.parent) {
      tree[secondIdx] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((secondIdx % 251) + 2),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }

    const firstParent = tree[firstIdx];
    const secondParent = tree[secondIdx];
    if (firstParent?.nodeType !== nodeTypes.parent) continue;
    if (secondParent?.nodeType !== nodeTypes.parent) continue;

    firstParent.parent.unmergedLeaves = [leafIndex];
    secondParent.parent.unmergedLeaves = [];
    mutated = true;
  }

  if (!mutated)
    throw new Error("R5 setup failed: could not mutate buggy C tree");

  // 4) Buggy C now invites D from divergent state; D should naturally fail on join.
  await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
  network.stepAll();
  const keyPkgD = network.events.find(
    (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeDPubkey,
  );
  if (!keyPkgD)
    throw new Error("R5 setup failed: missing key package for invitee D");

  await groupC.inviteByKeyPackageEvent(keyPkgD);
  network.stepAll();

  const giftwrapD = await getGiftWrapFor(network, inviteeDPubkey);
  if (!giftwrapD)
    throw new Error("R5 setup failed: missing welcome for invitee D");
  const rumorD = (await unlockGiftWrap(giftwrapD, inviteeD.signer)) as Rumor;

  try {
    await clientD.joinGroupFromWelcome({ welcomeRumor: rumorD });
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg.includes(signature) ? msg : msg };
  }
}

function forceDirectPathUnmergedLeafDivergence(tree: any[]): boolean {
  let mutated = false;
  for (let nodeIndex = 0; nodeIndex < tree.length && !mutated; nodeIndex++) {
    const node = tree[nodeIndex];
    if (node?.nodeType !== nodeTypes.leaf) continue;
    const leafIndex = toLeafIndex(Math.floor(nodeIndex / 2));
    const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
    if (dp.length < 2) continue;

    const firstIdx = dp[0]!;
    const secondIdx = dp[1]!;

    if (tree[firstIdx]?.nodeType !== nodeTypes.parent) {
      tree[firstIdx] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((firstIdx % 251) + 1),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }
    if (tree[secondIdx]?.nodeType !== nodeTypes.parent) {
      tree[secondIdx] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((secondIdx % 251) + 2),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }

    const firstParent = tree[firstIdx];
    const secondParent = tree[secondIdx];
    if (firstParent?.nodeType !== nodeTypes.parent) continue;
    if (secondParent?.nodeType !== nodeTypes.parent) continue;

    firstParent.parent.unmergedLeaves = [leafIndex];
    secondParent.parent.unmergedLeaves = [];
    mutated = true;
  }

  return mutated;
}

describe("Invite-join drift deterministic reproduction matrix", () => {
  it.each(["V1", "V2", "V3"] as const)(
    "R1 variant %s is deterministic across repeated runs",
    async (variant) => {
      const runA = await runR1(variant);
      const runB = await runR1(variant);

      expect(runA.ok).toBe(runB.ok);
      expect(runA.error ?? null).toBe(runB.error ?? null);
    },
  );

  it.each([1, 2] as const)(
    "R2 stale producer depth %i is deterministic across repeated runs",
    async (depth) => {
      const runA = await runR2(depth);
      const runB = await runR2(depth);

      expect(runA.ok).toBe(runB.ok);
      expect(runA.error ?? null).toBe(runB.error ?? null);
    },
  );

  it.each(["V1", "V2", "V3"] as const)(
    "R3 variant %s is deterministic across repeated runs",
    async (variant) => {
      const runA = await runR3(variant);
      const runB = await runR3(variant);

      expect(runA.ok).toBe(runB.ok);
      expect(runA.error ?? null).toBe(runB.error ?? null);
    },
  );

  it("scan matrix for invariant failure signature (diagnostic sweep)", async () => {
    const signature =
      "non-blank intermediate node must list leaf node in its unmerged_leaves";

    const outcomes: string[] = [];

    for (let round = 0; round < 3; round++) {
      for (const variant of ["V1", "V2", "V3"] as const) {
        const r1 = await runR1(variant);
        outcomes.push(
          `round=${round};R1-${variant}:${r1.ok ? "ok" : r1.error}`,
        );
      }

      for (const depth of [1, 2] as const) {
        const r2 = await runR2(depth);
        outcomes.push(`round=${round};R2-${depth}:${r2.ok ? "ok" : r2.error}`);
      }

      for (const variant of ["V1", "V2", "V3"] as const) {
        const r3 = await runR3(variant);
        outcomes.push(
          `round=${round};R3-${variant}:${r3.ok ? "ok" : r3.error}`,
        );
      }
    }

    const hits = outcomes.filter((o) => o.includes(signature));

    // Deterministic sweep currently serves as a probe and should execute without
    // harness flakiness. We intentionally don't require hits yet.
    expect(Array.isArray(hits)).toBe(true);
  }, 20000);

  it("stress branch-drift schedules and probe invariant signature", async () => {
    const signature =
      "non-blank intermediate node must list leaf node in its unmerged_leaves";
    const outcomes: string[] = [];

    for (const aDepth of [0, 1, 2] as const) {
      for (const bDepth of [0, 1, 2] as const) {
        for (const releaseOrder of [
          "welcome-first",
          "a-then-welcome-then-b",
          "b-then-welcome-then-a",
        ] as const) {
          const res = await runR1BranchDriftSweep({
            aSelfUpdates: aDepth,
            bSelfUpdates: bDepth,
            releaseOrder,
          });
          outcomes.push(
            `a=${aDepth};b=${bDepth};order=${releaseOrder};result=${res.ok ? "ok" : res.error}`,
          );
        }
      }
    }

    const hits = outcomes.filter((x) => x.includes(signature));
    expect(Array.isArray(hits)).toBe(true);
  }, 30000);

  it("R4 simulated buggy self-update client shows fork symptoms and invariant-class failure", async () => {
    const signature =
      "non-blank intermediate node must list leaf node in its unmerged_leaves";

    const {
      network,
      clientA,
      clientB,
      clientC,
      groupA,
      groupB,
      inviteeC,
      inviteeCPubkey,
    } = await setupTwoAdminGroup();

    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgC = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeCPubkey,
    );
    if (!keyPkgC)
      throw new Error("R4 setup failed: missing key package for invitee C");

    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
    if (!giftwrapC)
      throw new Error("R4 setup failed: missing welcome for invitee C");

    const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
    const { group: groupC } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    // Simulate the known buggy implementation behavior by forcing direct-path
    // unmergedLeaves divergence on C's local state after join.
    const tree = groupC.state.ratchetTree;
    let mutated = false;
    for (let nodeIndex = 0; nodeIndex < tree.length && !mutated; nodeIndex++) {
      const node = tree[nodeIndex];
      if (node?.nodeType !== nodeTypes.leaf) continue;
      const leafIndex = toLeafIndex(Math.floor(nodeIndex / 2));
      const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
      if (dp.length < 2) continue;
      const firstIdx = dp[0]!;
      const secondIdx = dp[1]!;

      if (tree[firstIdx]?.nodeType !== nodeTypes.parent) {
        tree[firstIdx] = {
          nodeType: nodeTypes.parent,
          parent: {
            hpkePublicKey: new Uint8Array(32).fill((firstIdx % 251) + 1),
            parentHash: new Uint8Array(),
            unmergedLeaves: [],
          },
        };
      }
      if (tree[secondIdx]?.nodeType !== nodeTypes.parent) {
        tree[secondIdx] = {
          nodeType: nodeTypes.parent,
          parent: {
            hpkePublicKey: new Uint8Array(32).fill((secondIdx % 251) + 2),
            parentHash: new Uint8Array(),
            unmergedLeaves: [],
          },
        };
      }

      const firstParent = tree[firstIdx];
      const secondParent = tree[secondIdx];
      if (firstParent?.nodeType !== nodeTypes.parent) continue;
      if (secondParent?.nodeType !== nodeTypes.parent) continue;
      firstParent.parent.unmergedLeaves = [leafIndex];
      secondParent.parent.unmergedLeaves = [];
      mutated = true;
    }

    expect(mutated).toBe(true);

    // Validate the exact invariant-class failure on the mutated (buggy) client state.
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const treeErr = await validateRatchetTree(
      groupC.state.ratchetTree,
      groupC.state.groupContext,
      defaultLifetimeConfig,
      unsafeTestingAuthenticationService,
      groupC.state.groupContext.treeHash,
      ciphersuiteImpl,
    );
    expect(treeErr?.message ?? "").toContain(signature);

    // A buggy client may still emit events while effectively forked from peers.
    // We don't assert selfUpdate failure here because validation timing differs by flow.
    await groupC.selfUpdate();

    // Ensure healthy peers are still operating, emphasizing mixed-implementation drift.
    await expect(groupA.selfUpdate()).resolves.toBeDefined();
    await expect(groupB.selfUpdate()).resolves.toBeDefined();
  });

  it("minimal ts-mls unmerged_leaves invariant trigger (causality probe)", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const aliceCredential = createCredential("a".repeat(64));
    const aliceKeyPackage = await generateKeyPackage({
      credential: aliceCredential,
      ciphersuiteImpl: impl,
    });

    const { clientState: createdState } = await createSimpleGroup(
      aliceKeyPackage,
      impl,
      "invariant-probe",
      { adminPubkeys: ["a".repeat(64)], relays: [] },
    );

    const bobCredential = createCredential("b".repeat(64));
    const bobKeyPackage = await generateKeyPackage({
      credential: bobCredential,
      ciphersuiteImpl: impl,
    });
    const charlieCredential = createCredential("c".repeat(64));
    const charlieKeyPackage = await generateKeyPackage({
      credential: charlieCredential,
      ciphersuiteImpl: impl,
    });
    const daveCredential = createCredential("d".repeat(64));
    const daveKeyPackage = await generateKeyPackage({
      credential: daveCredential,
      ciphersuiteImpl: impl,
    });
    const erinCredential = createCredential("e".repeat(64));
    const erinKeyPackage = await generateKeyPackage({
      credential: erinCredential,
      ciphersuiteImpl: impl,
    });

    const { createCommit } = await import("ts-mls");
    const addBob = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: bobKeyPackage.publicPackage },
        },
      ],
    });

    const addCharlie = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: addBob.newState,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: charlieKeyPackage.publicPackage },
        },
      ],
    });

    const addDave = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: addCharlie.newState,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: daveKeyPackage.publicPackage },
        },
      ],
    });

    const addErin = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: addDave.newState,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: erinKeyPackage.publicPackage },
        },
      ],
    });

    const tree = addErin.newState.ratchetTree;
    let mutated = false;

    for (let nodeIndex = 0; nodeIndex < tree.length && !mutated; nodeIndex++) {
      const node = tree[nodeIndex];
      if (node?.nodeType !== nodeTypes.leaf) continue;

      const leafIndex = toLeafIndex(Math.floor(nodeIndex / 2));
      const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
      if (dp.length < 2) continue;

      const firstIdx = dp[0]!;
      const secondIdx = dp[1]!;

      if (tree[firstIdx]?.nodeType !== nodeTypes.parent) {
        tree[firstIdx] = {
          nodeType: nodeTypes.parent,
          parent: {
            hpkePublicKey: new Uint8Array(32).fill((firstIdx % 251) + 1),
            parentHash: new Uint8Array(),
            unmergedLeaves: [],
          },
        };
      }
      if (tree[secondIdx]?.nodeType !== nodeTypes.parent) {
        tree[secondIdx] = {
          nodeType: nodeTypes.parent,
          parent: {
            hpkePublicKey: new Uint8Array(32).fill((secondIdx % 251) + 2),
            parentHash: new Uint8Array(),
            unmergedLeaves: [],
          },
        };
      }

      const firstParent = tree[firstIdx];
      const secondParent = tree[secondIdx];
      if (firstParent?.nodeType !== nodeTypes.parent) continue;
      if (secondParent?.nodeType !== nodeTypes.parent) continue;

      // Force inconsistency: one direct-path parent lists the leaf as unmerged,
      // another direct-path parent does not.
      firstParent.parent.unmergedLeaves = [leafIndex];
      secondParent.parent.unmergedLeaves = [];
      mutated = true;
    }

    expect(mutated).toBe(true);

    const err = await validateRatchetTree(
      tree,
      addErin.newState.groupContext,
      defaultLifetimeConfig,
      unsafeTestingAuthenticationService,
      addErin.newState.groupContext.treeHash,
      impl,
    );

    expect(err?.message).toBe(
      "non-blank intermediate node must list leaf node in its unmerged_leaves",
    );
  });

  it("R5 real-world sequence: buggy forked inviter emits welcome that fails natural join", async () => {
    const signature =
      "non-blank intermediate node must list leaf node in its unmerged_leaves";
    const res = await runR5RealWorldSequence();
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain(signature);
  });

  it("R6 non-admin buggy self-update ingested by admin before invite is observable and join remains deterministic", async () => {
    const network = new ScriptedMockNetwork();

    const adminA = PrivateKeyAccount.generateNew();
    const adminB = PrivateKeyAccount.generateNew();
    const memberC = PrivateKeyAccount.generateNew();
    const inviteeD = PrivateKeyAccount.generateNew();

    const clientA = await createClient(adminA, network);
    const clientB = await createClient(adminB, network);
    const clientC = await createClient(memberC, network);
    const clientD = await createClient(inviteeD, network);

    const adminBPubkey = await adminB.signer.getPublicKey();
    const memberCPubkey = await memberC.signer.getPublicKey();
    const inviteeDPubkey = await inviteeD.signer.getPublicKey();

    await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const groupA = await clientA.createGroup("drift-r6", {
      adminPubkeys: [adminBPubkey],
      relays: ["wss://mock-relay.test"],
    });

    const keyPkgB = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
    );
    if (!keyPkgB)
      throw new Error("R6 setup failed: missing key package for admin B");
    await groupA.inviteByKeyPackageEvent(keyPkgB);
    network.stepAll();

    const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
    if (!giftwrapB)
      throw new Error("R6 setup failed: missing welcome for admin B");
    const rumorB = (await unlockGiftWrap(giftwrapB, adminB.signer)) as Rumor;
    await clientB.joinGroupFromWelcome({ welcomeRumor: rumorB });

    const keyPkgC = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === memberCPubkey,
    );
    if (!keyPkgC)
      throw new Error("R6 setup failed: missing key package for member C");
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, memberCPubkey);
    if (!giftwrapC)
      throw new Error("R6 setup failed: missing welcome for member C");
    const rumorC = (await unlockGiftWrap(giftwrapC, memberC.signer)) as Rumor;
    const { group: groupC } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    const mutated = forceDirectPathUnmergedLeafDivergence(
      groupC.state.ratchetTree as any[],
    );
    expect(mutated).toBe(true);

    await groupC.selfUpdate();
    network.stepAll();
    await drainGroupIngestFromNetwork(groupA as any, network);

    await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();
    const keyPkgD = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeDPubkey,
    );
    if (!keyPkgD)
      throw new Error("R6 setup failed: missing key package for invitee D");

    await groupA.inviteByKeyPackageEvent(keyPkgD);
    network.stepAll();

    const giftwrapD = await getGiftWrapFor(network, inviteeDPubkey);
    if (!giftwrapD)
      throw new Error("R6 setup failed: missing welcome for invitee D");
    const rumorD = (await unlockGiftWrap(giftwrapD, inviteeD.signer)) as Rumor;

    await expect(
      clientD.joinGroupFromWelcome({ welcomeRumor: rumorD }),
    ).resolves.toBeDefined();
  });

  it("R7 sequential invitees from buggy inviter: first deterministic failure implies second deterministic failure", async () => {
    const signature =
      "non-blank intermediate node must list leaf node in its unmerged_leaves";

    const network = new ScriptedMockNetwork();
    const adminA = PrivateKeyAccount.generateNew();
    const adminB = PrivateKeyAccount.generateNew();
    const buggyC = PrivateKeyAccount.generateNew();
    const inviteeD = PrivateKeyAccount.generateNew();
    const inviteeE = PrivateKeyAccount.generateNew();

    const clientA = await createClient(adminA, network);
    const clientB = await createClient(adminB, network);
    const clientC = await createClient(buggyC, network);
    const clientD = await createClient(inviteeD, network);
    const clientE = await createClient(inviteeE, network);

    const adminBPubkey = await adminB.signer.getPublicKey();
    const buggyCPubkey = await buggyC.signer.getPublicKey();
    const inviteeDPubkey = await inviteeD.signer.getPublicKey();
    const inviteeEPubkey = await inviteeE.signer.getPublicKey();

    await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const groupA = await clientA.createGroup("drift-r7", {
      adminPubkeys: [adminBPubkey, buggyCPubkey],
      relays: ["wss://mock-relay.test"],
    });

    const keyPkgB = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
    );
    const keyPkgC = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === buggyCPubkey,
    );
    if (!keyPkgB || !keyPkgC)
      throw new Error("R7 setup failed: missing admin key package(s)");

    await groupA.inviteByKeyPackageEvent(keyPkgB);
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, buggyCPubkey);
    if (!giftwrapC)
      throw new Error("R7 setup failed: missing welcome for buggy C");
    const rumorC = (await unlockGiftWrap(giftwrapC, buggyC.signer)) as Rumor;
    const { group: groupC } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    expect(
      forceDirectPathUnmergedLeafDivergence(groupC.state.ratchetTree as any[]),
    ).toBe(true);

    await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    await clientE.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgD = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeDPubkey,
    );
    const keyPkgE = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeEPubkey,
    );
    if (!keyPkgD || !keyPkgE)
      throw new Error("R7 setup failed: missing invitee key package(s)");

    await groupC.inviteByKeyPackageEvent(keyPkgD);
    network.stepAll();
    const giftwrapD = await getGiftWrapFor(network, inviteeDPubkey);
    if (!giftwrapD)
      throw new Error("R7 setup failed: missing welcome for invitee D");
    const rumorD = (await unlockGiftWrap(giftwrapD, inviteeD.signer)) as Rumor;

    await groupC.inviteByKeyPackageEvent(keyPkgE);
    network.stepAll();
    const giftwrapE = await getGiftWrapFor(network, inviteeEPubkey);
    if (!giftwrapE)
      throw new Error("R7 setup failed: missing welcome for invitee E");
    const rumorE = (await unlockGiftWrap(giftwrapE, inviteeE.signer)) as Rumor;

    await expect(
      clientD.joinGroupFromWelcome({ welcomeRumor: rumorD }),
    ).rejects.toThrow(signature);
    await expect(
      clientE.joinGroupFromWelcome({ welcomeRumor: rumorE }),
    ).rejects.toThrow(signature);
  });

  it("R8 regression: healthy non-admin self-update does not break future joins", async () => {
    const network = new ScriptedMockNetwork();

    const adminA = PrivateKeyAccount.generateNew();
    const adminB = PrivateKeyAccount.generateNew();
    const memberC = PrivateKeyAccount.generateNew();
    const inviteeD = PrivateKeyAccount.generateNew();

    const clientA = await createClient(adminA, network);
    const clientB = await createClient(adminB, network);
    const clientC = await createClient(memberC, network);
    const clientD = await createClient(inviteeD, network);

    const adminBPubkey = await adminB.signer.getPublicKey();
    const memberCPubkey = await memberC.signer.getPublicKey();
    const inviteeDPubkey = await inviteeD.signer.getPublicKey();

    await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const groupA = await clientA.createGroup("drift-r8", {
      adminPubkeys: [adminBPubkey],
      relays: ["wss://mock-relay.test"],
    });

    const keyPkgB = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === adminBPubkey,
    );
    if (!keyPkgB)
      throw new Error("R8 setup failed: missing key package for admin B");
    await groupA.inviteByKeyPackageEvent(keyPkgB);
    network.stepAll();

    const keyPkgC = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === memberCPubkey,
    );
    if (!keyPkgC)
      throw new Error("R8 setup failed: missing key package for member C");
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, memberCPubkey);
    if (!giftwrapC)
      throw new Error("R8 setup failed: missing welcome for member C");
    const rumorC = (await unlockGiftWrap(giftwrapC, memberC.signer)) as Rumor;
    const { group: groupC } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    await expect(groupC.selfUpdate()).resolves.toBeDefined();
    network.stepAll();
    await drainGroupIngestFromNetwork(groupA as any, network);

    await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();
    const keyPkgD = network.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND && e.pubkey === inviteeDPubkey,
    );
    if (!keyPkgD)
      throw new Error("R8 setup failed: missing key package for invitee D");
    await groupA.inviteByKeyPackageEvent(keyPkgD);
    network.stepAll();

    const giftwrapD = await getGiftWrapFor(network, inviteeDPubkey);
    if (!giftwrapD)
      throw new Error("R8 setup failed: missing welcome for invitee D");
    const rumorD = (await unlockGiftWrap(giftwrapD, inviteeD.signer)) as Rumor;

    await expect(
      clientD.joinGroupFromWelcome({ welcomeRumor: rumorD }),
    ).resolves.toBeDefined();
  });
});
