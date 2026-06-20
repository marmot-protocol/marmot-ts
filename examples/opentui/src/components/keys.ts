/** The key descriptor the @opentui/react keyboard handler delivers. */
export type Key = {
  name?: string;
  sequence?: string;
  shift?: boolean | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  option?: boolean | undefined;
};

/** True when `key` corresponds to the given binding string (e.g. "j", "L", "esc"). */
export function matches(key: Key, binding: string): boolean {
  if (binding === "shift+tab") return key.name === "tab" && key.shift === true;
  if (binding === "ctrl+c") return key.name === "c" && key.ctrl === true;
  if (binding.length === 1 && binding >= "A" && binding <= "Z") {
    return (
      key.sequence === binding ||
      (key.name === binding.toLowerCase() && key.shift === true)
    );
  }
  if (binding.length === 1 && binding >= "a" && binding <= "z") {
    return key.sequence === binding || (key.name === binding && !key.shift);
  }
  if (binding === "enter") return key.name === "return" || key.name === "enter";
  if (binding === "esc") return key.name === "escape";
  return key.name === binding || key.sequence === binding;
}

/** A plain printable key (no modifiers) that an input field would consume. */
export function isTextEntryKey(key: Key): boolean {
  if (key.ctrl || key.meta || key.option) return false;
  return key.sequence?.length === 1 || key.name?.length === 1;
}
