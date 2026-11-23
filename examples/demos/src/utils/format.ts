/** Shorten a hex id or pubkey for display. */
export const short = (hex: string, n = 8) =>
  hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex;

export { bytesToHex as hex } from "applesauce-core/helpers/event";
