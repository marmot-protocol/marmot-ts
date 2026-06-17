/** The focusable panes the user cycles through with Tab / Shift+Tab. */
export type Pane = "input" | "groups" | "invites" | "actions";

export const PANES: Pane[] = ["input", "groups", "invites", "actions"];

export function nextPane(pane: Pane): Pane {
  return PANES[(PANES.indexOf(pane) + 1) % PANES.length];
}

export function prevPane(pane: Pane): Pane {
  return PANES[(PANES.indexOf(pane) + PANES.length - 1) % PANES.length];
}
