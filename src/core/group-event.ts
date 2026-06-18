/** @module @category Core - Group Messages */
import { finalizeEvent, NostrEvent } from "applesauce-core/helpers/event";
import { generateSecretKey } from "applesauce-core/helpers/keys";
import { ClientState, CiphersuiteImpl, type MlsMessage } from "ts-mls";
import { unixNow } from "../utils/nostr.js";
import { getNostrGroupIdHex } from "./client-state.js";
import { nostrTransportBinding } from "./transport.js";
import { createEncryptedGroupEventContent } from "./group-message-crypto.js";

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

  const content = await createEncryptedGroupEventContent({
    state,
    ciphersuite,
    message,
  });
  const groupId = getNostrGroupIdHex(state);

  const draft = {
    kind: nostrTransportBinding.groupMessageKind,
    created_at: unixNow(),
    content,
    tags: [[nostrTransportBinding.groupIdTag, groupId]],
  };

  // Ephemeral keypair for signing — distinct from the encryption keypair (MIP-03)
  const ephemeralSecretKey = generateSecretKey();

  return finalizeEvent(draft, ephemeralSecretKey);
}
