import type { Credential } from "ts-mls/credential.js";
import type { MlsWelcomeMessage } from "ts-mls/message.js";

export type { MlsWelcomeMessage };

/**
 * Options for sending a Welcome message via {@link InviteTransport}.
 */
export interface InviteSendOptions {
  /**
   * Optional ID of the KeyPackage event (kind 443) the recipient used to be
   * added to the group. Included as an `e` tag in the kind 444 welcome rumor
   * per MIP-00, allowing the recipient to identify and delete the consumed
   * key package from relays.
   */
  keyPackageEventId?: string;
}

/**
 * Transport interface for sending MLS Welcome messages to specific identities.
 *
 * This interface handles only the *sending* side of invite delivery. Receiving
 * incoming invites (gift-wrapped kind 1059 events) remains the responsibility
 * of the application layer via `InviteReader`.
 *
 * Concrete implementations such as {@link NostrInviteTransport} handle the
 * full Nostr delivery pipeline: extracting the inner {@link Welcome} from the
 * {@link MlsWelcomeMessage}, creating a kind 444 rumor, NIP-59 gift-wrapping
 * it to the recipient, resolving the recipient's inbox relays, and publishing
 * the kind 1059 gift wrap.
 */
export interface InviteTransport {
  /**
   * Send an MLS Welcome message to the holder of the given credential.
   *
   * The transport resolves the recipient identity from the credential (e.g.
   * extracting the Nostr pubkey from a basic credential) and delivers the
   * Welcome via the appropriate channel.
   *
   * @param credential - The MLS credential identifying the recipient
   * @param welcome - The structured MLS welcome message to deliver
   * @param options - Optional metadata about the invite operation
   * @throws If the Welcome cannot be delivered to the recipient
   */
  send(
    credential: Credential,
    welcome: MlsWelcomeMessage,
    options?: InviteSendOptions,
  ): Promise<void>;
}
