/**
 * Tests for the app-component read facade + dictionary builder over the ts-mls
 * `app_data_dictionary` extension. Verifies that typed entries build a sorted,
 * transcript-ready dictionary and read back through the typed accessors.
 */
import {
  appDataDictionaryExtensionType,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  GroupContextExtension,
} from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  adminPolicyEntry,
  appComponentsEntry,
  buildAppDataDictionary,
  componentEntry,
  getAdminPolicy,
  getAppComponents,
  getComponentData,
  getGroupAvatarUrl,
  getGroupProfile,
  getMessageRetention,
  getNostrRouting,
  groupAvatarUrlEntry,
  groupProfileEntry,
  makeAppComponentsExtension,
  messageRetentionEntry,
  nostrRoutingEntry,
} from "../dictionary.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "../ids.js";
import { makeLeafAppComponentsExtension } from "../dictionary.js";
import { createCredential } from "../../credential.js";
import { generateKeyPackage } from "../../key-package.js";

const gid = new Uint8Array(32);
for (let i = 0; i < 32; i++) gid[i] = i;
const adminKey = "11".repeat(32);

function extensionsWith(...entries: ReturnType<typeof componentEntry>[]) {
  return [makeAppComponentsExtension(entries)] as GroupContextExtension[];
}

describe("buildAppDataDictionary", () => {
  it("sorts entries ascending by component id", () => {
    const dict = buildAppDataDictionary([
      nostrRoutingEntry({ nostrGroupId: gid, relays: ["wss://relay.example"] }),
      groupProfileEntry({ name: "a", description: "" }),
      adminPolicyEntry([adminKey]),
    ]);
    expect(dict.map((c) => c.componentId)).toEqual([
      GROUP_PROFILE_COMPONENT_ID,
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      NOSTR_ROUTING_COMPONENT_ID,
    ]);
  });

  it("rejects duplicate component ids", () => {
    expect(() =>
      buildAppDataDictionary([
        groupProfileEntry({ name: "a", description: "" }),
        groupProfileEntry({ name: "b", description: "" }),
      ]),
    ).toThrow(/[Dd]uplicate/);
  });
});

describe("typed read facade round-trips through the extension", () => {
  it("reads every component back from a built dictionary", () => {
    const extensions = extensionsWith(
      appComponentsEntry([
        GROUP_PROFILE_COMPONENT_ID,
        GROUP_ADMIN_POLICY_COMPONENT_ID,
        NOSTR_ROUTING_COMPONENT_ID,
      ]),
      groupProfileEntry({ name: "Test Group", description: "a description" }),
      adminPolicyEntry([adminKey]),
      nostrRoutingEntry({ nostrGroupId: gid, relays: ["wss://relay.example"] }),
      messageRetentionEntry(86400),
      groupAvatarUrlEntry({ url: "https://example.com/a.png" }),
    );

    expect(getAppComponents(extensions)).toEqual([
      GROUP_PROFILE_COMPONENT_ID,
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      NOSTR_ROUTING_COMPONENT_ID,
    ]);
    expect(getGroupProfile(extensions)).toEqual({
      name: "Test Group",
      description: "a description",
    });
    expect(getAdminPolicy(extensions)).toEqual([adminKey]);
    expect(getNostrRouting(extensions)).toEqual({
      nostrGroupId: gid,
      relays: ["wss://relay.example"],
    });
    expect(getMessageRetention(extensions)).toBe(86400n);
    expect(getGroupAvatarUrl(extensions)).toEqual({
      url: "https://example.com/a.png",
    });
  });

  it("returns undefined for absent components", () => {
    const extensions = extensionsWith(
      groupProfileEntry({ name: "only profile", description: "" }),
    );
    expect(getGroupProfile(extensions)).toBeTruthy();
    expect(getAdminPolicy(extensions)).toBeUndefined();
    expect(getNostrRouting(extensions)).toBeUndefined();
  });

  it("returns undefined when no app_data_dictionary extension exists", () => {
    expect(getGroupProfile([])).toBeUndefined();
    expect(getComponentData([], GROUP_PROFILE_COMPONENT_ID)).toBeUndefined();
  });
});

describe("makeLeafAppComponentsExtension", () => {
  it("advertises app_components and carries the reference SafeAAD entry", () => {
    const extension = makeLeafAppComponentsExtension();
    const extensions = [extension] as GroupContextExtension[];
    expect(getAppComponents(extensions)).toEqual([
      APP_COMPONENTS_COMPONENT_ID,
      ...SUPPORTED_APP_COMPONENT_IDS,
    ]);
    expect(getComponentData(extensions, SAFE_AAD_COMPONENT_ID)).toEqual(
      new Uint8Array([0]),
    );
  });

  it("matches the MDK leaf dictionary bytes through a real KeyPackage", async () => {
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential: createCredential(
        "884704bd421671e01c13f854d2ce23ce2a5bfe9562f4f297ad2bc921ba30c3a6",
      ),
      ciphersuiteImpl,
    });
    const extension = keyPackage.publicPackage.leafNode.extensions.find(
      (candidate) =>
        candidate.extensionType === appDataDictionaryExtensionType,
    );

    expect(extension).toBeDefined();
    expect(
      bytesToHex(
        new Uint8Array([
          0x00,
          extension!.extensionType,
          extension!.extensionData.length,
          ...extension!.extensionData,
        ]),
      ),
    ).toBe(
      "00061918000111100001800180038004800580068007800800020100",
    );
  });

  it("rejects SafeAAD as group-component state", () => {
    expect(() =>
      makeAppComponentsExtension([
        componentEntry(SAFE_AAD_COMPONENT_ID, new Uint8Array([0])),
      ]),
    ).toThrow(/SafeAAD.*LeafNode/i);
  });
});
