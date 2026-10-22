import type { AuthSigner, RelayAuthHandler } from "applesauce-relay/types";

/** Authenticate only when an operation is refused, never on a bare challenge. */
export function createRelayAuthHandler(signer: AuthSigner): RelayAuthHandler {
  return async ({ relay }) => {
    const response = await relay.authenticate(signer);
    if (!response.ok) {
      throw new Error(
        `Relay authentication rejected: ${response.message ?? relay.url}`,
      );
    }
  };
}
