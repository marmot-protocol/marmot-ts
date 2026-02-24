import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { kinds, KnownEvent } from "applesauce-core/helpers/event";
import type { KeyValueStoreBackend } from "../utils/key-value.js";

/**
 * A received gift wrap event (kind 1059) that hasn't been decrypted yet.
 */
export interface ReceivedGiftWrap extends KnownEvent<kinds.GiftWrap> {}

/**
 * A successfully decrypted Welcome rumor (kind 444).
 * All metadata can be derived from the rumor itself.
 */
export interface UnreadInvite extends Rumor {}

/**
 * Storage backends for invite states.
 * The app provides separate key-value stores for each state.
 *
 * @example
 * ```typescript
 * const inviteStore: InviteStore = {
 *   received: createMemoryBackend<ReceivedGiftWrap>(),
 *   unread: createMemoryBackend<UnreadInvite>(),
 *   seen: createMemoryBackend<boolean>(),
 * };
 * ```
 */
export interface InviteStore {
  /** Storage for received (undecrypted) gift wraps - keyed by gift wrap event ID */
  received: KeyValueStoreBackend<ReceivedGiftWrap>;

  /** Storage for decrypted/unread welcome rumors - keyed by rumor ID */
  unread: KeyValueStoreBackend<UnreadInvite>;

  /** Storage for seen gift wrap event IDs (deduplication) - value is always true */
  seen: KeyValueStoreBackend<boolean>;
}
