import { NostrEvent, UnsignedEvent } from "applesauce-core/helpers/event";
import { Capabilities } from "ts-mls/capabilities.js";
import { Credential } from "ts-mls/credential.js";
import {
  CiphersuiteId,
  CiphersuiteImpl,
  ciphersuites,
} from "ts-mls/crypto/ciphersuite.js";
import { CustomExtension } from "ts-mls/extension.js";
import { greaseValues } from "ts-mls/grease.js";
import {
  KeyPackage,
  generateKeyPackage as MLSGenerateKeyPackage,
  PrivateKeyPackage,
  keyPackageDecoder,
  keyPackageEncoder,
} from "ts-mls/keyPackage.js";
import { Lifetime } from "ts-mls/lifetime.js";
import { decode, encode, defaultCredentialTypes } from "ts-mls";
import {
  decodeContent,
  encodeContent,
  getEncodingTag,
} from "../utils/encoding.js";
import { getTagValue, unixNow } from "../utils/nostr.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { createThreeMonthLifetime } from "../utils/timestamp.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { getCredentialPubkey } from "./credential.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { ensureLastResortExtension } from "./extensions.js";
import {
  KEY_PACKAGE_CIPHER_SUITE_TAG,
  KEY_PACKAGE_CLIENT_TAG,
  KEY_PACKAGE_EXTENSIONS_TAG,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_MLS_VERSION_TAG,
  KEY_PACKAGE_RELAYS_TAG,
  KeyPackageClient,
  MLS_VERSIONS,
} from "./protocol.js";

/**
 * A complete key package containing both public and private components.
 *
 * The public package can be shared with others to add this participant to groups,
 * while the private package must be kept secret and is used for decryption and signing.
 */
export type CompleteKeyPackage = {
  /** The public key package that can be shared with others */
  publicPackage: KeyPackage;
  /** The private key package that must be kept secret */
  privatePackage: PrivateKeyPackage;
};

/** Get the {@link KeyPackage} from a kind 443 event */
export function getKeyPackage(event: NostrEvent): KeyPackage {
  // Check for encoding tag, default to hex for backward compatibility
  const encodingFormat = getEncodingTag(event) ?? "hex";
  const content = decodeContent(event.content, encodingFormat);
  const decoded = decode(keyPackageDecoder, content);
  if (!decoded) throw new Error("Failed to decode key package");

  return decoded;
}

/** Gets the MLS protocol version from a kind 443 event */
export function getKeyPackageMLSVersion(
  event: NostrEvent,
): MLS_VERSIONS | undefined {
  const version = getTagValue(event, KEY_PACKAGE_MLS_VERSION_TAG);
  return version as MLS_VERSIONS | undefined;
}

/** Gets the MLS cipher suite from a kind 443 event */
export function getKeyPackageCipherSuiteId(
  event: NostrEvent,
): CiphersuiteId | undefined {
  const cipherSuite = getTagValue(event, KEY_PACKAGE_CIPHER_SUITE_TAG);
  if (!cipherSuite) return undefined;

  // NOTE: we are intentially not passing a radix to parseInt here so that it can handle base 10 and 16 (with leading 0x)
  const id = parseInt(cipherSuite);

  // Verify that cipher suite is a valid ID
  if (!Object.values(ciphersuites).includes(id as CiphersuiteId))
    throw new Error(`Invalid MLS cipher suite ID ${id}`);

  // Cast number to CiphersuiteId
  return id as CiphersuiteId;
}

/** Gets the MLS extensions for a kind 443 event */
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

/** Gets the relays for a kind 443 event */
export function getKeyPackageRelays(event: NostrEvent): string[] | undefined {
  const tag = event.tags.find((t) => t[0] === KEY_PACKAGE_RELAYS_TAG);
  if (!tag) return undefined;
  return tag.slice(1).filter(isValidRelayUrl).map(normalizeRelayUrl);
}

/** Gets the client for a kind 443 event */
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

/** Create default extensions for a key package */
export function keyPackageDefaultExtensions(): CustomExtension[] {
  return ensureLastResortExtension([]);
}

/** Options for generating a marmot key package */
export type GenerateKeyPackageOptions = {
  credential: Credential;
  capabilities?: Capabilities;
  lifetime?: Lifetime;
  extensions?: CustomExtension[];
  ciphersuiteImpl: CiphersuiteImpl;
};

/** Generate a marmot key package that is compliant with MIP-00 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  ciphersuiteImpl,
}: GenerateKeyPackageOptions): Promise<CompleteKeyPackage> {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error("Marmot key packages must use a basic credential");

  // Ensure the credential has a valid pubkey
  getCredentialPubkey(credential);

  return await MLSGenerateKeyPackage({
    credential,
    capabilities: capabilities
      ? ensureMarmotCapabilities(capabilities)
      : defaultCapabilities(),
    lifetime: lifetime ?? createThreeMonthLifetime(),
    extensions: extensions
      ? ensureLastResortExtension(extensions)
      : keyPackageDefaultExtensions(),
    cipherSuite: ciphersuiteImpl,
  });
}

export type CreateKeyPackageEventOptions = {
  /** The MLS key package to encode in the event */
  keyPackage: KeyPackage;
  /** The pubkey of the event author (must match the credential in the key package) */
  pubkey: string;
  /** The relays where this key package should be published */
  relays: string[];
  /** Optional client identifier (e.g., "marmot-examples") */
  client?: string;
};

/**
 * Creates an unsigned Nostr event (kind 443) for a MLS key package.
 * The event can be signed and published to allow others to add the user to MLS groups.
 *
 * @param options - Configuration for creating the key package event
 * @returns An unsigned Nostr event ready to be signed and published
 */
export function createKeyPackageEvent(
  options: CreateKeyPackageEventOptions,
): UnsignedEvent {
  const { keyPackage, pubkey, relays, client } = options;

  if (
    keyPackage.leafNode.credential.credentialType !==
    defaultCredentialTypes.basic
  )
    throw new Error(
      "Key package leaf node credential is not a basic credential",
    );

  if (pubkey !== getCredentialPubkey(keyPackage.leafNode.credential))
    throw new Error(
      "Key package leaf node credential pubkey does not match the event pubkey",
    );

  // Encode the public key package to bytes
  const encodedBytes = encode(keyPackageEncoder, keyPackage);
  const content = encodeContent(encodedBytes, "base64");

  // Get the cipher suite from the key package
  const ciphersuiteHex = `0x${keyPackage.cipherSuite
    .toString(16)
    .padStart(4, "0")}`;

  // Extract extension types from the key package extensions
  const extensionTypes = keyPackage.extensions.map((ext: CustomExtension) => {
    return `0x${ext.extensionType.toString(16).padStart(4, "0")}`;
  });

  // Also include extensions from leaf node capabilities to signal support
  // This ensures Marmot Group Data Extension (0xf2ee) is included in the event
  if (keyPackage.leafNode.capabilities?.extensions) {
    for (const extType of keyPackage.leafNode.capabilities.extensions) {
      // Only add if not already present (avoid duplicates)
      const hexValue = `0x${extType.toString(16).padStart(4, "0")}`;
      if (!extensionTypes.includes(hexValue)) {
        extensionTypes.push(hexValue);
      }
    }
  }

  // Filter out GREASE values from the extension types
  // We only want to include actual extensions (last_resort and Marmot Group Data Extension)
  const filteredExtensionTypes = extensionTypes.filter((hexValue) => {
    // Parse the hex value back to number to check if it's a GREASE value
    const extType = parseInt(hexValue);
    return !greaseValues.includes(extType);
  });

  const version = keyPackage.version.toFixed(1);

  // Build tags
  const tags: string[][] = [
    [KEY_PACKAGE_MLS_VERSION_TAG, version],
    [KEY_PACKAGE_CIPHER_SUITE_TAG, ciphersuiteHex],
    [KEY_PACKAGE_EXTENSIONS_TAG, ...filteredExtensionTypes],
    ["encoding", "base64"],
  ];

  // Add client tag if provided
  if (client) tags.push([KEY_PACKAGE_CLIENT_TAG, client]);

  // Add relays tag
  tags.push([KEY_PACKAGE_RELAYS_TAG, ...relays]);

  return {
    kind: KEY_PACKAGE_KIND,
    created_at: unixNow(),
    tags,
    content,
    pubkey,
  };
}

export type CreateDeleteKeyPackageEventOptions = {
  /** The pubkey of the event author (must match the author of the key packages being deleted) */
  pubkey: string;
  /** Array of event IDs or full events to delete (must all be kind 443) */
  events: (string | NostrEvent)[];
};

/**
 * Creates an unsigned Nostr event (kind 5) to delete multiple key package events.
 * The event can be signed and published to request deletion of key packages.
 *
 * @param options - Configuration for creating the delete event
 * @returns An unsigned Nostr event ready to be signed and published
 * @throws Error if any of the events are not kind 443
 */
export function createDeleteKeyPackageEvent(
  options: CreateDeleteKeyPackageEventOptions,
): UnsignedEvent {
  const { pubkey, events } = options;

  if (events.length === 0)
    throw new Error("At least one event must be provided for deletion");

  // Extract event IDs and validate that all events are kind 443
  const eventIds: string[] = [];
  for (const event of events) {
    if (typeof event === "string") {
      // If it's just an ID, we can't validate the kind, so we trust the caller
      eventIds.push(event);
    } else {
      // If it's a full event, validate it's kind 443
      if (event.kind !== KEY_PACKAGE_KIND) {
        throw new Error(
          `Event ${event.id} is not a key package event (kind ${event.kind} instead of ${KEY_PACKAGE_KIND})`,
        );
      }
      eventIds.push(event.id);
    }
  }

  // Build tags with e tags for each event and a k tag for kind 443
  const tags: string[][] = [
    ["k", KEY_PACKAGE_KIND.toString()],
    ...eventIds.map((id) => ["e", id]),
  ];

  return {
    kind: 5,
    created_at: unixNow(),
    tags,
    content: "",
    pubkey,
  };
}
