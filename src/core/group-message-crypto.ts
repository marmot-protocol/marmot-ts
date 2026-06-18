/** @module @category Core - Group Messages */
import { NostrEvent } from "applesauce-core/helpers/event";
import {
  ClientState,
  CiphersuiteImpl,
  decode,
  encode,
  mlsExporter,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsMessage,
} from "ts-mls";
import { decodeContent, encodeContent } from "../utils/encoding.js";
import { decryptLegacyGroupMessageEventContent } from "./group-message-legacy.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes } from "@noble/ciphers/utils.js";

/**
 * Derives the MIP-03 group-event encryption key for a group epoch.
 *
 * Uses the MLS Exporter (RFC 9420 §8.5) with label "marmot" and context
 * "group-event" to produce a 32-byte ChaCha20-Poly1305 key.
 */
async function getGroupEventEncryptionKey(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<Uint8Array> {
  return mlsExporter(
    clientState.keySchedule.exporterSecret,
    "marmot",
    new TextEncoder().encode("group-event"),
    32,
    ciphersuite,
  );
}

/**
 * Reads a {@link NostrEvent} and returns the {@link MlsMessage} it contains.
 * Decrypts group-event encrypted content using the exporter_secret from the group state.
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
  try {
    const key = await getGroupEventEncryptionKey(clientState, ciphersuite);
    const payload = decodeBase64(message.content);
    if (payload.length < 28) {
      throw new Error(
        "Malformed group event content: expected at least 28 bytes",
      );
    }

    const nonce = payload.subarray(0, 12);
    const ciphertext = payload.subarray(12);
    const serializedMessage = chacha20poly1305(
      key,
      nonce,
      new Uint8Array(0),
    ).decrypt(ciphertext);

    const decoded = decode(mlsMessageDecoder, serializedMessage);
    if (!decoded) throw new Error("Failed to decode MLS message");
    return decoded;
  } catch (primaryError) {
    try {
      return await decryptLegacyGroupMessageEventContent(
        message.content,
        clientState,
        ciphersuite,
      );
    } catch (legacyError) {
      throw new Error(
        `Failed to decrypt group message (new format and legacy fallback failed): ${formatError(primaryError)}; legacy: ${formatError(legacyError)}`,
      );
    }
  }
}

/**
 * Encrypts the content of a group event using MIP-03.
 *
 * @returns The encrypted content
 */
export async function createEncryptedGroupEventContent({
  state,
  ciphersuite,
  message,
}: {
  /** The ClientState for the group (to get exporter_secret) */
  state: ClientState;
  /** The ciphersuite implementation */
  ciphersuite: CiphersuiteImpl;
  /** The MLS message to encrypt */
  message: MlsMessage;
}): Promise<string> {
  const serializedMessage = encode(mlsMessageEncoder, message);
  const key = await getGroupEventEncryptionKey(state, ciphersuite);
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(key, nonce, new Uint8Array(0)).encrypt(
    serializedMessage,
  );
  return encodeBase64(concatBytes(nonce, ciphertext));
}

export type GroupMessagePair = {
  event: NostrEvent;
  message: MlsMessage;
};

/**
 * Decrypts a kind 445 event and returns the {@link MlsMessage} it contains.
 *
 * @param event - The Nostr event containing the encrypted MLS message
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns The event and the decoded MlsMessage
 */
export async function decryptGroupMessage(
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
 * Decrypts multiple kind 445 events and returns the {@link MlsMessage} they contain.
 *
 * @param events - The Nostr events containing the encrypted MLS messages
 * @param clientState - The ClientState for the group (to get exporter_secret)
 * @param ciphersuite - The ciphersuite implementation
 * @returns An array of event and decoded MlsMessage pairs
 */
export async function decryptGroupMessages(
  events: NostrEvent[],
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<{ read: GroupMessagePair[]; unreadable: NostrEvent[] }> {
  const read: GroupMessagePair[] = [];
  const unreadable: NostrEvent[] = [];

  await Promise.all(
    events.map(async (event) => {
      try {
        read.push(await decryptGroupMessage(event, clientState, ciphersuite));
      } catch {
        unreadable.push(event);
      }
    }),
  );

  return { read, unreadable };
}

function decodeBase64(value: string): Uint8Array {
  try {
    return decodeContent(value, "base64");
  } catch (error) {
    throw new Error(
      `Invalid base64 group event content: ${formatError(error)}`,
    );
  }
}

function encodeBase64(value: Uint8Array): string {
  return encodeContent(value, "base64");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
