/** @module @category Core - Key Package Event */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type GroupContextExtension,
  type Hash,
  type KeyPackage,
  makeKeyPackageRef,
} from "ts-mls";

import { getListTag, getSingletonTagValue } from "../utils/tag-cardinality.js";
import { getAppComponents } from "./components/dictionary.js";
import { ACCOUNT_IDENTITY_PROOF_COMPONENT_ID } from "./components/ids.js";
import { isGreaseValue } from "./grease.js";
import {
  KEY_PACKAGE_APP_COMPONENTS_TAG,
  KEY_PACKAGE_CIPHER_SUITE_TAG,
  KEY_PACKAGE_EXTENSIONS_TAG,
  KEY_PACKAGE_MLS_VERSION_TAG,
  KEY_PACKAGE_PROPOSALS_TAG,
} from "./protocol.js";

/** First Marmot private-use app component id; lower ids are upstream ones. */
const PRIVATE_USE_COMPONENT_ID_START = 0x8000;

/** The `0x`-prefixed, zero-padded, lowercase form of a 16-bit id. */
function idHex(id: number): string {
  return `0x${id.toString(16).padStart(4, "0")}`;
}

/** Thrown when a kind-30443 event's tags do not describe its KeyPackage. */
export class KeyPackageEventMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyPackageEventMetadataError";
  }
}

function requireIdList(
  event: NostrEvent,
  name: string,
  expected: Iterable<number>,
): void {
  const values = getListTag(event, name);
  if (values === undefined)
    throw new KeyPackageEventMetadataError(
      `${name} tag is missing, repeated, empty, or has duplicate values`,
    );
  const want = new Set([...expected].map(idHex));
  if (values.length !== want.size || values.some((v) => !want.has(v)))
    throw new KeyPackageEventMetadataError(
      `${name} tag does not match the decoded KeyPackage`,
    );
}

/**
 * Checks that a kind-30443 KeyPackage event's tags describe the KeyPackage it
 * carries, as `transports/nostr.md` and `foundation/key-packages.md` require
 * before a KeyPackage is used ("required capability tags are missing or
 * incompatible", "the KeyPackageRef hint ... does not match").
 *
 * Mirrors MDK's `key_package_from_borrowed_record`
 * (`marmot-app/src/key_package_records.rs`), so marmot-ts rejects the same
 * events White Noise rejects:
 *
 * - `d` and `i` are single non-empty tags and `mls_protocol_version` is `1.0`;
 * - `mls_ciphersuite`, `mls_extensions`, `mls_proposals` and `app_components`
 *   each appear exactly once, non-empty, without duplicate values;
 * - `mls_ciphersuite` is the KeyPackage's cipher suite;
 * - `mls_extensions` / `mls_proposals` equal the LeafNode's extension /
 *   proposal capabilities (GREASE ignored), compared as sets of `0x%04x`;
 * - `app_components` equals the LeafNode's advertised private-use
 *   (`>= 0x8000`) app components and includes `0x8009`;
 * - `i` is the KeyPackageRef computed with `hash` (the cipher suite's hash).
 *
 * @throws {KeyPackageEventMetadataError} on the first mismatch.
 */
export async function validateKeyPackageEventMetadata(
  event: NostrEvent,
  keyPackage: KeyPackage,
  hash: Hash,
): Promise<void> {
  if (getSingletonTagValue(event, "d") === undefined)
    throw new KeyPackageEventMetadataError("d tag is missing or invalid");
  const ref = getSingletonTagValue(event, "i");
  if (ref === undefined)
    throw new KeyPackageEventMetadataError("i tag is missing or invalid");
  if (getSingletonTagValue(event, KEY_PACKAGE_MLS_VERSION_TAG) !== "1.0")
    throw new KeyPackageEventMetadataError(
      "mls_protocol_version tag is missing or not 1.0",
    );

  const capabilities = keyPackage.leafNode.capabilities;
  requireIdList(event, KEY_PACKAGE_CIPHER_SUITE_TAG, [keyPackage.cipherSuite]);
  requireIdList(
    event,
    KEY_PACKAGE_EXTENSIONS_TAG,
    capabilities.extensions.filter((id) => !isGreaseValue(id)),
  );
  requireIdList(
    event,
    KEY_PACKAGE_PROPOSALS_TAG,
    capabilities.proposals.filter((id) => !isGreaseValue(id)),
  );

  let leafComponents: number[] | undefined;
  try {
    leafComponents = getAppComponents(
      keyPackage.leafNode.extensions as unknown as GroupContextExtension[],
    );
  } catch {
    leafComponents = undefined;
  }
  const advertised = (leafComponents ?? []).filter(
    (id) => id >= PRIVATE_USE_COMPONENT_ID_START,
  );
  if (!advertised.includes(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID))
    throw new KeyPackageEventMetadataError(
      "KeyPackage LeafNode does not advertise app component 0x8009",
    );
  requireIdList(event, KEY_PACKAGE_APP_COMPONENTS_TAG, advertised);

  const computed = bytesToHex(await makeKeyPackageRef(keyPackage, hash));
  if (computed !== ref)
    throw new KeyPackageEventMetadataError(
      "i tag does not match the decoded KeyPackageRef",
    );
}
