import { describe, expect, it } from "vitest";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";

import { createCredential } from "../core/credential.js";
import { generateKeyPackage } from "../core/key-package.js";
import { createGroup } from "../core/group.js";
import { extractMarmotGroupData } from "../core/client-state.js";

describe("MIP-01: group construction", () => {
  it("createGroup always includes a decodable Marmot Group Data extension", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const marmotGroupData = {
      version: 2,
      nostrGroupId: new Uint8Array(32).fill(7),
      name: "Test Group",
      description: "",
      adminPubkeys: [adminPubkey],
      relays: ["wss://relay.example.com"],
      imageHash: new Uint8Array(0),
      imageKey: new Uint8Array(0),
      imageNonce: new Uint8Array(0),
      imageUploadKey: new Uint8Array(0),
    };

    const { clientState } = await createGroup({
      creatorKeyPackage: kp,
      marmotGroupData,
      ciphersuiteImpl: impl,
    });

    const extracted = extractMarmotGroupData(clientState);
    expect(extracted).toBeTruthy();
    expect(extracted?.nostrGroupId).toEqual(marmotGroupData.nostrGroupId);
    expect(extracted?.adminPubkeys).toEqual([adminPubkey]);
    expect(extracted?.relays).toEqual(["wss://relay.example.com"]);

    // MIP-01 privacy: MLS group_id must be distinct from the public nostr_group_id.
    expect(clientState.groupContext.groupId).not.toEqual(
      marmotGroupData.nostrGroupId,
    );
  });
});
