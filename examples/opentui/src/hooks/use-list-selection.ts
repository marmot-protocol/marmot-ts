import { useEffect, useState } from "react";

/** Clamp `index` into `[0, length)`, collapsing an empty list to 0. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/**
 * A cursor into a list of `length` items. The returned `index` is always clamped
 * into range — both on this render (so it stays valid the instant the list
 * shrinks) and via an effect that pulls the stored cursor back in bounds when
 * `length` changes. `move(delta)` steps the cursor; `set` jumps to an absolute
 * position (e.g. reset to 0).
 *
 * Replaces the hand-rolled clamp logic that previously lived in App (two copies,
 * one per list) and in MembersModal.
 */
export function useListSelection(length: number): {
  index: number;
  move: (delta: number) => void;
  set: (index: number) => void;
} {
  const [cursor, setCursor] = useState(0);

  useEffect(() => setCursor((i) => clampIndex(i, length)), [length]);

  return {
    index: clampIndex(cursor, length),
    move: (delta) => setCursor((i) => clampIndex(i + delta, length)),
    set: setCursor,
  };
}
