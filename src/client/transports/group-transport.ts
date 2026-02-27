import type { ClientState } from "ts-mls/clientState.js";
import type { MlsMessage } from "ts-mls/message.js";

export type { MlsMessage };

/**
 * Transport interface for a specific MLS group's message channel.
 *
 * The interface operates on structured {@link MlsMessage} objects so that
 * `MarmotGroup` is fully decoupled from the underlying transport layer.
 * Serialization, encryption, and Nostr event wrapping are handled entirely by
 * concrete implementations such as {@link NostrGroupTransport}.
 */
export interface GroupTransport {
  /**
   * Subscribe to incoming MLS messages for this group.
   *
   * Yields decoded {@link MlsMessage} objects as they arrive from the
   * underlying channel. The transport is responsible for decrypting and
   * deserializing each message before yielding it.
   *
   * The generator runs indefinitely until the caller breaks or the transport
   * is closed.
   *
   * @example
   * ```ts
   * for await (const message of transport.subscribe()) {
   *   for await (const result of group.ingestMessage(message)) { ... }
   * }
   * ```
   */
  subscribe(): AsyncGenerator<MlsMessage>;

  /**
   * Send an MLS message to the group.
   *
   * The current group {@link ClientState} is provided so the transport can
   * derive the epoch-specific encryption key (e.g. the MLS exporter secret
   * for NIP-44 encryption) without needing its own state accessor.
   *
   * The transport is responsible for serializing, encrypting, and publishing
   * the message to the appropriate channel (e.g., as a NIP-44 encrypted
   * kind 445 Nostr event on the group's relay set).
   *
   * @param message - The structured MLS message to send
   * @param state - The current group ClientState used to derive the encryption key
   * @throws If the message cannot be delivered (e.g., no relay acknowledged)
   */
  send(message: MlsMessage, state: ClientState): Promise<void>;
}
