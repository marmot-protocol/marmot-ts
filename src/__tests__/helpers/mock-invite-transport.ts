import type { EventSigner } from "applesauce-core/event-factory";
import type { Credential } from "ts-mls/credential.js";
import type { MlsWelcomeMessage } from "ts-mls/message.js";
import { getCredentialPubkey } from "../../core/credential.js";
import { createWelcomeRumor } from "../../core/welcome.js";
import { createGiftWrap } from "../../utils/nostr.js";
import type {
  InviteTransport,
  InviteSendOptions,
} from "../../client/transports/invite-transport.js";
import type { MockEventStore } from "./mock-group-transport.js";

/**
 * Mock implementation of {@link InviteTransport} for testing.
 *
 * Gift-wraps MLS Welcome messages and stores them in the shared
 * {@link MockEventStore} so integration tests can retrieve and inspect them.
 */
export class MockInviteTransport implements InviteTransport {
  constructor(
    private readonly store: MockEventStore,
    private readonly signer: EventSigner,
    private readonly groupRelays: string[],
  ) {}

  async send(
    credential: Credential,
    welcome: MlsWelcomeMessage,
    options?: InviteSendOptions,
  ): Promise<void> {
    const authorPubkey = await this.signer.getPublicKey();
    const recipientPubkey = getCredentialPubkey(credential);

    const welcomeRumor = createWelcomeRumor({
      welcome: welcome.welcome,
      author: authorPubkey,
      groupRelays: this.groupRelays,
      keyPackageEventId: options?.keyPackageEventId,
    });

    const giftWrapEvent = await createGiftWrap({
      rumor: welcomeRumor,
      recipient: recipientPubkey,
      signer: this.signer,
    });

    this.store.publish(giftWrapEvent);
  }
}
