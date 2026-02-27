import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import { finalizeEvent, generateSecretKey, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { getPublicKey } from "nostr-tools/pure";
import { decode, encode } from "ts-mls";
import {
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsMessage,
} from "ts-mls/message.js";
import { mlsExporter } from "ts-mls/keySchedule.js";
import type { ClientState } from "ts-mls/clientState.js";
import type { CiphersuiteImpl } from "ts-mls/crypto/ciphersuite.js";
import { getNostrGroupIdHex } from "../../core/client-state.js";
import { GROUP_EVENT_KIND } from "../../core/protocol.js";
import { unixNow } from "../../utils/nostr.js";
import type { GroupTransport } from "../../client/transports/group-transport.js";
import type { PublishResponse } from "../../client/nostr-interface.js";

/**
 * Shared event store used by mock transports.
 * Allows multiple MockGroupTransport instances (admin + invitee) to share the
 * same relay simulation and interact with each other in integration tests.
 */
export class MockEventStore {
  public events: NostrEvent[] = [];

  publish(event: NostrEvent): Record<string, PublishResponse> {
    this.events.push(event);
    return {
      "wss://mock-relay.test": { from: "wss://mock-relay.test", ok: true },
    };
  }

  request(filters: Filter | Filter[]): NostrEvent[] {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((event) =>
      filterArray.some((f) => matchesFilter(event, f)),
    );
  }

  clear(): void {
    this.events = [];
  }
}

function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;

  if (filter["#h"]) {
    const values = Array.isArray(filter["#h"]) ? filter["#h"] : [filter["#h"]];
    if (!event.tags.some((t) => t[0] === "h" && values.includes(t[1])))
      return false;
  }
  if (filter["#e"]) {
    const values = Array.isArray(filter["#e"]) ? filter["#e"] : [filter["#e"]];
    if (!event.tags.some((t) => t[0] === "e" && values.includes(t[1])))
      return false;
  }
  if (filter["#p"]) {
    const values = Array.isArray(filter["#p"]) ? filter["#p"] : [filter["#p"]];
    if (!event.tags.some((t) => t[0] === "p" && values.includes(t[1])))
      return false;
  }
  return true;
}

async function getEpochConversationKey(
  state: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<Uint8Array> {
  const exporterSecret = await mlsExporter(
    state.keySchedule.exporterSecret,
    "nostr",
    new TextEncoder().encode("nostr"),
    32,
    ciphersuite,
  );
  const publicKey = getPublicKey(exporterSecret);
  return nip44.getConversationKey(exporterSecret, publicKey);
}

/**
 * Mock implementation of {@link GroupTransport} for testing.
 *
 * Shares a {@link MockEventStore} so multiple group transport instances
 * (e.g. admin and invitee in end-to-end tests) can exchange events through
 * the same simulated relay.
 */
export class MockGroupTransport implements GroupTransport {
  constructor(
    private readonly store: MockEventStore,
    private readonly ciphersuite: CiphersuiteImpl,
  ) {}

  async send(message: MlsMessage, state: ClientState): Promise<void> {
    const conversationKey = await getEpochConversationKey(
      state,
      this.ciphersuite,
    );

    const serialized = encode(mlsMessageEncoder, message);
    const encryptedContent = nip44.encrypt(
      bytesToHex(serialized),
      conversationKey,
    );
    const groupIdHex = getNostrGroupIdHex(state);

    const draft = {
      kind: GROUP_EVENT_KIND,
      created_at: unixNow(),
      content: encryptedContent,
      tags: [["h", groupIdHex]],
    };

    const ephemeralKey = generateSecretKey();
    const event = finalizeEvent(draft, ephemeralKey);
    this.store.publish(event);
  }

  async *subscribe(): AsyncGenerator<MlsMessage> {
    // In tests, subscribe is not used — tests drive ingestion directly
    // via store.request() + group.ingest(). This is a no-op stub.
  }

  /**
   * Helper for tests: fetch and decrypt all group events from the store
   * for the given state, returning decoded MlsMessage objects.
   */
  async fetchMessages(state: ClientState): Promise<MlsMessage[]> {
    const groupIdHex = getNostrGroupIdHex(state);
    const events = this.store.request({
      kinds: [GROUP_EVENT_KIND],
      "#h": [groupIdHex],
    });

    const results: MlsMessage[] = [];
    const conversationKey = await getEpochConversationKey(
      state,
      this.ciphersuite,
    );

    for (const event of events) {
      try {
        const decrypted = nip44.decrypt(event.content, conversationKey);
        const bytes = hexToBytes(decrypted);
        const decoded = decode(mlsMessageDecoder, bytes);
        if (decoded) results.push(decoded);
      } catch {
        // skip unreadable events
      }
    }
    return results;
  }
}
