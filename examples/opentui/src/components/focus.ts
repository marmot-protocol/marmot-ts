/** The focusable panels the user cycles through with Tab / Shift+Tab. */
export type Pane = "groups" | "invites" | "chat" | "activity";

export const PANES: Pane[] = ["groups", "invites", "chat", "activity"];

export function nextPane(pane: Pane): Pane {
  return PANES[(PANES.indexOf(pane) + 1) % PANES.length];
}

export function prevPane(pane: Pane): Pane {
  return PANES[(PANES.indexOf(pane) + PANES.length - 1) % PANES.length];
}
