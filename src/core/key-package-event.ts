import { bytesToHex } from "@noble/hashes/utils.js";
import { EventTemplate, NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteId,
  CustomExtension,
  ciphersuites,
  decode,
  defaultCredentialTypes,
  encode,
  KeyPackage,
  keyPackageDecoder,
  keyPackageEncoder,
  protocolVersions,
} from "ts-mls";
import {
  decodeContent,
  encodeContent,
  getEncodingTag,
} from "../utils/encoding.js";
import { getTagValue, unixNow } from "../utils/nostr.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { getCredentialPubkey } from "./credential.js";
import { isGreaseValue } from "./grease.js";
import { calculateKeyPackageRef } from "./key-package.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  KEY_PACKAGE_CIPHER_SUITE_TAG,
  KEY_PACKAGE_CLIENT_TAG,
  KEY_PACKAGE_EXTENSIONS_TAG,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_MLS_VERSION_TAG,
  KEY_PACKAGE_RELAYS_TAG,
  KeyPackageClient,
  MLS_VERSIONS,
} from "./protocol.js";

export type DeleteKeyPackageEventInput = string | NostrEvent;

export type CreateDeleteKeyPackageEventOptions = {
  /** List of event ids (or full events) to delete */
  events: DeleteKeyPackageEventInput[];
};

/**
 * Creates a NIP-09 delete event (kind 5) to delete one or more key package
 * events (kind 443 or kind 30443).
 *
 * For kind 30443 events, both an `e` tag (event id) and an `a` tag
 * (addressable coordinate) are included so relays can match either way.
 * For kind 443 events, only an `e` tag is included (as before).
 * String-only inputs produce only `e` tags since no pubkey/d is available.
 */
export function createDeleteKeyPackageEvent(
  options: CreateDeleteKeyPackageEventOptions,
): EventTemplate {
  const { events } = options;
  if (!events || events.length === 0) {
    throw new Error("At least one event must be provided for deletion");
  }

  const eTags: string[][] = [];
  const aTags: string[][] = [];
  const kValues = new Set<string>();

  for (const e of events) {
    if (typeof e === "string") {
      // String id only — no kind info available, emit e tag without k inference
      eTags.push(["e", e]);
    } else {
      if (
        e.kind !== KEY_PACKAGE_KIND &&
        e.kind !== ADDRESSABLE_KEY_PACKAGE_KIND
      ) {
        throw new Error(
          `Event ${e.id} is not a key package event (kind ${e.kind} instead of ${KEY_PACKAGE_KIND} or ${ADDRESSABLE_KEY_PACKAGE_KIND})`,
        );
      }
      kValues.add(String(e.kind));
      eTags.push(["e", e.id]);

      if (e.kind === ADDRESSABLE_KEY_PACKAGE_KIND) {
        const d = getKeyPackageD(e);
        if (d !== undefined) {
          aTags.push(["a", `${ADDRESSABLE_KEY_PACKAGE_KIND}:${e.pubkey}:${d}`]);
        }
      }
    }
  }

  // Build k tags from the set of observed kinds (for full NostrEvent inputs)
  // If only string ids were provided, fall back to tagging both known kinds
  const kTags: string[][] =
    kValues.size > 0
      ? [...kValues].map((k) => ["k", k])
      : [
          ["k", String(KEY_PACKAGE_KIND)],
          ["k", String(ADDRESSABLE_KEY_PACKAGE_KIND)],
        ];

  return {
    kind: 5,
    created_at: unixNow(),
    content: "",
    tags: [...kTags, ...eTags, ...aTags],
  };
}

/** Get the KeyPackage from a kind 443 or kind 30443 event */
export function getKeyPackage(event: NostrEvent): KeyPackage {
  const encodingFormat = getEncodingTag(event);
  if (encodingFormat !== "base64") {
    throw new Error(
      "KeyPackage event must include encoding=base64 tag (hex and missing tags are rejected)",
    );
  }
  const content = decodeContent(event.content, encodingFormat);
  const decoded = decode(keyPackageDecoder, content);
  if (!decoded) throw new Error("Failed to decode key package");

  return decoded;
}

/** Gets the MLS protocol version from a kind 443 or kind 30443 event */
export function getKeyPackageMLSVersion(
  event: NostrEvent,
): MLS_VERSIONS | undefined {
  const version = getTagValue(event, KEY_PACKAGE_MLS_VERSION_TAG);
  return version as MLS_VERSIONS | undefined;
}

/** Gets the MLS cipher suite from a kind 443 or kind 30443 event */
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

/** Gets the MLS extensions for a kind 443 or kind 30443 event */
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

/** Gets the relays for a kind 443 or kind 30443 event */
export function getKeyPackageRelays(event: NostrEvent): string[] | undefined {
  const tag = event.tags.find((t) => t[0] === KEY_PACKAGE_RELAYS_TAG);
  if (!tag) return;
  return tag.slice(1).filter(isValidRelayUrl).map(normalizeRelayUrl);
}

/** Gets the client for a kind 443 or kind 30443 event */
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
 * Returns `undefined` for kind 443 events (which have no `d` tag).
 */
export function getKeyPackageD(event: NostrEvent): string | undefined {
  return getTagValue(event, "d");
}

export type CreateKeyPackageEventOptions = {
  keyPackage: KeyPackage;
  /**
   * The addressable slot identifier (`d` tag value). Required — callers must
   * supply this; {@link KeyPackageManager} handles defaulting to `clientId` or
   * throwing {@link MissingSlotIdentifierError} when none is available.
   */
  d: string;
  /** Relay URLs to advertise in the event */
  relays?: string[];
  client?: string;
  /**
   * Whether to include the NIP-70 protected tag (["-"]).
   *
   * Per MIP-00 this SHOULD be omitted by default because many relays reject
   * protected events.
   */
  protected?: boolean;
};

/**
 * Creates an addressable key package event (kind 30443) from a key package.
 *
 * @param options - The options for creating the key package event
 * @returns The unsigned key package event template
 */
export function createKeyPackageEvent(
  options: CreateKeyPackageEventOptions,
): Promise<EventTemplate> {
  return createKeyPackageEventInternal(options);
}

async function createKeyPackageEventInternal(
  options: CreateKeyPackageEventOptions,
): Promise<EventTemplate> {
  const { keyPackage, relays, client } = options;

  // Serialize the key package according to RFC 9420
  const encodedBytes = encode(keyPackageEncoder, keyPackage);
  const content = encodeContent(encodedBytes, "base64");

  // Get the cipher suite from the key package
  // ts-mls v2: keyPackage.cipherSuite is a numeric id already
  const ciphersuiteHex = `0x${keyPackage.cipherSuite
    .toString(16)
    .padStart(4, "0")}`;

  // Extract extension types from the key package extensions
  const extensionTypes = keyPackage.extensions.map((ext: CustomExtension) => {
    // Extension type is now always a number in v2
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
    return !isGreaseValue(extType);
  });

  // Get the protocol version - keyPackage.version is a numeric ProtocolVersionValue
  // NIP tag expects a display string like "1.0".
  const versionName = (
    Object.keys(protocolVersions) as Array<keyof typeof protocolVersions>
  ).find((k) => protocolVersions[k] === keyPackage.version);
  const version = versionName === "mls10" ? "1.0" : String(keyPackage.version);

  // Build tags
  const tags: string[][] = [];

  // NIP-70: protected event — relay must not serve this event to non-authors.
  // NOTE: Optional/opt-in because many popular relays reject protected events.
  if (options.protected) tags.push(["-"]);

  // Addressable identifier (required for kind 30443)
  tags.push(["d", options.d]);

  tags.push(
    [KEY_PACKAGE_MLS_VERSION_TAG, version],
    [KEY_PACKAGE_CIPHER_SUITE_TAG, ciphersuiteHex],
    [KEY_PACKAGE_EXTENSIONS_TAG, ...filteredExtensionTypes],
    ["encoding", "base64"],
  );

  // MIP-00: required KeyPackageRef tag ("i")
  const keyPackageRef = await calculateKeyPackageRef(keyPackage);
  tags.push(["i", bytesToHex(keyPackageRef)]);

  // Add client tag if provided
  if (client) tags.push([KEY_PACKAGE_CLIENT_TAG, client]);

  // Add relay tags if provided
  if (relays && relays.length > 0) {
    const validRelays = relays.filter(isValidRelayUrl).map(normalizeRelayUrl);
    if (validRelays.length > 0) {
      tags.push([KEY_PACKAGE_RELAYS_TAG, ...validRelays]);
    }
  }

  return {
    kind: ADDRESSABLE_KEY_PACKAGE_KIND,
    created_at: unixNow(),
    content,
    tags,
  };
}

/**
 * Gets the nostr public key from a key package event.
 *
 * @param event - The key package event (kind 443 or kind 30443)
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
 * Returns the KeyPackageRef (MIP-00 `i` tag value) from a kind 443 or kind
 * 30443 KeyPackage event.
 *
 * Per MIP-00, new events MUST include this tag. Older events may not.
 */
export function getKeyPackageReference(event: NostrEvent): string | undefined {
  return getTagValue(event, "i");
}
