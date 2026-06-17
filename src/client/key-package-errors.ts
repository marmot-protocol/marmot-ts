/** @module @category Client - Key Package Manager */

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
 * nor recoverable from the old package's publish records.
 */
export class KeyPackageRotatePreconditionError extends Error {
  constructor() {
    super(
      "Cannot rotate: no relay URLs available. Pass relays in options or ensure the old key package has published events.",
    );
    this.name = "KeyPackageRotatePreconditionError";
  }
}
