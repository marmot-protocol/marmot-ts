import {
  Capabilities,
  ciphersuites,
  defaultCapabilities as mlsDefaultCapabilities,
  defaultCredentialTypes,
} from "ts-mls";
import { ensureMarmotCapabilities } from "./capabilities.js";

/**
 * Default capabilities for Marmot key packages.
 *
 * According to MIP-01, key packages MUST signal support for the Marmot Group Data Extension
 * and ratchet_tree in their capabilities to pass validation when being added to groups.
 */
export function defaultCapabilities(): Capabilities {
  let capabilities = mlsDefaultCapabilities();

  // Ensure capabilities include the Marmot Group Data Extension
  capabilities = ensureMarmotCapabilities(capabilities);

  // Filter ciphersuites: keep the default one (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519)
  // and keep GREASE values (numeric IDs), but remove other MLS ciphersuites
  capabilities.ciphersuites = capabilities.ciphersuites.filter(
    (cipher) =>
      cipher === ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 ||
      !Object.values(ciphersuites).includes(cipher),
  );

  // Only include "basic" credential type (remove "x509" since we don't support it)
  capabilities.credentials = capabilities.credentials.filter(
    (c) => c !== defaultCredentialTypes.x509,
  );

  return capabilities;
}
