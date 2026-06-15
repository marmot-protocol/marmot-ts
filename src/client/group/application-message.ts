/** @module @category Client - Group */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "applesauce-core/helpers/event";

import { serializeApplicationRumor } from "../../core/group-message.js";
import { unixNow } from "../../utils/nostr.js";
import type { GroupSessionSendIntent } from "../session/group-effects.js";

/** Options for {@link createChatRumor}. */
export type CreateChatRumorOptions = {
  /** The author's Nostr public key (hex). */
  pubkey: string;
  /** The text content of the chat message. */
  content: string;
  /** Optional Nostr tags to include on the rumor. */
  tags?: string[][];
  /** Override the rumor `created_at`; defaults to the current unix time. */
  created_at?: number;
};

/**
 * Builds an unsigned kind 9 chat rumor with its `id` filled in.
 *
 * This is app-level convenience: kind 9 is a chat convention, not part of the
 * Marmot protocol. Pair it with {@link createApplicationMessageIntent} and
 * drive the result through {@link GroupSession.send} /
 * {@link GroupsManager.send}.
 */
export function createChatRumor(options: CreateChatRumorOptions): Rumor {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey: options.pubkey,
    created_at: options.created_at ?? unixNow(),
    content: options.content,
    tags: options.tags ?? [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * Serializes an unsigned application rumor into an `applicationMessage` session
 * intent ready for {@link GroupSession.send} or {@link GroupsManager.send}.
 *
 * The rumor must be unsigned and is serialized per the Marmot spec before being
 * encrypted via MLS.
 */
export function createApplicationMessageIntent(
  rumor: Rumor,
): Extract<GroupSessionSendIntent, { kind: "applicationMessage" }> {
  return {
    kind: "applicationMessage",
    payload: serializeApplicationRumor(rumor),
  };
}
