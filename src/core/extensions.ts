/** @module @category Core - Extensions */
import {
  type AppDataDictionary,
  appDataDictionaryExtensionType,
  type CustomExtension,
  getAppDataDictionary,
  type KeyPackage,
  makeAppDataDictionaryExtension,
} from "ts-mls";
import { LAST_RESORT_KEY_PACKAGE_COMPONENT_ID } from "./components/ids.js";
import { LAST_RESORT_EXTENSION_TYPE } from "./protocol.js";

/**
 * Checks if an extension is the legacy `last_resort` KeyPackage extension
 * (`0x000a`).
 *
 * @deprecated Marmot marks last-resort KeyPackages with the
 * `last_resort_key_package` component (`0x0004`) in the KeyPackage
 * `app_data_dictionary`, not with this extension. Use
 * {@link isLastResortKeyPackage}, which recognizes both.
 */
export function isLastResortExtension(
  extension: CustomExtension,
): extension is CustomExtension {
  return (
    typeof extension.extensionType === "number" &&
    extension.extensionType === LAST_RESORT_EXTENSION_TYPE
  );
}

/**
 * Decodes the `app_data_dictionary` carried by an extension, or `undefined` if
 * it is not one. Throws if it is one but does not decode.
 */
function decodeDictionaryExtension(
  extension: CustomExtension,
): AppDataDictionary | undefined {
  if (extension.extensionType !== appDataDictionaryExtensionType)
    return undefined;
  return getAppDataDictionary([extension]);
}

/**
 * Whether a KeyPackage is marked last-resort: its KeyPackage extensions carry
 * an `app_data_dictionary` with an empty-data `last_resort_key_package`
 * (`0x0004`) entry (`foundation/key-packages.md`). The legacy `last_resort`
 * extension (`0x000a`) is also recognized so KeyPackages published by older
 * releases still read as last-resort, matching OpenMLS `KeyPackage::last_resort`.
 */
export function isLastResortKeyPackage(keyPackage: KeyPackage): boolean {
  for (const extension of keyPackage.extensions) {
    if (extension.extensionType === LAST_RESORT_EXTENSION_TYPE) return true;
    let dictionary: AppDataDictionary | undefined;
    try {
      dictionary = decodeDictionaryExtension(extension);
    } catch {
      continue;
    }
    const entry = dictionary?.find(
      (c) => c.componentId === LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
    );
    if (entry && entry.data.length === 0) return true;
  }
  return false;
}

/**
 * Returns KeyPackage extensions that mark the KeyPackage as last-resort.
 *
 * Marmot marks a last-resort KeyPackage with an empty-data
 * `last_resort_key_package` component (`0x0004`) in an `app_data_dictionary`
 * KeyPackage extension (`foundation/key-packages.md`, `foundation/registries.md`):
 * "Last-resort status is not an MLS capability or extension type." This is the
 * same encoding OpenMLS (and so MDK / White Noise) emits from
 * `KeyPackageBuilder::mark_as_last_resort` with the `extensions-draft` feature.
 *
 * An existing `app_data_dictionary` extension gets the entry merged in; a legacy
 * `last_resort` extension (`0x000a`) is dropped. Returns the input array
 * unchanged when it already carries the component entry and no legacy extension.
 *
 * @param extensions - The KeyPackage extensions to modify
 * @returns The extensions with the last-resort marker
 */
export function ensureLastResortExtension(
  extensions: CustomExtension[],
): CustomExtension[] {
  const hasLegacy = extensions.some(
    (ext) => ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
  );
  const dictionaryIndex = extensions.findIndex(
    (ext) => ext.extensionType === appDataDictionaryExtensionType,
  );
  const dictionary =
    dictionaryIndex === -1
      ? []
      : (decodeDictionaryExtension(extensions[dictionaryIndex]) ?? []);

  const hasComponent = dictionary.some(
    (c) => c.componentId === LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
  );
  if (hasComponent && !hasLegacy) return extensions;

  const marker = makeAppDataDictionaryExtension(
    hasComponent
      ? dictionary
      : [
          ...dictionary,
          {
            componentId: LAST_RESORT_KEY_PACKAGE_COMPONENT_ID,
            data: new Uint8Array(0),
          },
        ].sort((a, b) => a.componentId - b.componentId),
  );

  const result: CustomExtension[] = [];
  for (const ext of extensions) {
    if (ext.extensionType === LAST_RESORT_EXTENSION_TYPE) continue;
    result.push(
      ext.extensionType === appDataDictionaryExtensionType ? marker : ext,
    );
  }
  if (dictionaryIndex === -1) result.push(marker);
  return result;
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
