import { Capabilities } from "ts-mls/capabilities.js";
import {
  LAST_RESORT_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
} from "./protocol.js";

/** Modifies a {@link Capabilities} object to ensure it includes the extensions required in MIP-00 */
export function ensureMarmotCapabilities(
  capabilities: Capabilities,
): Capabilities {
  const extensions = Array.from(capabilities.extensions);

  // Ensure the Marmot Group Data Extension is included in the capabilities
  if (!extensions.includes(MARMOT_GROUP_DATA_EXTENSION_TYPE))
    extensions.push(MARMOT_GROUP_DATA_EXTENSION_TYPE);

  // Ensure the last_resort is included in the capabilities
  if (!extensions.includes(LAST_RESORT_EXTENSION_TYPE))
    extensions.push(LAST_RESORT_EXTENSION_TYPE);

  return {
    ...capabilities,
    extensions,
  };
}
