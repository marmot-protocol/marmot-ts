/** @module @category Engine */
import { type ContentTypeValue, type MlsMessage, wireformats } from "ts-mls";

/**
 * Marmot v2 carries MLS handshake content — Commits and Proposals — as
 * `PublicMessage`, while application messages stay `PrivateMessage`
 * (`darkmatter/spec/foundation/mls-protocol.md`, "Handshake wire format"). The
 * kind-445 transport wrap provides confidentiality, so relays never see
 * plaintext handshake bytes. The inbound pipeline therefore cannot assume a
 * single wire format when classifying or ordering framed messages; these
 * accessors read the framed fields uniformly across both carriages.
 */

/**
 * The MLS framed content type (application / proposal / commit) carried by a
 * private- or public-message {@link MlsMessage}, or `undefined` for non-framed
 * messages (welcome / key package / group info).
 */
export function framedContentType(
  message: MlsMessage,
): ContentTypeValue | undefined {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return message.privateMessage.contentType;
    case wireformats.mls_public_message:
      return message.publicMessage.content.contentType;
    default:
      return undefined;
  }
}

/**
 * The MLS epoch carried by a private- or public-message {@link MlsMessage}, or
 * `undefined` for non-framed messages. Normalizes to `bigint` regardless of how
 * each wire format models the field.
 */
export function framedEpoch(message: MlsMessage): bigint | undefined {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return BigInt(message.privateMessage.epoch);
    case wireformats.mls_public_message:
      return BigInt(message.publicMessage.content.epoch);
    default:
      return undefined;
  }
}
