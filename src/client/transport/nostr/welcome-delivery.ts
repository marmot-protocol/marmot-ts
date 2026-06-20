/** @module @category Client - Nostr */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Welcome } from "ts-mls";

import { createWelcomeRumor } from "../../../core/welcome.js";
import { createGiftWrap } from "../../../utils/index.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../nostr-interface.js";

/** Information required to deliver an MLS Welcome to a new member. */
export type WelcomeRecipient = {
  /** The recipient's Nostr public key. */
  pubkey: string;
  /** The event id of the KeyPackage consumed by the Add. */
  keyPackageEventId: string;
  /** The KeyPackage event consumed by the Add. */
  keyPackageEvent: NostrEvent;
};

export type NostrWelcomeDeliveryOptions = {
  signer: EventSigner;
  network: NostrNetworkInterface;
};

export type DeliverWelcomeOptions = {
  welcome: Welcome;
  author: string;
  groupRelays: string[];
  recipient: WelcomeRecipient;
};

/** Owns Nostr/NIP-59 Welcome wrapping and inbox publication. */
export class NostrWelcomeDelivery {
  readonly signer: EventSigner;
  readonly network: NostrNetworkInterface;

  constructor(options: NostrWelcomeDeliveryOptions) {
    this.signer = options.signer;
    this.network = options.network;
  }

  createRumor(options: DeliverWelcomeOptions): Rumor {
    return createWelcomeRumor({
      welcome: options.welcome,
      author: options.author,
      groupRelays: options.groupRelays,
      keyPackageEventId: options.recipient.keyPackageEventId,
    });
  }

  async deliver(
    options: DeliverWelcomeOptions,
  ): Promise<Record<string, PublishResponse>> {
    const welcomeRumor = this.createRumor(options);
    const giftWrapEvent = await createGiftWrap({
      rumor: welcomeRumor,
      recipient: options.recipient.pubkey,
      signer: this.signer,
    });

    let inboxRelays: string[];
    try {
      inboxRelays = await this.network.getUserInboxRelays(
        options.recipient.pubkey,
      );
    } catch {
      inboxRelays = options.groupRelays;
    }

    if (inboxRelays.length === 0) {
      throw new Error(
        `No relays available to send Welcome to recipient ${options.recipient.pubkey.slice(
          0,
          16,
        )}...`,
      );
    }

    return this.network.publish(inboxRelays, giftWrapEvent);
  }
}
