import { bytesToHex } from "@noble/hashes/utils.js";
import {
  appDataDictionaryExtensionType,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  makeCustomExtension,
  makeAppDataDictionaryExtension,
  type KeyPackage,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { LAST_RESORT_KEY_PACKAGE_COMPONENT_ID } from "../components/ids.js";
import { createCredential } from "../credential.js";
import {
  ensureLastResortExtension,
  isLastResortKeyPackage,
} from "../extensions.js";
import { generateKeyPackage } from "../key-package.js";
import { createKeyPackageEvent, getKeyPackage } from "../key-package-event.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  LAST_RESORT_EXTENSION_TYPE,
} from "../protocol.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

// A kind-30443 KeyPackage published by MDK HEAD (ec6c2bc2, `wnd`) to a local
// relay. OpenMLS `KeyPackageBuilder::mark_as_last_resort` (extensions-draft)
// marked it last-resort with an app_data_dictionary KeyPackage extension holding
// one empty `last_resort_key_package` (0x0004) entry.
const MDK_KEY_PACKAGE_CONTENT =
  "AAEABQABAAEgSkcmFyKmPCDehCVuWilO47tB8bG7Mo2Hm/xL4vIqaD0geGpLsA82k5hoOaPZlG5vMMFQHUsqf/3zNt0Fbsws+hwgVdfM14BI7pevebcAErtUS4LrMytgD0iAHpUhSUB7+UIAASAJSu7H9h6dBMQ7swYEp/tpCvX2ZBDhfQTguyxLD8o7AgIAAQIAAQgABvLR8tLy1AQACgAIAgABAQAAAABqwtY+AAAAAGsxok5AkgAGQI5AjAABGRgAAYABgAKAA4AEgAWABoAHgAiACYALgAwAAgEAgAlAaAlK7sf2Hp0ExDuzBgSn+2kK9fZkEOF9BOC7LEsPyjsCAAAAAGrC5E0Q/z0OCJwrziov4IPfK3/6G9G5PQd88238zE4KxdVHbLSR4FG2KGKaNXjy03VYWJF9te8jf6cegTiX6qoWTjkYQEAe40jCr4dQ9ixm7wLw5I6tf+WzUY2xg2Qfh2f7XON5ptZWZqhu6CWZkHfmEU7x9SfT6KKDfkfh7a99SzHFFlEBBwAGBAMABABAQNDlxAIc6w9otC103SQ+ntu6qAQ75M3QFGDIKCno57AGbm+PwAcLPqbJTXyTI+xJqa8tu+Q4hn/uT/FysmfuXAo=";
const MDK_PUBKEY =
  "094aeec7f61e9d04c43bb30604a7fb690af5f66410e17d04e0bb2c4b0fca3b02";

// TLS bytes of that extension's data: varint length 3, ComponentID 0x0004,
// empty opaque data.
const LAST_RESORT_DICTIONARY_BYTES = "03000400";

function extensionHex(keyPackage: KeyPackage, type: number) {
  const ext = keyPackage.extensions.find((e) => e.extensionType === type);
  return ext ? bytesToHex(ext.extensionData as Uint8Array) : undefined;
}

describe("last-resort KeyPackage marking", () => {
  const account = testAccount(11);

  async function generate(isLastResort?: boolean) {
    const ciphersuiteImpl = await getCiphersuiteImpl(
      SUITE,
      defaultCryptoProvider,
    );
    return (
      await generateKeyPackage({
        credential: createCredential(account.pubkey),
        ciphersuiteImpl,
        signer: account.signer,
        isLastResort,
      })
    ).publicPackage;
  }

  const mdkKeyPackage = getKeyPackage({
    kind: ADDRESSABLE_KEY_PACKAGE_KIND,
    pubkey: MDK_PUBKEY,
    content: MDK_KEY_PACKAGE_CONTENT,
    tags: [],
    created_at: 0,
    id: "",
    sig: "",
  });

  it("MDK marks last-resort with the 0x0004 component, not the 0x000a extension", () => {
    expect(mdkKeyPackage.extensions.map((e) => e.extensionType)).toEqual([
      appDataDictionaryExtensionType,
    ]);
    expect(extensionHex(mdkKeyPackage, appDataDictionaryExtensionType)).toBe(
      LAST_RESORT_DICTIONARY_BYTES,
    );
    expect(mdkKeyPackage.leafNode.capabilities.extensions).not.toContain(
      LAST_RESORT_EXTENSION_TYPE,
    );
    expect(isLastResortKeyPackage(mdkKeyPackage)).toBe(true);
  });

  it("a default KeyPackage carries the same marker bytes as MDK", async () => {
    const keyPackage = await generate();
    expect(keyPackage.extensions.map((e) => e.extensionType)).toEqual([
      appDataDictionaryExtensionType,
    ]);
    expect(extensionHex(keyPackage, appDataDictionaryExtensionType)).toBe(
      extensionHex(mdkKeyPackage, appDataDictionaryExtensionType),
    );
    expect(isLastResortKeyPackage(keyPackage)).toBe(true);
  });

  it("does not advertise the legacy last_resort extension type", async () => {
    const keyPackage = await generate();
    expect(keyPackage.leafNode.capabilities.extensions).not.toContain(
      LAST_RESORT_EXTENSION_TYPE,
    );
    const event = await createKeyPackageEvent({
      keyPackage,
      identifier: "a".repeat(64),
    });
    const tag = event.tags.find((t) => t[0] === "mls_extensions");
    expect(tag).toBeDefined();
    expect(tag).not.toContain("0x000a");
  });

  it("isLastResort=false omits the marker", async () => {
    const keyPackage = await generate(false);
    expect(keyPackage.extensions).toEqual([]);
    expect(isLastResortKeyPackage(keyPackage)).toBe(false);
  });

  it("still recognizes the legacy 0x000a extension on read", () => {
    const legacy = {
      ...mdkKeyPackage,
      extensions: [
        makeCustomExtension({
          extensionType: LAST_RESORT_EXTENSION_TYPE,
          extensionData: new Uint8Array(0),
        }),
      ],
    } as KeyPackage;
    expect(isLastResortKeyPackage(legacy)).toBe(true);
  });

  it("a non-empty 0x0004 entry is not a last-resort marker", () => {
    const malformed = {
      ...mdkKeyPackage,
      extensions: [
        makeAppDataDictionaryExtension([
          {
            componentId: LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
            data: new Uint8Array([1]),
          },
        ]),
      ],
    } as KeyPackage;
    expect(isLastResortKeyPackage(malformed)).toBe(false);
  });

  it("ensureLastResortExtension merges into an existing dictionary and drops the legacy extension", () => {
    const result = ensureLastResortExtension([
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
      makeAppDataDictionaryExtension([
        { componentId: 0x8001, data: new Uint8Array([7]) },
      ]),
    ]);
    expect(result.map((e) => e.extensionType)).toEqual([
      appDataDictionaryExtensionType,
    ]);
    // 2 entries: 0x0004 (empty) then 0x8001 (one byte 0x07), sorted by id.
    expect(bytesToHex(result[0].extensionData as Uint8Array)).toBe(
      "07" + "000400" + "80010107",
    );
  });
});
