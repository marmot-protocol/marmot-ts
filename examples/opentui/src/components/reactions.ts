/**
 * The fixed emoji palette offered when reacting to a message. Reaction-select
 * mode (entered with `c` in the chat panel) maps the number keys 1..N onto these
 * in order, and the same list labels the palette shown above the composer.
 */
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "😢"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
