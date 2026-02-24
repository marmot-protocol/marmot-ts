import { ciphersuites } from "ts-mls";

/**
 * Gets the ciphersuite name from a ciphersuite ID.
 * @param id - The numeric ciphersuite ID
 * @returns The ciphersuite name (e.g., "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519") or undefined if not found
 */
export function getCiphersuiteNameFromId(id: number): string | undefined {
  return (Object.keys(ciphersuites) as Array<keyof typeof ciphersuites>).find(
    (key) => ciphersuites[key] === id,
  );
}
