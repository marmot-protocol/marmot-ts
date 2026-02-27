import type { EventSigner } from "applesauce-core/event-factory";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Credential } from "ts-mls/credential.js";
import type { MlsWelcomeMessage } from "ts-mls/message.js";
import { getCredentialPubkey } from "../../core/credential.js";
import { createWelcomeRumor } from "../../core/welcome.js";
import { createGiftWrap } from "../../utils/nostr.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { InviteTransport, InviteSendOptions } from "./invite-transport.js";

export type NostrInviteTransportOptions = {
  /**
   * The signer used to gift-wrap Welcome messages.
   * The signer's public key becomes the author of the kind 444 welcome rumor.
   */
  signer: EventSigner;

  /**
   * The relay URLs to include in the Welcome rumor's `relays` tag.
   * New members use these to connect to the group after joining.
   */
  groupRelays: string[];

  /**
   * Publish function used to send the gift-wrapped kind 1059 event to the
   * recipient's inbox relays.
   */
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;

  /**
   * Resolve the inbox relays for a given Nostr pubkey (hex).
   * Typically reads the recipient's kind 10051 relay list event.
   * If this throws, the transport falls back to `groupRelays`.
   */
  getUserInboxRelays(pubkey: string): Promise<string[]>;
};

/**
 * Nostr relay implementation of {@link InviteTransport}.
 *
 * Handles the complete MLS → Nostr invite delivery pipeline:
 *
 * 1. Extracts the recipient's Nostr pubkey from the MLS `Credential`
 * 2. Creates a kind 444 welcome rumor containing the serialised `Welcome`
 * 3. NIP-59 gift-wraps the rumor to the recipient
 * 4. Resolves the recipient's inbox relays (falls back to group relays)
 * 5. Publishes the kind 1059 gift wrap to the inbox relays
 */
export class NostrInviteTransport implements InviteTransport {
  private readonly signer: EventSigner;
  private readonly groupRelays: string[];
  private readonly _publish: NostrInviteTransportOptions["publish"];
  private readonly _getUserInboxRelays: NostrInviteTransportOptions["getUserInboxRelays"];

  constructor(options: NostrInviteTransportOptions) {
    this.signer = options.signer;
    this.groupRelays = options.groupRelays;
    this._publish = options.publish;
    this._getUserInboxRelays = options.getUserInboxRelays;
  }

  /**
   * Send an MLS Welcome message to the holder of the given credential.
   *
   * Resolves the Nostr pubkey from the credential, constructs the kind 444
   * rumor, gift-wraps it with NIP-59, and publishes to the recipient's
   * inbox relays (falling back to group relays if resolution fails).
   *
   * @throws If the credential does not contain a valid Nostr pubkey
   * @throws If there are no relays available to publish to
   * @throws If no relay acknowledged the gift wrap publish
   */
  async send(
    credential: Credential,
    welcome: MlsWelcomeMessage,
    options?: InviteSendOptions,
  ): Promise<void> {
    const authorPubkey = await this.signer.getPublicKey();
    const recipientPubkey = getCredentialPubkey(credential);

    // Build the kind 444 welcome rumor — extract the inner Welcome from the
    // MlsWelcomeMessage wrapper before serialising.
    const welcomeRumor = createWelcomeRumor({
      welcome: welcome.welcome,
      author: authorPubkey,
      groupRelays: this.groupRelays,
      keyPackageEventId: options?.keyPackageEventId,
    });

    // NIP-59 gift-wrap to recipient
    const giftWrapEvent = await createGiftWrap({
      rumor: welcomeRumor,
      recipient: recipientPubkey,
      signer: this.signer,
    });

    // Resolve the recipient's inbox relays, falling back to group relays
    let inboxRelays: string[];
    try {
      inboxRelays = await this._getUserInboxRelays(recipientPubkey);
    } catch {
      inboxRelays = this.groupRelays;
    }

    if (inboxRelays.length === 0) {
      throw new Error(
        `NostrInviteTransport.send: no relays available for recipient ${recipientPubkey.slice(0, 16)}…`,
      );
    }

    const result = await this._publish(inboxRelays, giftWrapEvent);

    const anyOk = Object.values(result).some((r) => r.ok);
    if (!anyOk) {
      const errors = Object.values(result)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(
        `NostrInviteTransport.send: no relay acknowledged for recipient ${recipientPubkey.slice(0, 16)}… — ${errors || "unknown error"}`,
      );
    }
  }
}
