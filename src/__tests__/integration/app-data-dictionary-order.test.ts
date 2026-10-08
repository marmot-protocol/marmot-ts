import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  appDataDictionaryExtensionType,
  defaultExtensionTypes,
  type GroupContextExtension,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { proposeUpdateMetadata } from "../../client/group/proposals/update-metadata.js";
import type { StoredKeyPackage } from "../../client/key-package-manager.js";
import { MarmotClient } from "../../client/marmot-client.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../helpers/mock-network.js";

const RELAY = "wss://mock-relay.test";

/**
 * What OpenMLS (and therefore MDK / White Noise) does with the GroupContext
 * extensions when it applies an AppDataUpdate commit:
 * `Extensions::add_or_replace` removes the existing app_data_dictionary and
 * pushes the updated one to the END of the list.
 */
function openMlsApply(
  before: GroupContextExtension[],
  updatedDictionary: GroupContextExtension,
): GroupContextExtension[] {
  return [
    ...before.filter((e) => e.extensionType !== appDataDictionaryExtensionType),
    updatedDictionary,
  ];
}

const typesOf = (extensions: GroupContextExtension[]) =>
  extensions.map((e) => e.extensionType);

describe("app_data_dictionary position in the GroupContext", () => {
  it("a new group lists required_capabilities first and app_data_dictionary last, like MDK", async () => {
    const account = PrivateKeyAccount.generateNew();
    const client = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: account.signer,
      network: new MockNetwork(),
    });
    const group = await client.groups.create("Order", {
      adminPubkeys: [await account.signer.getPublicKey()],
      relays: [RELAY],
    });

    expect(typesOf(group.state.groupContext.extensions)).toEqual([
      defaultExtensionTypes.required_capabilities,
      appDataDictionaryExtensionType,
    ]);
  });

  it.each([
    ["name", { name: "Renamed" }],
    ["admins", { adminPubkeys: "self" as const }],
    ["relays", { relays: [RELAY, "wss://second.test"] }],
  ])(
    "an AppDataUpdate commit (%s) yields the same GroupContext extensions under ts-mls and OpenMLS semantics",
    async (_label, update) => {
      const account = PrivateKeyAccount.generateNew();
      const me = await account.signer.getPublicKey();
      const client = new MarmotClient({
        groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
        keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
        signer: account.signer,
        network: new MockNetwork(),
      });
      const group = await client.groups.create("Order", {
        adminPubkeys: [me],
        relays: [RELAY],
      });
      const before = group.state.groupContext.extensions;

      // Admins must be current members, so the admin case re-commits [me]:
      // still a full AppDataUpdate of the admin-policy component.
      const metadata =
        "adminPubkeys" in update ? { adminPubkeys: [me] } : update;
      await client.groups.commit(group.id, {
        extraProposals: await proposeUpdateMetadata(metadata)(
          group.session.proposalContext(),
        ),
      });

      const after = group.state.groupContext.extensions;
      expect(group.state.groupContext.epoch).toBe(1n);
      const updatedDictionary = after.find(
        (e) => e.extensionType === appDataDictionaryExtensionType,
      )!;
      // Same order (and therefore the same serialized GroupContext and key
      // schedule) as a peer that re-appends the dictionary.
      expect(after).toEqual(openMlsApply(before, updatedDictionary));
      expect(getMarmotGroupView(group.state)).toBeTruthy();
    },
  );
});
