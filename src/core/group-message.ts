import { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  NostrEvent,
} from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { ClientState } from "ts-mls/clientState.js";
import { CiphersuiteImpl } from "ts-mls/crypto/ciphersuite.js";
import { mlsExporter } from "ts-mls/keySchedule.js";
import { contentTypes, decode, encode, wireformats } from "ts-mls";
import {
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsMessage,
} from "ts-mls/message.js";
import { unixNow } from "../utils/nostr.js";
import { getNostrGroupIdHex } from "./client-state.js";
import { isPrivateMessage } from "./message.js";
import { GROUP_EVENT_KIND } from "./protocol.js";

/**
 * Gets the exporter secret for NIP-44 encryption from the current group epoch.
 *
 * @param clientState - The ClientState to get exporter secret from
 * @param ciphersuite - The ciphersuite implementation
 * @returns The 32-byte exported secret
 */
async function getExporterSecretForNip44(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<Uint8Array> {
  // Use MLS exporter with label "nostr" and context "nostr" to get 32-byte secret
  return mlsExporter(
    clientState.keySchedule.exporterSecret,
    "nostr",
    new TextEncoder().encode("nostr"),
    32,
    ciphersuite,
  );
}

/**
 * Reads a {@link NostrEvent} and returns the {@link MlsMessage} it contains.
 * Decrypts the NIP-44 encrypted content using the exporter_secret from the group state.
 *
 * @param message - The Nostr event containing the encrypted MLS message
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns The decoded MlsMessage
 */
export async function decryptGroupMessageEvent(
  message: NostrEvent,
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<MlsMessage> {
  // Step 1: Get exporter_secret for current epoch
  const exporterSecret = await getExporterSecretForNip44(
    clientState,
    ciphersuite,
  );

  // Step 2: Generate keypair from exporter_secret
  // Use exporter_secret bytes directly as private key
  const encryptionPrivateKey = exporterSecret;
  const encryptionPublicKey = getPublicKey(encryptionPrivateKey);

  // Step 3: Decrypt using NIP-44
  // Use exporter_secret as sender key (private), and its public key as receiver key
  const conversationKey = nip44.getConversationKey(
    encryptionPrivateKey,
    encryptionPublicKey,
  );
  const decryptedContent = nip44.decrypt(message.content, conversationKey);

  // Step 4: Decode the serialized MlsMessage
  const serializedMessage = hexToBytes(decryptedContent);
  const decoded = decode(mlsMessageDecoder, serializedMessage);
  if (!decoded) throw new Error("Failed to decode MLS message");
  return decoded;
}

/**
 * Encrypts the content of a group event using NIP-44.
 *
 * @param state - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @param message - The MLS message to encrypt
 * @returns The encrypted content
 */
export async function createEncryptedGroupEventContent({
  state,
  ciphersuite,
  message,
}: {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  message: MlsMessage;
}): Promise<string> {
  // Step 1: Serialize the MLS message
  const serializedMessage = encode(mlsMessageEncoder, message);

  // Step 2: Get exporter_secret for current epoch
  const exporterSecret = await getExporterSecretForNip44(state, ciphersuite);

  // Step 3: Generate keypair from exporter_secret
  const encryptionPrivateKey = exporterSecret;
  const encryptionPublicKey = getPublicKey(encryptionPrivateKey);

  // Step 4: Encrypt using NIP-44
  // Use exporter_secret as sender key (private), and its public key as receiver key
  const conversationKey = nip44.getConversationKey(
    encryptionPrivateKey,
    encryptionPublicKey,
  );
  const encryptedContent = nip44.encrypt(
    bytesToHex(serializedMessage),
    conversationKey,
  );

  return encryptedContent;
}

export type GroupMessagePair = {
  event: NostrEvent;
  message: MlsMessage;
};

/**
 * Reads a kind 445 event and returns the {@link MlsMessage} it contains.
 *
 * @param event - The Nostr event containing the encrypted MLS message
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns The event and the decoded MlsMessage
 */
export async function readGroupMessage(
  event: NostrEvent,
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<GroupMessagePair> {
  const message = await decryptGroupMessageEvent(
    event,
    clientState,
    ciphersuite,
  );
  return { event, message };
}

/**
 * Reads multiple kind 445 events and returns the {@link MlsMessage} they contain.
 *
 * @param events - The Nostr events containing the encrypted MLS messages
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns An array of event and decoded MlsMessage pairs
 */
export async function readGroupMessages(
  events: NostrEvent[],
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<{ read: GroupMessagePair[]; unreadable: NostrEvent[] }> {
  const read: GroupMessagePair[] = [];
  const unreadable: NostrEvent[] = [];

  await Promise.all(
    events.map(async (event) => {
      try {
        read.push(await readGroupMessage(event, clientState, ciphersuite));
      } catch {
        unreadable.push(event);
      }
    }),
  );

  return { read, unreadable };
}

export type CreateGroupEventOptions = {
  /** The serialized MLS message */
  message: MlsMessage;
  /** The ClientState for the group */
  state: ClientState;
  /** The ciphersuite implementation */
  ciphersuite: CiphersuiteImpl;
};

/**
 * Creates a Nostr event containing an encrypted MLS message.
 *
 * @param options - The options for creating the event
 * @returns A signed Nostr event
 */
export async function createGroupEvent(
  options: CreateGroupEventOptions,
): Promise<NostrEvent> {
  const { message, state, ciphersuite } = options;

  // Encrypt the MLS message
  const content = await createEncryptedGroupEventContent({
    state,
    ciphersuite,
    message,
  });

  // Get the Nostr group ID for the tags
  const groupId = getNostrGroupIdHex(state);

  const draft = {
    kind: GROUP_EVENT_KIND,
    created_at: unixNow(),
    content,
    tags: [["h", groupId]],
  };

  // Generate a random ephemeral key for signing
  const ephemeralSecretKey = generateSecretKey();

  // Finalize (sign) the event
  return finalizeEvent(draft, ephemeralSecretKey);
}

/**
 * Serializes an application rumor (unsigned Nostr event) to bytes.
 * This is the format used for application messages in Marmot groups.
 *
 * @param rumor - The unsigned Nostr event to serialize
 * @returns The serialized application data as bytes
 */
export function serializeApplicationRumor(rumor: Rumor): Uint8Array {
  // Serialize the rumor to a JSON string
  const json = JSON.stringify(rumor);
  // Encode as UTF-8 bytes
  return new TextEncoder().encode(json);
}

/**
 * Deserializes application data bytes back into a rumor.
 *
 * @param data - The serialized application data
 * @returns The deserialized Rumor
 */
export function deserializeApplicationData(data: Uint8Array): Rumor {
  // Decode UTF-8 bytes to string
  const json = new TextDecoder().decode(data);
  // Parse JSON
  const parsed = JSON.parse(json);

  // Validate it's a rumor-like object
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid application data: not an object");
  }

  // Check required fields for a rumor
  if (!parsed.id || !parsed.pubkey || parsed.kind === undefined) {
    throw new Error("Invalid application data: missing required fields");
  }

  return parsed as Rumor;
}

/** @deprecated Kept for internal compatibility. Prefer `deserializeApplicationData`. */
export const deserializeApplicationRumor = deserializeApplicationData;

/**
 * Sorts group commits to handle race conditions according to MIP-03.
 *
 * Sorting order (MIP-03):
 * 1. First, sort by commit time (created_at) - older commits first
 * 2. If equal, sort by event id (lexicographically) - lower id first
 *
 * @param commits - Array of commit message pairs to sort
 * @returns Sorted array of commits
 */
export function sortGroupCommits(
  commits: GroupMessagePair[],
): GroupMessagePair[] {
  return commits.sort((a, b) => {
    // Rule 1: Sort by created_at (older first)
    if (a.event.created_at !== b.event.created_at) {
      return a.event.created_at - b.event.created_at;
    }

    // Rule 2: If equal, sort by event id (lexicographically)
    return a.event.id.localeCompare(b.event.id);
  });
}

/**
 * Creates a proposal event for a group.
 *
 * @param options - The options for creating the proposal event
 * @returns A signed Nostr event
 */
export async function createProposalEvent(
  options: CreateGroupEventOptions,
): Promise<NostrEvent> {
  return createGroupEvent(options);
}

/**
 * Creates a commit event for a group.
 *
 * @param options - The options for creating the commit event
 * @returns A signed Nostr event
 */
export async function createCommitEvent(
  options: CreateGroupEventOptions,
): Promise<NostrEvent> {
  return createGroupEvent(options);
}

/**
 * Type guard to check if a value is a Rumor
 */
export function isRumorLike(value: unknown): value is Rumor {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.pubkey === "string" &&
    typeof r.kind === "number" &&
    typeof r.created_at === "number" &&
    typeof r.content === "string" &&
    Array.isArray(r.tags)
  );
}

/**
 * Checks if a message is an application message (not a proposal or commit).
 */
export function isApplicationMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  return (
    isPrivateMessage(pair.message) &&
    pair.message.privateMessage.contentType === contentTypes.application
  );
}

/**
 * Checks if a message is a commit message.
 */
export function isCommitMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  return (
    isPrivateMessage(pair.message) &&
    pair.message.privateMessage.contentType === contentTypes.commit
  );
}

/**
 * Checks if a message is a proposal message.
 */
export function isProposalMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  return (
    isPrivateMessage(pair.message) &&
    pair.message.privateMessage.contentType === contentTypes.proposal
  );
}
