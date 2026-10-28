/** @module @category Client - Key Package Manager */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { PublishResponse } from "./nostr-interface.js";

/**
 * No requested relay acknowledged a KeyPackage publication or deletion.
 * Responses retain rejection/uncertainty details; the signed event is provided
 * for inspection. This error does not imply that no relay observed the event.
 */
export class KeyPackagePublishError extends Error {
  constructor(
    readonly event: NostrEvent,
    readonly relays: string[],
    readonly responses: Record<string, PublishResponse>,
  ) {
    super("No requested relay acknowledged the key package event");
    this.name = "KeyPackagePublishError";
  }
}

/**
 * Thrown by {@link KeyPackageManager.create} when no relay URLs are provided.
 * Callers can catch this specifically to prompt the user for relay configuration.
 */
export class MissingRelayError extends Error {
  constructor() {
    super("At least one relay URL is required to publish a key package");
    this.name = "MissingRelayError";
  }
}

/**
 * Thrown by {@link KeyPackageManager.create} when no slot identifier (`d` tag)
 * can be determined — neither passed in options nor set as `clientId` on the
 * manager. Set `clientId` on the manager or pass `d` in the options.
 */
export class MissingSlotIdentifierError extends Error {
  constructor() {
    super(
      "Cannot create key package: no slot identifier available. Pass 'd' in options or set 'clientId' on the manager.",
    );
    this.name = "MissingSlotIdentifierError";
  }
}

/**
 * Thrown by {@link KeyPackageManager.rotate} when the given key package
 * reference is not found in the local store.
 */
export class KeyPackageNotFoundError extends Error {
  constructor(refHex: string) {
    super(`Key package not found: ${refHex}`);
    this.name = "KeyPackageNotFoundError";
  }
}

/**
 * Thrown by {@link KeyPackageManager.rotate} when no relay URLs can be
 * determined for the replacement key package — neither passed explicitly
 * nor recoverable from the old package's local publication routes.
 */
export class KeyPackageRotatePreconditionError extends Error {
  constructor() {
    super(
      "Cannot rotate: no relay URLs available. Pass relays in options or retain local publication routes for the old key package.",
    );
    this.name = "KeyPackageRotatePreconditionError";
  }
}
