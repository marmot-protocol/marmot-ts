/**
 * Tests for the app-component read facade + dictionary builder over the ts-mls
 * `app_data_dictionary` extension. Verifies that typed entries build a sorted,
 * transcript-ready dictionary and read back through the typed accessors.
 */
import { GroupContextExtension } from "ts-mls";
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
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../ids.js";

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
