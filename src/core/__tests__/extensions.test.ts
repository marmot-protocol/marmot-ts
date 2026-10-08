import { describe, expect, it } from "vitest";
import {
  appDataDictionaryExtensionType,
  CustomExtension,
  getAppDataDictionary,
  makeCustomExtension,
} from "ts-mls";
import { LAST_RESORT_KEY_PACKAGE_COMPONENT_ID } from "../components/ids.js";
import { ensureLastResortExtension } from "../extensions.js";
import { LAST_RESORT_EXTENSION_TYPE } from "../protocol.js";

const lastResortEntry = {
  componentId: LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
  data: new Uint8Array(0),
};

describe("ensureLastResortExtension", () => {
  it("should add the last_resort_key_package component when not present", () => {
    const extensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: 0x1234,
        extensionData: new Uint8Array([1, 2, 3]),
      }),
    ];

    const result = ensureLastResortExtension(extensions);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(extensions[0]);
    expect(result[1].extensionType).toBe(appDataDictionaryExtensionType);
    expect(getAppDataDictionary(result)).toEqual([lastResortEntry]);
  });

  it("should not change extensions that already carry the component", () => {
    const extensions = ensureLastResortExtension([]);

    const result = ensureLastResortExtension(extensions);

    expect(result).toBe(extensions);
  });

  it("should handle empty extensions array", () => {
    const result = ensureLastResortExtension([]);

    expect(result).toHaveLength(1);
    expect(getAppDataDictionary(result)).toEqual([lastResortEntry]);
  });

  it("should replace the legacy last_resort extension", () => {
    const extensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
      makeCustomExtension({
        extensionType: 0x2345,
        extensionData: new Uint8Array([4, 5, 6]),
      }),
    ];

    const result = ensureLastResortExtension(extensions);

    expect(result.map((e) => e.extensionType)).toEqual([
      0x2345,
      appDataDictionaryExtensionType,
    ]);
    expect(getAppDataDictionary(result)).toEqual([lastResortEntry]);
  });
});
