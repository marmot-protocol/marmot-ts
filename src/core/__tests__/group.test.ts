import { describe, expect, it } from "vitest";
import {
  defaultCryptoProvider,
  defaultExtensionTypes,
  type ExtensionRequiredCapabilities,
  getCiphersuiteImpl,
} from "ts-mls";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { createGroup } from "../group.js";
import { marmotRequiredCapabilitiesExtension } from "../capabilities.js";
import { getMarmotGroupView } from "../client-state.js";
import {
  adminPolicyEntry,
  encryptedMediaBlossomDefault,
  encryptedMediaEntry,
  getAppComponents,
  groupAvatarUrlEntry,
  groupProfileEntry,
  messageRetentionEntry,
  nostrRoutingEntry,
} from "../components/index.js";

describe("group construction", () => {
  it("createGroup seeds a decodable app_data_dictionary from components", async () => {
    const adminPubkey = "a".repeat(64);
    const nostrGroupId = new Uint8Array(32).fill(7);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

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

    // The app_components (0x0001) advertising entry lists the provided ids.
    expect(getAppComponents(clientState.groupContext.extensions)).toEqual([
      0x8001, 0x8003, 0x8004,
    ]);

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

  it("surfaces avatar, encrypted-media policy, and retention through the group view", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
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
