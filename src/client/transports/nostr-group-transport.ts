import { finalizeEvent, generateSecretKey, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { ClientState } from "ts-mls/clientState.js";
import type { CiphersuiteImpl } from "ts-mls/crypto/ciphersuite.js";
import { mlsExporter } from "ts-mls/keySchedule.js";
import { decode, encode } from "ts-mls";
import {
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsMessage,
} from "ts-mls/message.js";
import { getPublicKey } from "nostr-tools/pure";
import { getNostrGroupIdHex } from "../../core/client-state.js";
import { GROUP_EVENT_KIND } from "../../core/protocol.js";
import { unixNow } from "../../utils/nostr.js";
import type { PublishResponse, Subscribable } from "../nostr-interface.js";
import type { GroupTransport } from "./group-transport.js";

export type NostrGroupTransportOptions = {
  /** Relay URLs for this group */
  relays: string[];
  /**
   * Accessor for the current group ClientState, used to derive the Nostr
   * group ID for event filtering in subscribe().
   */
  stateAccessor: () => ClientState;
  /** Ciphersuite implementation used for the MLS exporter */
  ciphersuite: CiphersuiteImpl;
  /** Publish function */
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;
  /** Subscription factory */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent>;
};

/**
 * Derives the 32-byte NIP-44 conversation key for a given group epoch.
 *
 * Uses the MLS exporter secret with label "nostr" / context "nostr" to
 * produce a deterministic symmetric key that all group members share for
 * the current epoch.
 */
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
  // NIP-44: conversation key derived from the private key and its own public key.
  const publicKey = getPublicKey(exporterSecret);
  return nip44.getConversationKey(exporterSecret, publicKey);
}

/**
 * Nostr relay implementation of {@link GroupTransport}.
 *
 * Handles all Nostr-specific concerns for a single MLS group:
 *
 * - **send**: serialises the {@link MlsMessage} → NIP-44 encrypts using the
 *   epoch conversation key derived from the provided {@link ClientState} →
 *   publishes as a kind 445 event to group relays.
 * - **subscribe**: opens a live subscription for kind 445 events filtered by
 *   the group's Nostr group ID → NIP-44 decrypts → deserialises → yields
 *   structured {@link MlsMessage} objects.
 */
export class NostrGroupTransport implements GroupTransport {
  private readonly relays: string[];
  private readonly stateAccessor: () => ClientState;
  private readonly ciphersuite: CiphersuiteImpl;
  private readonly _publish: NostrGroupTransportOptions["publish"];
  private readonly _subscription: NostrGroupTransportOptions["subscription"];

  constructor(options: NostrGroupTransportOptions) {
    this.relays = options.relays;
    this.stateAccessor = options.stateAccessor;
    this.ciphersuite = options.ciphersuite;
    this._publish = options.publish;
    this._subscription = options.subscription;
  }

  /**
   * Send an MLS message to the group.
   *
   * Serialises the message, NIP-44 encrypts it with the epoch conversation
   * key derived from `state`, wraps it in a kind 445 Nostr event signed with
   * an ephemeral key, and publishes to the group's relay set.
   *
   * @throws If no relay acknowledged the publish
   */
  async send(message: MlsMessage, state: ClientState): Promise<void> {
    const conversationKey = await getEpochConversationKey(
      state,
      this.ciphersuite,
    );

    // Serialise the MLS message to bytes, encode as hex, then NIP-44 encrypt
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

    // Sign with an ephemeral key (matching existing createGroupEvent behaviour)
    const ephemeralKey = generateSecretKey();
    const event = finalizeEvent(draft, ephemeralKey);

    const result = await this._publish(this.relays, event);

    const anyOk = Object.values(result).some((r) => r.ok);
    if (!anyOk) {
      const errors = Object.values(result)
        .filter((r) => !r.ok && r.message)
        .map((r) => r.message)
        .join("; ");
      throw new Error(
        `NostrGroupTransport.send: no relay acknowledged — ${errors || "unknown error"}`,
      );
    }
  }

  /**
   * Subscribe to incoming MLS messages for this group.
   *
   * Opens a live subscription on the group's relay set for kind 445 events
   * tagged with the group's Nostr group ID. Each event's NIP-44 content is
   * decrypted using the current epoch conversation key, deserialised into a
   * structured {@link MlsMessage}, and yielded to the caller.
   *
   * Events that cannot be decrypted or deserialised (e.g. from a different
   * epoch, or malformed) are silently skipped.
   */
  async *subscribe(): AsyncGenerator<MlsMessage> {
    const state = this.stateAccessor();
    const groupIdHex = getNostrGroupIdHex(state);

    const filter: Filter = {
      kinds: [GROUP_EVENT_KIND],
      "#h": [groupIdHex],
    };

    const subscribable = this._subscription(this.relays, filter);

    // Bridge the Subscribable<NostrEvent> into an async generator
    const queue: NostrEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const sub = subscribable.subscribe({
      next: (event) => {
        queue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
      complete: () => {
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
      error: () => {
        done = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      },
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0 && !done) {
          await new Promise<void>((res) => {
            resolve = res;
          });
        }

        while (queue.length > 0) {
          const event = queue.shift()!;
          try {
            // Use the latest state for decryption (epoch may have advanced)
            const currentState = this.stateAccessor();
            const convKey = await getEpochConversationKey(
              currentState,
              this.ciphersuite,
            );
            const decrypted = nip44.decrypt(event.content, convKey);
            const bytes = hexToBytes(decrypted);

            const decoded = decode(mlsMessageDecoder, bytes);
            if (!decoded) continue;

            yield decoded;
          } catch {
            // Skip events that can't be decrypted at the current epoch
          }
        }
      }
    } finally {
      sub.unsubscribe();
    }
  }
}
