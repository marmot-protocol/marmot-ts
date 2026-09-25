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

/**
 * The outcome of one recipient's Welcome delivery attempt, produced by
 * {@link NostrWelcomeDelivery.deliverMany}. This is the per-invitee unit of
 * FOUND-04: a Welcome "succeeds or fails independently and does not affect
 * canonical group state"
 * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78).
 */
export type WelcomeDeliveryOutcome =
  | {
      kind: "succeeded";
      recipient: WelcomeRecipient;
      response: Record<string, PublishResponse>;
    }
  | {
      kind: "failed";
      recipient: WelcomeRecipient;
      error: string;
    };

export type DeliverManyWelcomesOptions = {
  welcome: Welcome;
  author: string;
  groupRelays: string[];
  recipients: WelcomeRecipient[];
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

  /**
   * Delivers a Welcome to many recipients, one {@link deliver} call each.
   * This is the shared fanout D-06/D-07 puts on the class whose job is
   * Welcome delivery — reached by both {@link GroupRuntime} (ordinary invite)
   * and `GroupFactory` (founding create), so exactly one implementation
   * exists that cannot drift.
   *
   * Never throws and never aggregates: each recipient's settled result maps
   * to exactly one {@link WelcomeDeliveryOutcome} entry, in the order the
   * recipients were supplied. A Welcome failure is a normal per-recipient
   * outcome, not an error — see
   * refs/marmot/protocol-core/publish-lifecycle.md lines 66-78 ("succeeds or
   * fails independently and does not affect canonical group state").
   */
  async deliverMany(
    options: DeliverManyWelcomesOptions,
  ): Promise<WelcomeDeliveryOutcome[]> {
    const settled = await Promise.allSettled(
      options.recipients.map((recipient) =>
        this.deliver({
          welcome: options.welcome,
          author: options.author,
          groupRelays: options.groupRelays,
          recipient,
        }),
      ),
    );

    return settled.map((result, index) => {
      const recipient = options.recipients[index]!;
      if (result.status === "fulfilled")
        return { kind: "succeeded", recipient, response: result.value };
      const error =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      return { kind: "failed", recipient, error };
    });
  }
}
