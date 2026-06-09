import { describe, expect, it } from "vitest";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";

import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { createGroup } from "../group.js";
import { getMarmotGroupView } from "../client-state.js";
import {
  adminPolicyEntry,
  getAppComponents,
  groupProfileEntry,
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
  });
});
