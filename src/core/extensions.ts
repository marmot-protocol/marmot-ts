import { type CustomExtension, makeCustomExtension } from "ts-mls";
import {
  LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
} from "./protocol.js";

/**
 * Validates that a key package supports the required Marmot extensions.
 *
 * @param extensions - The extensions from a key package
 * @returns true if the Marmot Group Data Extension is supported
 */
export function supportsMarmotExtensions(
  extensions: Array<{ extensionType: number }>,
): boolean {
  return extensions.some(
    (ext) =>
      typeof ext.extensionType === "number" &&
      ext.extensionType === MARMOT_GROUP_DATA_EXTENSION_TYPE,
  );
}

/**
 * Modifies an {@link Extension} array to ensure it includes the last_resort extension.
 * This is useful for ensuring that key packages are compliant with MIP-00.
 *
 * @param extensions - The extensions to modify
 * @returns The modified extensions
 */
export function ensureLastResortExtension(
  extensions: CustomExtension[],
): CustomExtension[] {
  if (
    extensions.some(
      (ext) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
    )
  )
    return extensions;

  return [
    ...extensions,
    makeCustomExtension({
      extensionType: LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
      extensionData: new Uint8Array(0),
    }),
  ];
}

/** Replaces an extension in an array of extensions */
export function replaceExtension(
  extensions: Array<{ extensionType: number }>,
  extension: { extensionType: number },
): Array<{ extensionType: number }> {
  return extensions.map((ext) =>
    ext.extensionType === extension.extensionType ? extension : ext,
  );
}
