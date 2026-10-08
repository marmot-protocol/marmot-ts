/** @module @category Core - Capabilities */
import {
  Capabilities,
  ciphersuites,
  defaultCapabilities as mlsDefaultCapabilities,
  defaultCredentialTypes,
} from "ts-mls";
import { ensureMarmotCapabilities } from "./capabilities.js";
import { isGreaseValue } from "./grease.js";

/**
 * Default capabilities for Marmot key packages.
 *
 * Per `protocol-core/group-setup.md` (capability checks before create/add) and
 * `foundation/key-packages.md`, KeyPackages MUST advertise the capabilities a Marmot group
 * requires — the extensions and proposals `ensureMarmotCapabilities` adds (app_data_dictionary,
 * the agent-text-stream `receive` role, app_data_update, self_remove) — to pass
 * validation when added to groups.
 */
export function defaultCapabilities(): Capabilities {
  let capabilities = mlsDefaultCapabilities();

  // Ensure capabilities include the Marmot-required extensions and proposals
  capabilities = ensureMarmotCapabilities(capabilities);

  // Filter ciphersuites: keep the default one (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519)
  // and keep GREASE values (numeric IDs), but remove other MLS ciphersuites
  // In v2, ciphersuites is an object mapping names to numeric IDs
  const defaultCiphersuiteName = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

  capabilities.ciphersuites = Object.entries(ciphersuites)
    .filter(([name, id]) => {
      // Keep the default ciphersuite by name
      if (name === defaultCiphersuiteName) return true;
      // Keep canonical GREASE values published by ts-mls.
      if (isGreaseValue(id)) return true;
      return false;
    })
    .map(([, id]) => id) as Capabilities["ciphersuites"];

  // Only include "basic" credential type (remove "x509" since we don't support it)
  // In v2, credential types are numeric values (see defaultCredentialTypes)
  capabilities.credentials = capabilities.credentials.filter(
    (c) => c === defaultCredentialTypes.basic,
  );

  return capabilities;
}
