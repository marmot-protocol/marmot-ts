/** @module @category Core - Transport */
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_RELAY_LIST_KIND,
  WELCOME_EVENT_KIND,
} from "./protocol.js";

/**
 * Marmot defines its group semantics independently of any one transport; a
 * transport binding maps those semantics onto a concrete delivery network's
 * wire identity (`transports/nostr.md`, target-architecture §4). Nostr is the
 * binding shipped here, but the protocol is written so another binding (a relay
 * mesh, a queue, etc.) could implement the same shape and carry the identical
 * MLS bytes.
 *
 * The binding owns only *transport addressing* — event kinds and routing tags.
 * The encrypted MLS payloads and the canonical signed group state (including
 * `transport.nostr.routing.v1`) are transport-independent.
 */
export interface TransportBinding {
  /** Stable binding name (matches the `transport.<name>.*` component family). */
  readonly name: string;
  /** Event kind carrying an encrypted group message (commit/proposal/app). */
  readonly groupMessageKind: number;
  /** Event kind carrying a Welcome. */
  readonly welcomeKind: number;
  /** Event kind for a published KeyPackage (legacy, read/delete only). */
  readonly keyPackageKind: number;
  /** Event kind for an addressable KeyPackage. */
  readonly addressableKeyPackageKind: number;
  /** Event kind for a member's KeyPackage relay list. */
  readonly keyPackageRelayListKind: number;
  /** Event kind for the privacy-preserving outer wrap of a Welcome. */
  readonly giftWrapKind: number;
  /** Single-letter event tag naming the (public) group a message routes to. */
  readonly groupIdTag: string;
}

/** The Nostr group routing tag (`h`) naming the public nostr group id. */
export const NOSTR_GROUP_ID_TAG = "h";

/** NIP-59 gift-wrap event kind used to wrap a Welcome for its recipient. */
export const GIFT_WRAP_KIND = 1059;

/**
 * The Nostr transport binding: the default (and currently only) Marmot delivery
 * binding. All kinds and the routing tag are gathered here so the transport
 * seam is explicit and a future binding can mirror the shape.
 */
export const nostrTransportBinding: TransportBinding = {
  name: "nostr",
  groupMessageKind: GROUP_EVENT_KIND,
  welcomeKind: WELCOME_EVENT_KIND,
  keyPackageKind: KEY_PACKAGE_KIND,
  addressableKeyPackageKind: ADDRESSABLE_KEY_PACKAGE_KIND,
  keyPackageRelayListKind: KEY_PACKAGE_RELAY_LIST_KIND,
  giftWrapKind: GIFT_WRAP_KIND,
  groupIdTag: NOSTR_GROUP_ID_TAG,
};
