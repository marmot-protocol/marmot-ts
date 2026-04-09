import { describe, expect, it } from "vitest";
import { CustomExtension, makeCustomExtension } from "ts-mls";
import { ensureLastResortExtension } from "../extensions.js";
import { LAST_RESORT_EXTENSION_TYPE } from "../protocol.js";

describe("ensureLastResortExtension", () => {
  it("should add last resort extension when not present", () => {
    const extensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: 0x1234,
        extensionData: new Uint8Array([1, 2, 3]),
      }),
    ];

    const result = ensureLastResortExtension(extensions);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(extensions[0]);
    expect(result[1]).toEqual(
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
    );
  });

  it("should not add last resort extension when already present", () => {
    const extensions: CustomExtension[] = [
      makeCustomExtension({
        extensionType: 0x1234,
        extensionData: new Uint8Array([1, 2, 3]),
      }),
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
    ];

    const result = ensureLastResortExtension(extensions);

    expect(result).toHaveLength(2);
    expect(result).toEqual(extensions);
  });

  it("should handle empty extensions array", () => {
    const extensions: CustomExtension[] = [];

    const result = ensureLastResortExtension(extensions);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
    );
  });

  it("should preserve original array when last resort extension is present", () => {
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

    expect(result).toBe(extensions);
    expect(result).toHaveLength(2);
  });
});
