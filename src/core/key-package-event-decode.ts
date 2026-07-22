/** @module @category Core - Key Package Event */
import { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteId,
  ciphersuites,
  decode,
  defaultCredentialTypes,
  KeyPackage,
  Lifetime,
  mlsMessageDecoder,
  wireformats,
} from "ts-mls";
import { decodeContent } from "../utils/encoding.js";
import { getTagValue } from "../utils/nostr.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { getCredentialPubkey } from "./credential.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  KEY_PACKAGE_CIPHER_SUITE_TAG,
  KEY_PACKAGE_CLIENT_TAG,
  KEY_PACKAGE_EXTENSIONS_TAG,
  KEY_PACKAGE_MLS_VERSION_TAG,
  KEY_PACKAGE_RELAYS_TAG,
  KeyPackageClient,
  MLS_VERSIONS,
} from "./protocol.js";

/** Get the KeyPackage from a kind 30443 event */
export function getKeyPackage(event: NostrEvent): KeyPackage {
  // Transport byte encoding is always standard base64; the spec forbids an
  // `encoding` tag and forbids switching decoders based on one
  // (transports/nostr.md "Transport byte encoding").
  const content = decodeContent(event.content, "base64");

  // The spec frames kind-30443 content as an MLSMessage with wire_format
  // mls_key_package (transports/nostr.md), a 4-byte header (ProtocolVersion
  // 00 01 + WireFormat 00 05) ahead of the inner KeyPackage. This mirrors the
  // kind-444 welcome framing and is what the darkmatter reference engine emits.
  // We only accept this framed form — bare KeyPackage content is not spec
  // conformant and is rejected.
  const message = decode(mlsMessageDecoder, content);
  if (!message) throw new Error("Failed to decode key package event content");
  if (message.wireformat !== wireformats.mls_key_package)
    throw new Error(
      `Expected MLSMessage with mls_key_package wireformat, got wireformat ${message.wireformat}`,
    );

  return message.keyPackage;
}

/**
 * Reads the inbound MLS `Lifetime` ({@link Lifetime}) from a kind 30443
 * event's decoded KeyPackage leaf node (WIRE-01 inbound read). Returns
 * `undefined` when the event cannot be decoded as a KeyPackage — never
 * throws, matching the project's typed-reject convention for boundary
 * readers (D-08).
 */
export function getKeyPackageLifetime(event: NostrEvent): Lifetime | undefined {
  try {
    return getKeyPackage(event).leafNode.lifetime;
  } catch {
    return undefined;
  }
}

/** Gets the MLS protocol version from a kind 30443 event */
export function getKeyPackageMLSVersion(
  event: NostrEvent,
): MLS_VERSIONS | undefined {
  const version = getTagValue(event, KEY_PACKAGE_MLS_VERSION_TAG);
  return version as MLS_VERSIONS | undefined;
}

/** Gets the MLS cipher suite from a kind 30443 event */
export function getKeyPackageCipherSuiteId(
  event: NostrEvent,
): CiphersuiteId | undefined {
  const cipherSuite = getTagValue(event, KEY_PACKAGE_CIPHER_SUITE_TAG);
  if (!cipherSuite) return undefined;

  const id = parseInt(cipherSuite) as CiphersuiteId;

  // Verify that cipher suite is a valid ID
  if (!(Object.values(ciphersuites) as number[]).includes(id)) {
    throw new Error(`Invalid MLS cipher suite ID ${id}`);
  }

  return id;
}

/** Gets the MLS extensions for a kind 30443 event */
export function getKeyPackageExtensions(
  event: NostrEvent,
): number[] | undefined {
  const tag = event.tags.find((t) => t[0] === KEY_PACKAGE_EXTENSIONS_TAG);
  if (!tag) return undefined;

  const ids = tag
    .slice(1)
    // NOTE: we are intentially not passing a radix to parseInt here so that it can handle base 10 and 16 (with leading 0x)
    .map((t) => parseInt(t))
    .filter((id) => Number.isFinite(id));

  return ids;
}

/** Gets the relays for a kind 30443 event */
export function getKeyPackageRelays(event: NostrEvent): string[] | undefined {
  const tag = event.tags.find((t) => t[0] === KEY_PACKAGE_RELAYS_TAG);
  if (!tag) return;
  return tag.slice(1).filter(isValidRelayUrl).map(normalizeRelayUrl);
}

/** Gets the client for a kind 30443 event */
export function getKeyPackageClient(
  event: NostrEvent,
): KeyPackageClient | undefined {
  const tag = event.tags.find((t) => t[0] === KEY_PACKAGE_CLIENT_TAG);
  if (!tag) return undefined;

  // TODO: parse the rest of the client tag
  return {
    name: tag[1],
  };
}

/**
 * Gets the addressable slot identifier (`d` tag) from a kind 30443 event.
 */
export function getKeyPackageIdentifier(event: NostrEvent): string | undefined {
  if (event.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) return undefined;
  return getTagValue(event, "d");
}

/**
 * Gets the nostr public key from a key package event.
 *
 * @param event - The key package event (kind 30443)
 * @returns The nostr public key (hex string)
 * @throws Error if the credential is not a basic credential
 */
export function getKeyPackageNostrPubkey(event: NostrEvent): string {
  const keyPackage = getKeyPackage(event);

  if (
    keyPackage.leafNode.credential.credentialType !==
    defaultCredentialTypes.basic
  ) {
    throw new Error(
      "Key package does not use a basic credential, cannot get nostr public key",
    );
  }

  return getCredentialPubkey(keyPackage.leafNode.credential);
}

/**
 * Returns the KeyPackageRef (MIP-00 `i` tag value) from a kind 30443
 * KeyPackage event.
 *
 * Per MIP-00, KeyPackage events MUST include this tag.
 */
export function getKeyPackageReference(event: NostrEvent): string | undefined {
  return getTagValue(event, "i");
}
