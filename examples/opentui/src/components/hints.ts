import type { KeyHint } from "./KeybindingFooter.js";
import type { Pane } from "./focus.js";

/** Shortcuts available from every panel, shown in the footer and help overlay. */
export const GLOBAL_HINTS: KeyHint[] = [
  { key: "tab", label: "next panel" },
  { key: "shift+tab", label: "prev panel" },
  { key: "?", label: "help" },
  { key: "q", label: "quit/back" },
];

/**
 * The per-panel keybinding hints. A few entries are conditional on context
 * (whether the user is composing, and whether they're an admin of the
 * selected/active group), so this is computed rather than a static table.
 */
export function panelHints(opts: {
  composing: boolean;
  replySelecting: boolean;
  reactSelecting: boolean;
  showAllInvites: boolean;
  selectedGroupIsAdmin: boolean;
  activeGroupIsAdmin: boolean;
}): Record<Pane, KeyHint[]> {
  return {
    groups: [
      { key: "j/k", label: "switch group" },
      { key: "enter", label: "open chat" },
      { key: "n", label: "new group" },
      { key: "i", label: "invite" },
      { key: "m", label: "members" },
      ...(opts.selectedGroupIsAdmin ? [{ key: "e", label: "edit info" }] : []),
      { key: "L", label: "leave active" },
    ],
    invites: [
      { key: "j/k", label: "move" },
      { key: "enter", label: "details" },
      { key: "a", label: "details" },
      { key: "d", label: "dismiss" },
      { key: "f", label: opts.showAllInvites ? "joinable only" : "show all" },
    ],
    chat: opts.composing
      ? [
          { key: "enter", label: "send" },
          { key: "esc", label: "stop composing" },
        ]
      : opts.replySelecting
        ? [
            { key: "j/k", label: "select message" },
            { key: "enter", label: "reply" },
            { key: "esc", label: "cancel" },
          ]
        : opts.reactSelecting
          ? [
              { key: "j/k", label: "select message" },
              { key: "1-6", label: "react emoji" },
              { key: "esc", label: "cancel" },
            ]
          : [
              { key: "r", label: "reply" },
              { key: "c", label: "react" },
              { key: "n", label: "compose" },
              { key: "u", label: "load older" },
              { key: "i", label: "invite" },
              { key: "m", label: "members" },
              { key: "g", label: "group info" },
              ...(opts.activeGroupIsAdmin
                ? [{ key: "e", label: "edit info" }]
                : []),
              { key: "R", label: "relays" },
              { key: "p", label: "profile" },
              { key: "K", label: "key package" },
            ],
    profile: [
      { key: "i", label: "invite QR" },
      { key: "p", label: "edit profile" },
      { key: "r", label: "edit relays" },
      { key: "K", label: "key package" },
      { key: "o", label: "new account" },
    ],
  };
}
