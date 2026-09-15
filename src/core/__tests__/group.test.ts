import { describe, expect, it } from "vitest";
import {
  defaultCryptoProvider,
  defaultExtensionTypes,
  type ExtensionRequiredCapabilities,
  getCiphersuiteImpl,
} from "ts-mls";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { createGroup, createSimpleGroup } from "../group.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { marmotRequiredCapabilitiesExtension } from "../capabilities.js";
import { getMarmotGroupView } from "../client-state.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  adminPolicyEntry,
  classifyGroupAccountIdentityProofProfile,
  encryptedMediaBlossomDefault,
  encryptedMediaEntry,
  getAppComponents,
  getComponentData,
  getGroupProfileSupport,
  groupAvatarUrlEntry,
  groupProfileEntry,
  messageRetentionEntry,
  nostrRoutingEntry,
} from "../components/index.js";

describe("group construction", () => {
  it("createGroup seeds a decodable app_data_dictionary from components", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const nostrGroupId = new Uint8Array(32).fill(7);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });

    const { clientState } = await createGroup({
      creatorKeyPackage: kp,
      components: [
        groupProfileEntry({ name: "Test Group", description: "" }),
        adminPolicyEntry([adminPubkey]),
        nostrRoutingEntry({
          nostrGroupId,
          relays: ["wss://relay.example.com"],
        }),
      ],
      ciphersuiteImpl: impl,
    });

    const view = getMarmotGroupView(clientState);
    expect(view).toBeTruthy();
    expect(view?.name).toBe("Test Group");
    expect(view?.nostrGroupId).toEqual(nostrGroupId);
    expect(view?.adminPubkeys).toEqual([adminPubkey]);
    expect(view?.relays).toEqual(["wss://relay.example.com"]);

    // The app_components entry lists provided ids plus lifecycle-v1 and the
    // account identity proof (0x8009), both mandatory for every newly created
    // group (D-05).
    expect(getAppComponents(clientState.groupContext.extensions)).toEqual([
      0x8001, 0x8003, 0x8004, 0x8009, 0x800c,
    ]);
    expect(view?.protocolLifecycle).toBe("active");

    // 0x8009 is only ever a required-list entry, never GroupContext-level data
    // (PROOF-06), and the group classifies as the current profile (D-07).
    expect(
      getComponentData(
        clientState.groupContext.extensions,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ),
    ).toBeUndefined();
    expect(
      classifyGroupAccountIdentityProofProfile(
        clientState.groupContext.extensions,
      ),
    ).toBe("current");

    // MLS group_id must be distinct from the public nostr_group_id.
    expect(clientState.groupContext.groupId).not.toEqual(nostrGroupId);

    // The group declares the Marmot baseline required_capabilities so MLS
    // enforces them on every future add (capability-negotiation.md §5.2).
    const required = clientState.groupContext.extensions.find(
      (e) => e.extensionType === defaultExtensionTypes.required_capabilities,
    );
    expect(required).toBeTruthy();
    expect((required as ExtensionRequiredCapabilities).extensionData).toEqual(
      marmotRequiredCapabilitiesExtension().extensionData,
    );
  });

  it("GRP-01: a created group requires 0x8009 in app_components, not required_capabilities, with no GroupContext state", async () => {
    const adminAccount = testAccount(6);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });

    const { clientState } = await createSimpleGroup(kp, impl, "GRP-01", {
      adminPubkeys: [adminAccount.pubkey],
    });
    const { extensions } = clientState.groupContext;

    expect(getAppComponents(extensions)).toContain(
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    );
    expect(
      getComponentData(extensions, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID),
    ).toBeUndefined();

    const required = extensions.find(
      (e) => e.extensionType === defaultExtensionTypes.required_capabilities,
    ) as ExtensionRequiredCapabilities | undefined;
    expect(required).toBeTruthy();
    expect(
      required!.extensionData.extensionTypes.includes(
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ),
    ).toBe(false);
    expect(required!.extensionData.extensionTypes.includes(0xf2f1)).toBe(false);

    expect(getGroupProfileSupport(extensions)).toEqual({ kind: "supported" });
  });

  it("surfaces avatar, encrypted-media policy, and retention through the group view", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });

    const policy = encryptedMediaBlossomDefault([
      "https://blossom.example.com",
    ]);
    const { clientState } = await createGroup({
      creatorKeyPackage: kp,
      components: [
        groupProfileEntry({ name: "Media Group", description: "" }),
        adminPolicyEntry([adminPubkey]),
        groupAvatarUrlEntry({ url: "https://cdn.example.com/avatar.png" }),
        encryptedMediaEntry(policy),
        messageRetentionEntry(3600),
      ],
      ciphersuiteImpl: impl,
    });

    const view = getMarmotGroupView(clientState);
    expect(view?.avatarUrl).toBe("https://cdn.example.com/avatar.png");
    expect(view?.encryptedMedia).toEqual(policy);
    expect(view?.messageRetention).toBe(3600n);
  });
});
