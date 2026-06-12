/** @module @category Client - Group */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { ClientState, MlsMessage } from "ts-mls";

import type { GroupPeeler, PeeledMessagePair } from "../../core/engine/types.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";

/** Nostr kind-445 peeler for {@link MarmotGroupEngine}. */
export class NostrGroupPeeler implements GroupPeeler<NostrEvent> {
  constructor(private readonly ciphersuite: import("ts-mls").CiphersuiteImpl) {}

  async peelGroupMessages(
    envelopes: NostrEvent[],
    state: ClientState,
  ): Promise<{
    read: PeeledMessagePair<NostrEvent>[];
    unreadable: NostrEvent[];
  }> {
    const { read, unreadable } = await decryptGroupMessages(
      envelopes,
      state,
      this.ciphersuite,
    );
    return {
      read: read.map(({ event, message }) => ({ envelope: event, message })),
      unreadable,
    };
  }

  async wrapGroupMessage(
    message: MlsMessage,
    state: ClientState,
  ): Promise<NostrEvent> {
    return createGroupEvent({
      message,
      state,
      ciphersuite: this.ciphersuite,
    });
  }
}
