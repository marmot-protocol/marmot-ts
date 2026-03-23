import { greaseValues } from "ts-mls";

export const GREASE_VALUE_SET: ReadonlySet<number> = new Set<number>(
  greaseValues,
);

export function isGreaseValue(value: number): boolean {
  return GREASE_VALUE_SET.has(value);
}
