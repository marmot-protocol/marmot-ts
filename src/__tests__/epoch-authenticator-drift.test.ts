import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  unlockGiftWrap,
  type Rumor,
} from "applesauce-common/helpers/gift-wrap";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nodeTypes } from "ts-mls/nodeType.js";
import {
  directPath,
  leafToNodeIndex,
  leafWidth,
  toLeafIndex,
} from "ts-mls/treemath.js";
import { describe, expect, it } from "vitest";

import { MarmotClient } from "../client/marmot-client.js";
import {
  KEY_PACKAGE_KIND,
  WELCOME_EPOCH_AUTHENTICATOR_TAG,
} from "../core/protocol.js";
import { getWelcomeEpochAuthenticator } from "../core/welcome.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { KeyValueGroupStateBackend } from "../store/adapters/key-value-group-state-backend.js";
import { GROUP_EVENT_KIND } from "../core/protocol.js";
import { MemoryBackend } from "./ingest-commit-race.test.js";
import { ScriptedMockNetwork } from "./helpers/scripted-mock-network.js";

async function createClient(
  account: PrivateKeyAccount<any>,
  network: ScriptedMockNetwork,
): Promise<MarmotClient> {
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
): Promise<any> {
  const giftwraps = await network.request(["wss://mock-inbox.test"], {
    kinds: [1059],
    "#p": [recipientPubkey],
  });
  return giftwraps[giftwraps.length - 1];
}

async function setupTwoAdminGroup(): Promise<{
  network: ScriptedMockNetwork;
  adminA: PrivateKeyAccount<any>;
  adminB: PrivateKeyAccount<any>;
  inviteeC: PrivateKeyAccount<any>;
  clientA: MarmotClient;
  clientB: MarmotClient;
  clientC: MarmotClient;
  groupA: Awaited<ReturnType<MarmotClient["createGroup"]>>;
  groupB: Awaited<ReturnType<MarmotClient["getGroup"]>>;
  inviteeCPubkey: string;
}> {
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

  const groupA = await clientA.createGroup("epoch-authenticator-drift", {
    adminPubkeys: [adminBPubkey],
    relays: ["wss://mock-relay.test"],
  });

  const keyPkgB = network.events.find(
    (event) => event.kind === KEY_PACKAGE_KIND && event.pubkey === adminBPubkey,
  );
  if (!keyPkgB) {
    throw new Error(
      "Epoch authenticator setup failed: missing key package for admin B",
    );
  }

  await groupA.inviteByKeyPackageEvent(keyPkgB);
  network.stepAll();

  const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
  if (!giftwrapB) {
    throw new Error(
      "Epoch authenticator setup failed: missing welcome for admin B",
    );
  }

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

function getEpochAuthenticatorHex(group: {
  state: { keySchedule: { epochAuthenticator: Uint8Array } };
}): string {
  return bytesToHex(group.state.keySchedule.epochAuthenticator);
}

function withEpochAuthenticatorTag(
  rumor: Rumor,
  epochAuthenticatorHex: string,
): Rumor {
  const tags = rumor.tags.filter(
    (tag) => tag[0] !== WELCOME_EPOCH_AUTHENTICATOR_TAG,
  );
  tags.push([WELCOME_EPOCH_AUTHENTICATOR_TAG, epochAuthenticatorHex]);

  return {
    ...rumor,
    tags,
  };
}

function forceDirectPathUnmergedLeafDivergence(tree: any[]): boolean {
  let mutated = false;
  for (let nodeIndex = 0; nodeIndex < tree.length && !mutated; nodeIndex++) {
    const node = tree[nodeIndex];
    if (node?.nodeType !== nodeTypes.leaf) continue;

    const leafIndex = toLeafIndex(Math.floor(nodeIndex / 2));
    const path = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
    if (path.length < 2) continue;

    const firstParentIndex = path[0]!;
    const secondParentIndex = path[1]!;

    if (tree[firstParentIndex]?.nodeType !== nodeTypes.parent) {
      tree[firstParentIndex] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((firstParentIndex % 251) + 1),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }
    if (tree[secondParentIndex]?.nodeType !== nodeTypes.parent) {
      tree[secondParentIndex] = {
        nodeType: nodeTypes.parent,
        parent: {
          hpkePublicKey: new Uint8Array(32).fill((secondParentIndex % 251) + 2),
          parentHash: new Uint8Array(),
          unmergedLeaves: [],
        },
      };
    }

    const firstParent = tree[firstParentIndex];
    const secondParent = tree[secondParentIndex];
    if (firstParent?.nodeType !== nodeTypes.parent) continue;
    if (secondParent?.nodeType !== nodeTypes.parent) continue;

    firstParent.parent.unmergedLeaves = [leafIndex];
    secondParent.parent.unmergedLeaves = [];
    mutated = true;
  }

  return mutated;
}

describe("epoch authenticator drift diagnostics", () => {
  it("matches the welcome tag and inviter state after a successful join", async () => {
    const { network, clientC, groupA, inviteeC, inviteeCPubkey } =
      await setupTwoAdminGroup();

    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgC = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === inviteeCPubkey,
    );
    if (!keyPkgC) {
      throw new Error(
        "Baseline join failed: missing key package for invitee C",
      );
    }

    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
    if (!giftwrapC) {
      throw new Error("Baseline join failed: missing welcome for invitee C");
    }

    const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
    const taggedEpochAuthenticator = getWelcomeEpochAuthenticator(rumorC);

    expect(taggedEpochAuthenticator).toBeDefined();
    expect(bytesToHex(taggedEpochAuthenticator!)).toBe(
      getEpochAuthenticatorHex(groupA),
    );

    const { group: joinedGroup } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    expect(joinedGroup.state.groupContext.epoch).toBe(
      groupA.state.groupContext.epoch,
    );
    expect(getEpochAuthenticatorHex(joinedGroup)).toBe(
      getEpochAuthenticatorHex(groupA),
    );
    expect(bytesToHex(joinedGroup.state.groupContext.treeHash)).toBe(
      bytesToHex(groupA.state.groupContext.treeHash),
    );
  });

  it("tracks the welcome-producing branch under competing same-window commits", async () => {
    const { network, clientC, groupA, groupB, inviteeC, inviteeCPubkey } =
      await setupTwoAdminGroup();

    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgC = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === inviteeCPubkey,
    );
    if (!keyPkgC) {
      throw new Error("Branch race failed: missing key package for invitee C");
    }

    const publishCut = network.events.length;
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    const branchAuthenticator = getEpochAuthenticatorHex(groupA);
    await groupB.selfUpdate();
    const competingAuthenticator = getEpochAuthenticatorHex(groupB);

    const raceEvents = network.events.slice(publishCut);
    const welcomeC = raceEvents.find(
      (event) =>
        event.kind === 1059 &&
        event.tags.some((tag) => tag[0] === "p" && tag[1] === inviteeCPubkey),
    );
    const commits = raceEvents.filter(
      (event) => event.kind === GROUP_EVENT_KIND,
    );

    if (!welcomeC || commits.length < 2) {
      throw new Error("Branch race failed: missing welcome/commit race events");
    }

    network.stepWhere((event) => event.id === commits[1]!.id);
    network.stepWhere((event) => event.id === welcomeC.id);
    network.stepWhere((event) => event.id === commits[0]!.id);

    const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
    if (!giftwrapC) {
      throw new Error(
        "Branch race failed: missing delivered welcome for invitee C",
      );
    }

    const rumorC = (await unlockGiftWrap(giftwrapC, inviteeC.signer)) as Rumor;
    const taggedEpochAuthenticator = getWelcomeEpochAuthenticator(rumorC);

    expect(bytesToHex(taggedEpochAuthenticator!)).toBe(branchAuthenticator);
    expect(branchAuthenticator).not.toBe(competingAuthenticator);

    const { group: joinedGroup } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    expect(getEpochAuthenticatorHex(joinedGroup)).toBe(branchAuthenticator);
    expect(getEpochAuthenticatorHex(joinedGroup)).not.toBe(
      competingAuthenticator,
    );
  });

  it("detects a forged epoch authenticator claim after an otherwise valid join", async () => {
    const { network, clientC, groupA, inviteeC, inviteeCPubkey } =
      await setupTwoAdminGroup();

    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgC = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === inviteeCPubkey,
    );
    if (!keyPkgC) {
      throw new Error(
        "Forged-ea test failed: missing key package for invitee C",
      );
    }

    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
    if (!giftwrapC) {
      throw new Error("Forged-ea test failed: missing welcome for invitee C");
    }

    const originalRumor = (await unlockGiftWrap(
      giftwrapC,
      inviteeC.signer,
    )) as Rumor;
    const honestEpochAuthenticator =
      getWelcomeEpochAuthenticator(originalRumor);
    if (!honestEpochAuthenticator) {
      throw new Error(
        "Forged-ea test failed: welcome is missing honest ea tag",
      );
    }

    const forgedHex = `${"ab".repeat(31)}cd`;
    expect(forgedHex).not.toBe(bytesToHex(honestEpochAuthenticator));

    const forgedRumor = withEpochAuthenticatorTag(originalRumor, forgedHex);

    expect(bytesToHex(getWelcomeEpochAuthenticator(forgedRumor)!)).toBe(
      forgedHex,
    );

    const { group: joinedGroup } = await clientC.joinGroupFromWelcome({
      welcomeRumor: forgedRumor,
    });

    expect(getEpochAuthenticatorHex(joinedGroup)).toBe(
      getEpochAuthenticatorHex(groupA),
    );
    expect(getEpochAuthenticatorHex(joinedGroup)).not.toBe(forgedHex);
    expect(getEpochAuthenticatorHex(joinedGroup)).toBe(
      bytesToHex(honestEpochAuthenticator),
    );
  });

  it("detects when a welcome carries the competing branch epoch authenticator", async () => {
    const { network, clientC, groupA, groupB, inviteeC, inviteeCPubkey } =
      await setupTwoAdminGroup();

    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgC = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === inviteeCPubkey,
    );
    if (!keyPkgC) {
      throw new Error(
        "Cross-branch oracle test failed: missing key package for invitee C",
      );
    }

    const publishCut = network.events.length;
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    const welcomeBranchAuthenticator = getEpochAuthenticatorHex(groupA);
    await groupB.selfUpdate();
    const competingBranchAuthenticator = getEpochAuthenticatorHex(groupB);

    expect(welcomeBranchAuthenticator).not.toBe(competingBranchAuthenticator);

    const raceEvents = network.events.slice(publishCut);
    const welcomeC = raceEvents.find(
      (event) =>
        event.kind === 1059 &&
        event.tags.some((tag) => tag[0] === "p" && tag[1] === inviteeCPubkey),
    );
    const commits = raceEvents.filter(
      (event) => event.kind === GROUP_EVENT_KIND,
    );

    if (!welcomeC || commits.length < 2) {
      throw new Error(
        "Cross-branch oracle test failed: missing welcome/commit race events",
      );
    }

    network.stepWhere((event) => event.id === commits[1]!.id);
    network.stepWhere((event) => event.id === welcomeC.id);
    network.stepWhere((event) => event.id === commits[0]!.id);

    const giftwrapC = await getGiftWrapFor(network, inviteeCPubkey);
    if (!giftwrapC) {
      throw new Error(
        "Cross-branch oracle test failed: missing delivered welcome for invitee C",
      );
    }

    const originalRumor = (await unlockGiftWrap(
      giftwrapC,
      inviteeC.signer,
    )) as Rumor;
    const forgedRumor = withEpochAuthenticatorTag(
      originalRumor,
      competingBranchAuthenticator,
    );

    expect(bytesToHex(getWelcomeEpochAuthenticator(forgedRumor)!)).toBe(
      competingBranchAuthenticator,
    );

    const { group: joinedGroup } = await clientC.joinGroupFromWelcome({
      welcomeRumor: forgedRumor,
    });

    expect(getEpochAuthenticatorHex(joinedGroup)).toBe(
      welcomeBranchAuthenticator,
    );
    expect(getEpochAuthenticatorHex(joinedGroup)).not.toBe(
      competingBranchAuthenticator,
    );
  });

  it("does not treat the welcome tag as sufficient when join fails before valid state construction", async () => {
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

    await clientB.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    await clientC.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const groupA = await clientA.createGroup("epoch-authenticator-r5", {
      adminPubkeys: [adminBPubkey, buggyCPubkey],
      relays: ["wss://mock-relay.test"],
    });

    const keyPkgB = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === adminBPubkey,
    );
    const keyPkgC = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === buggyCPubkey,
    );
    if (!keyPkgB || !keyPkgC) {
      throw new Error(
        "Failure-boundary setup failed: missing admin key package events",
      );
    }

    await groupA.inviteByKeyPackageEvent(keyPkgB);
    await groupA.inviteByKeyPackageEvent(keyPkgC);
    network.stepAll();

    const giftwrapB = await getGiftWrapFor(network, adminBPubkey);
    const giftwrapC = await getGiftWrapFor(network, buggyCPubkey);
    if (!giftwrapB || !giftwrapC) {
      throw new Error(
        "Failure-boundary setup failed: missing admin welcome giftwraps",
      );
    }

    const rumorB = (await unlockGiftWrap(giftwrapB, adminB.signer)) as Rumor;
    const rumorC = (await unlockGiftWrap(giftwrapC, buggyC.signer)) as Rumor;

    const { group: groupB } = await clientB.joinGroupFromWelcome({
      welcomeRumor: rumorB,
    });
    const { group: groupC } = await clientC.joinGroupFromWelcome({
      welcomeRumor: rumorC,
    });

    await groupC.selfUpdate();
    await groupA.selfUpdate();
    await groupB.selfUpdate();

    const mutated = forceDirectPathUnmergedLeafDivergence(
      groupC.state.ratchetTree,
    );

    if (!mutated) {
      throw new Error(
        "Failure-boundary setup failed: could not mutate buggy tree",
      );
    }

    await clientD.keyPackages.create({ relays: ["wss://mock-relay.test"] });
    network.stepAll();

    const keyPkgD = network.events.find(
      (event) =>
        event.kind === KEY_PACKAGE_KIND && event.pubkey === inviteeDPubkey,
    );
    if (!keyPkgD) {
      throw new Error(
        "Failure-boundary setup failed: missing invitee D key package",
      );
    }

    await groupC.inviteByKeyPackageEvent(keyPkgD);
    network.stepAll();

    const giftwrapD = await getGiftWrapFor(network, inviteeDPubkey);
    if (!giftwrapD) {
      throw new Error(
        "Failure-boundary setup failed: missing invitee D welcome",
      );
    }

    const rumorD = (await unlockGiftWrap(giftwrapD, inviteeD.signer)) as Rumor;
    const taggedEpochAuthenticator = getWelcomeEpochAuthenticator(rumorD);

    expect(taggedEpochAuthenticator).toBeDefined();
    expect(bytesToHex(taggedEpochAuthenticator!)).toBe(
      getEpochAuthenticatorHex(groupC),
    );

    await expect(
      clientD.joinGroupFromWelcome({ welcomeRumor: rumorD }),
    ).rejects.toThrow(signature);
  });
});
