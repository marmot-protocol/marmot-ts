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
  makeAppDataDictionaryExtension,
  UsageError,
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
  getGroupLifecycle,
  getGroupAvatarUrl,
  getGroupProfile,
  getMessageRetention,
  getNostrRouting,
  groupAvatarUrlEntry,
  groupLifecycleEntry,
  groupProfileEntry,
  makeAppComponentsExtension,
  messageRetentionEntry,
  nostrRoutingEntry,
} from "../dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "../ids.js";
import { groupProtocolLifecycleValues } from "../group-lifecycle.js";
import { makeLeafAppComponentsExtension } from "../dictionary.js";
import { encodeComponentsList } from "../app-components-list.js";
import { createCredential } from "../../credential.js";
import { generateKeyPackage } from "../../key-package.js";
import { createGroup } from "../../group.js";
import { getMarmotGroupInfo, getMarmotGroupView } from "../../client-state.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

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
  it("advertises app_components (including 0x8009 exactly once), carries the reference SafeAAD entry, and the given proof bytes", () => {
    const proof = new Uint8Array(104).fill(0xab);
    const extension = makeLeafAppComponentsExtension(proof);
    const extensions = [extension] as GroupContextExtension[];
    const advertised = getAppComponents(extensions);
    expect(advertised).toEqual([
      APP_COMPONENTS_COMPONENT_ID,
      ...SUPPORTED_APP_COMPONENT_IDS,
    ]);
    expect(
      advertised!.filter((id) => id === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID),
    ).toHaveLength(1);
    expect(getComponentData(extensions, SAFE_AAD_COMPONENT_ID)).toEqual(
      new Uint8Array([0]),
    );
    expect(
      getComponentData(extensions, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID),
    ).toEqual(proof);
  });

  it("de-duplicates and sorts a supportedIds override that already names 0x8009", () => {
    const proof = new Uint8Array(104);
    const extension = makeLeafAppComponentsExtension(proof, [
      GROUP_PROFILE_COMPONENT_ID,
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    ]);
    const extensions = [extension] as GroupContextExtension[];
    expect(getAppComponents(extensions)).toEqual([
      APP_COMPONENTS_COMPONENT_ID,
      GROUP_PROFILE_COMPONENT_ID,
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    ]);
  });

  it("throws UsageError for a proof that is not exactly 104 bytes", () => {
    expect(() => makeLeafAppComponentsExtension(new Uint8Array(103))).toThrow(
      UsageError,
    );
  });

  it("matches the MDK leaf dictionary bytes through a real KeyPackage: 3 entries, a 104-byte 0x8009 entry, and the 0x0001/0x0002 projection", async () => {
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(5);
    const keyPackage = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      ciphersuiteImpl,
      signer: account.signer,
    });
    const leafExtensions = keyPackage.publicPackage.leafNode
      .extensions as GroupContextExtension[];
    const extension = keyPackage.publicPackage.leafNode.extensions.find(
      (candidate) => candidate.extensionType === appDataDictionaryExtensionType,
    );
    expect(extension).toBeDefined();

    const proofBytes = getComponentData(
      leafExtensions,
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    );
    expect(proofBytes).toHaveLength(104);

    // Proof bytes are nondeterministic (created_at, BIP-340 aux randomness),
    // so pin only a projection of the 0x0001 (app_components) and 0x0002
    // (SafeAAD) entries, reconstructed from the same builder the production
    // leaf dictionary uses (PITFALLS 14).
    const projectionExtension = makeAppDataDictionaryExtensionForProjection();
    expect(
      bytesToHex(
        new Uint8Array([
          0x00,
          projectionExtension.extensionType,
          projectionExtension.extensionData.length,
          ...projectionExtension.extensionData,
        ]),
      ),
    ).toBe("00061d1c00011514000180018003800480058006800780088009800c00020100");

    function makeAppDataDictionaryExtensionForProjection() {
      // Bypasses makeAppComponentsExtension's SafeAAD guard (that guard is a
      // GroupContext-level rule; the LeafNode dictionary legitimately carries
      // SafeAAD) to rebuild exactly the 0x0001 + 0x0002 entries a real leaf
      // dictionary carries, without its nondeterministic 0x8009 proof bytes.
      return makeAppDataDictionaryExtension(
        buildAppDataDictionary([
          appComponentsEntry([
            APP_COMPONENTS_COMPONENT_ID,
            ...SUPPORTED_APP_COMPONENT_IDS,
          ]),
          componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
        ]),
      );
    }
  });

  it("rejects SafeAAD as group-component state", () => {
    expect(() =>
      makeAppComponentsExtension([
        componentEntry(SAFE_AAD_COMPONENT_ID, new Uint8Array([0])),
      ]),
    ).toThrow(/SafeAAD.*LeafNode/i);
  });
});

describe("group lifecycle defaults", () => {
  it("carries active lifecycle state from new-group bytes to the public view", async () => {
    const creatorAccount = testAccount(5);
    const creatorPubkey = creatorAccount.pubkey;
    const ciphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const creatorKeyPackage = await generateKeyPackage({
      credential: createCredential(creatorPubkey),
      ciphersuiteImpl,
      signer: creatorAccount.signer,
    });
    const { clientState } = await createGroup({
      creatorKeyPackage,
      components: [
        groupProfileEntry({ name: "Lifecycle Group", description: "" }),
        adminPolicyEntry([creatorPubkey]),
      ],
      ciphersuiteImpl,
    });

    expect(getAppComponents(clientState.groupContext.extensions)).toContain(
      GROUP_LIFECYCLE_COMPONENT_ID,
    );
    expect(
      getComponentData(
        clientState.groupContext.extensions,
        GROUP_LIFECYCLE_COMPONENT_ID,
      ),
    ).toEqual(new Uint8Array([0]));
    expect(getGroupLifecycle(clientState.groupContext.extensions)).toBe(
      groupProtocolLifecycleValues.active,
    );
    expect(getMarmotGroupView(clientState)?.protocolLifecycle).toBe(
      groupProtocolLifecycleValues.active,
    );

    const legacyExtensions = extensionsWith(
      groupProfileEntry({ name: "Legacy Group", description: "" }),
      adminPolicyEntry([creatorPubkey]),
    );
    expect(getGroupLifecycle(legacyExtensions)).toBeUndefined();
    expect(
      getMarmotGroupView({
        ...clientState,
        groupContext: {
          ...clientState.groupContext,
          extensions: legacyExtensions,
        },
      })?.protocolLifecycle,
    ).toBeUndefined();

    expect(groupLifecycleEntry(groupProtocolLifecycleValues.disbanded)).toEqual(
      {
        componentId: GROUP_LIFECYCLE_COMPONENT_ID,
        data: new Uint8Array([1]),
      },
    );

    const malformedExtensions = extensionsWith(
      groupProfileEntry({ name: "Malformed Group", description: "" }),
      adminPolicyEntry([creatorPubkey]),
      componentEntry(GROUP_LIFECYCLE_COMPONENT_ID, new Uint8Array([0, 0])),
    );
    const malformedState = {
      ...clientState,
      groupContext: {
        ...clientState.groupContext,
        extensions: malformedExtensions,
      },
    };
    expect(getMarmotGroupView(malformedState)).toBeNull();
    expect(
      getMarmotGroupInfo(malformedState).app.components.find(
        (component) => component.id === GROUP_LIFECYCLE_COMPONENT_ID,
      )?.decodeError,
    ).toBeDefined();
  });
});
