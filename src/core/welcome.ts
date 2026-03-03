import { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  getEventHash,
  getTagValue,
  NostrEvent,
} from "applesauce-core/helpers/event";
import {
  decode,
  encode,
  protocolVersions,
  type GroupInfo,
  wireformats,
} from "ts-mls";
import { CiphersuiteImpl } from "ts-mls/crypto/ciphersuite.js";
import {
  KeyPackage,
  makeKeyPackageRef,
  PrivateKeyPackage,
} from "ts-mls/keyPackage.js";
import {
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsWelcomeMessage,
} from "ts-mls/message.js";
import { computePskSecret } from "ts-mls/presharedkey.js";
import {
  decryptGroupInfo,
  decryptGroupSecrets,
  type Welcome,
} from "ts-mls/welcome.js";
import {
  decodeContent,
  encodeContent,
  getEncodingTag,
} from "../utils/encoding.js";
import { unixNow } from "../utils/nostr.js";
import {
  decodeMarmotGroupData,
  isMarmotGroupDataExtension,
} from "./marmot-group-data.js";
import { isRumorLike } from "./nostr.js";
import { type MarmotGroupData, WELCOME_EVENT_KIND } from "./protocol.js";

/**
 * Creates a welcome rumor (kind 444) for a welcome message.
 *
 * @param welcomeMessage - The MLS welcome message
 * @param keyPackageEventId - The ID of the key package event used for the add operation
 * @param author - The author's public key (hex string)
 * @param groupRelays - Array of relay URLs for the group
 * @returns Welcome rumor with precomputed ID
 */
export function createWelcomeRumor({
  welcome,
  author,
  groupRelays,
  keyPackageEventId,
}: {
  welcome: Welcome;
  author: string;
  keyPackageEventId?: string;
  keyPackageEvent?: NostrEvent;
  groupRelays: string[];
}): Rumor {
  // Serialize the welcome message as a full MLSMessage (RFC 9420)
  const mlsMessage: MlsWelcomeMessage = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome,
  };
  const serializedWelcome = encode(mlsMessageEncoder, mlsMessage);
  const content = encodeContent(serializedWelcome, "base64");

  const draft = {
    kind: WELCOME_EVENT_KIND,
    pubkey: author,
    created_at: unixNow(),
    content,
    tags: [
      ["relays", ...groupRelays],
      ["encoding", "base64"],
    ],
  };

  // Add the key package event ID if known
  if (keyPackageEventId) draft.tags.push(["e", keyPackageEventId]);

  // Calculate the event ID for the rumor
  const id = getEventHash(draft);

  return {
    ...draft,
    id,
  };
}

/** Returns the key package event ID from a welcome rumor */
export function getWelcomeKeyPackageEventId(event: Rumor): string | undefined {
  return getTagValue(event, "e");
}

/** Returns the group relays from a welcome rumor */
export function getWelcomeGroupRelays(event: Rumor): string[] {
  // NOTE: The "relays" tag is a normal Nostr tag vector: ["relays", ...urls]
  // (see MIP-02 and createWelcomeRumor()).
  const tag = event.tags.find((t) => t[0] === "relays");
  if (!tag) return [];
  return tag.slice(1);
}

/**
 * Returns the KeyPackageRefs of the intended recipients from a Welcome message.
 *
 * Each entry in `welcome.secrets` contains a plaintext `newMember` field which
 * is the RFC 9420 KeyPackageRef (a hash of the recipient's KeyPackage). No
 * decryption is required to read these.
 *
 * @param welcome - The MLS Welcome message
 * @returns Array of KeyPackageRefs (one per recipient)
 */
export function getWelcomeKeyPackageRefs(
  welcome: Welcome | Rumor,
): Uint8Array[] {
  // Unwrap welcome rumor if provided
  if (isRumorLike(welcome)) welcome = getWelcome(welcome);

  return welcome.secrets.map((s) => s.newMember);
}

/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export function getWelcome(event: Rumor): Welcome {
  if (event.kind !== WELCOME_EVENT_KIND)
    throw new Error(
      `Expected welcome event kind ${WELCOME_EVENT_KIND}, got ${event.kind}`,
    );

  const encodingFormat = getEncodingTag(event);
  if (encodingFormat !== "base64")
    throw new Error("Invalid welcome event: missing encoding=base64 tag");

  const content = decodeContent(event.content, encodingFormat);
  const mlsMessage = decode(mlsMessageDecoder, content);
  if (!mlsMessage) throw new Error("Failed to decode welcome message");
  if (mlsMessage.wireformat !== wireformats.mls_welcome)
    throw new Error(
      `Expected MLSMessage with mls_welcome wireformat, got wireformat ${mlsMessage.wireformat}`,
    );

  return mlsMessage.welcome;
}

/**
 * Decrypts the {@link GroupInfo} from a Welcome message using the provided key package,
 * without performing a full group join.
 *
 * This is lighter than `joinGroup` — it stops after decrypting the group secrets
 * and group info, giving access to `groupContext` (group ID, epoch, extensions) and
 * `GroupInfo`-level extensions (ratchet tree, external pub).
 *
 * @param welcome - The MLS Welcome message (or a kind 444 Rumor)
 * @param keyPackage - The full key package (public + private) used to receive the invite
 * @param ciphersuiteImpl - The ciphersuite implementation
 * @returns The decrypted GroupInfo
 * @throws Error if the key package does not match any secret in the welcome
 */
export async function readWelcomeGroupInfo({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  welcome: Welcome | Rumor;
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<GroupInfo> {
  // Unwrap welcome rumor if provided
  if (isRumorLike(welcome)) welcome = getWelcome(welcome);

  const keyPackageRef = await makeKeyPackageRef(
    keyPackage.publicPackage,
    ciphersuiteImpl.hash,
  );

  const initPrivateKey = await ciphersuiteImpl.hpke.importPrivateKey(
    keyPackage.privatePackage.initPrivateKey,
  );

  let groupSecrets;
  try {
    groupSecrets = await decryptGroupSecrets(
      initPrivateKey,
      keyPackageRef,
      welcome,
      ciphersuiteImpl.hpke,
    );
  } catch (err) {
    throw new Error(
      `Failed to decrypt group secrets: key package does not match this welcome (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!groupSecrets)
    throw new Error(
      "Failed to decrypt group secrets: key package does not match this welcome",
    );

  // Marmot groups do not use external PSKs; compute the zero-valued PSK secret.
  const pskSecret = await computePskSecret([], ciphersuiteImpl);

  const groupInfo = await decryptGroupInfo(
    welcome,
    groupSecrets.joinerSecret,
    pskSecret,
    ciphersuiteImpl,
  );
  if (!groupInfo) throw new Error("Failed to decrypt group info from welcome");

  return groupInfo;
}

/**
 * Reads the {@link MarmotGroupData} from a Welcome message using the provided key package,
 * without performing a full group join.
 *
 * Convenience wrapper around {@link readWelcomeGroupInfo} that extracts and decodes
 * the Marmot Group Data extension from `groupInfo.groupContext.extensions`.
 *
 * @param welcome - The MLS Welcome message (or a kind 444 Rumor)
 * @param keyPackage - The full key package (public + private) used to receive the invite
 * @param ciphersuiteImpl - The ciphersuite implementation
 * @returns The decoded MarmotGroupData, or null if the extension is not present
 */
export async function readWelcomeMarmotGroupData({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  welcome: Welcome | Rumor;
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<MarmotGroupData | null> {
  const groupInfo = await readWelcomeGroupInfo({
    welcome,
    keyPackage,
    ciphersuiteImpl,
  });

  const ext = groupInfo.groupContext.extensions.find(
    isMarmotGroupDataExtension,
  );
  if (!ext) return null;

  return decodeMarmotGroupData(ext.extensionData);
}
