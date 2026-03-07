import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { CiphersuiteName } from "ts-mls/crypto/ciphersuite.js";
import { PrivateKeyPackage } from "ts-mls/keyPackage.js";
import { createCredential } from "../core/credential.js";
import {
  createDeleteKeyPackageEvent,
  createKeyPackageEvent,
  getKeyPackageReference,
  getKeyPackageRelays,
} from "../core/key-package-event.js";
import { generateKeyPackage } from "../core/key-package.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  KEY_PACKAGE_KIND,
} from "../core/protocol.js";
import {
  KeyPackageStore,
  ListedKeyPackage,
  StoredKeyPackage,
} from "../store/key-package-store.js";
import { NostrNetworkInterface } from "./nostr-interface.js";
import { logger } from "../utils/debug.js";

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

/**
 * A key package entry as returned by {@link KeyPackageManager.list}
 * and {@link KeyPackageManager.watchKeyPackages}.
 *
 * Merges the locally stored key package with its published Nostr events,
 * giving a unified view of both private storage state and relay publish
 * state in a single object.
 */
export type KeyPackageEntry = ListedKeyPackage & {
  published: NostrEvent[];
};

/** Options for creating a new key package */
export type CreateKeyPackageOptions = {
  /** Relay URLs where the key package event will be published (required) */
  relays: string[];
  /**
   * Addressable slot identifier (`d` tag value) for the kind 30443 event.
   * If omitted, falls back to the manager's `clientId`. Throws
   * {@link MissingSlotIdentifierError} if neither is available.
   */
  d?: string;
  /** Ciphersuite to use (default: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) */
  ciphersuite?: CiphersuiteName;
  /** Whether to mark the key package with the MLS last_resort extension (default: true) */
  isLastResort?: boolean;
  /** Client identifier string to include in the key package event */
  client?: string;
  /** Whether to include the NIP-70 protected tag on the event */
  protected?: boolean;
};

/** Options for rotating a key package */
export type RotateKeyPackageOptions = {
  /**
   * Relay URLs for the new key package event.
   * If omitted, the relays from the most recent publish of the old key package are reused.
   */
  relays?: string[];
  /**
   * Addressable slot identifier (`d` tag value) for the replacement event.
   * If omitted, the `d` from the stored entry is reused (preferred). If the
   * stored entry has no `d` (legacy kind 443 package), a fresh random value
   * is generated.
   */
  d?: string;
  /** Ciphersuite to use for the new key package */
  ciphersuite?: CiphersuiteName;
  /** Whether to mark the new key package with the MLS last_resort extension (default: true) */
  isLastResort?: boolean;
  /** Client identifier string to include in the new key package event */
  client?: string;
  /** Whether to include the NIP-70 protected tag on the new event */
  protected?: boolean;
};

type KeyPackageManagerEvents = {
  /** Emitted when a key package is stored locally */
  keyPackageAdded: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package is removed from local storage */
  keyPackageRemoved: (keyPackageRef: Uint8Array) => void;
  /** Emitted when a key package is updated */
  keyPackageUpdated: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package publish is recorded (own publish or observed relay event) */
  keyPackagePublished: (
    refHex: string,
    eventId: string,
    relays: string[],
  ) => void;
};

/**
 * Manages the full lifecycle of MLS key packages — local private material and
 * the Nostr kind-30443 events that advertise this client to potential inviters.
 *
 * Legacy kind-443 events are supported for reading and deletion only; new
 * events are always published as kind 30443.
 *
 * @example
 * ```typescript
 * // Create and publish a key package using the manager's clientId as the slot
 * const manager = new KeyPackageManager({
 *   keyPackageStore: store,
 *   signer,
 *   network,
 *   clientId: "my-app-desktop",
 * });
 * const pkg = await manager.create({ relays: ["wss://relay.example.com"] });
 *
 * // Feed observed relay events — kind 443 and kind 30443 with an `i` tag are recorded
 * await manager.track(nostrEvent);
 *
 * // Rotate: publish a new kind 30443 under the same `d` slot (relay replaces automatically)
 * const newPkg = await manager.rotate(pkg.keyPackageRef);
 *
 * // List all key packages, filtering to those with published events
 * const published = (await manager.list()).filter(p => p.published.length > 0);
 * ```
 */
export class KeyPackageManager extends EventEmitter<KeyPackageManagerEvents> {
  /** The underlying private key material store */
  readonly store: KeyPackageStore;

  /**
   * Default slot identifier (`d` tag value) used by {@link create} when no
   * explicit `d` is passed in options. Set this to a stable string (e.g.
   * `"my-app-desktop"`) so all key packages from this manager share a single
   * addressable slot on relays.
   */
  readonly clientId: string | undefined;

  private readonly signer: EventSigner;
  private readonly network: NostrNetworkInterface;

  #log = logger.extend("KeyPackageManager");

  constructor(options: {
    keyPackageStore: KeyPackageStore;
    signer: EventSigner;
    network: NostrNetworkInterface;
    /** Default `d` tag value for {@link create}. Falls back to this when no explicit `d` is passed. */
    clientId?: string;
  }) {
    super();
    this.store = options.keyPackageStore;
    this.signer = options.signer;
    this.network = options.network;
    this.clientId = options.clientId;

    // Forward store events — only surface LocalKeyPackage additions
    this.store.on("keyPackageAdded", (pkg) => {
      this.emit("keyPackageAdded", pkg);
    });
    this.store.on("keyPackageUpdated", (kp) =>
      this.emit("keyPackageUpdated", kp),
    );
    this.store.on("keyPackageRemoved", (ref) =>
      this.emit("keyPackageRemoved", ref),
    );
  }

  // ---------------------------------------------------------------------------
  // Creation and publishing
  // ---------------------------------------------------------------------------

  /**
   * Creates a new key package, stores the private material locally, signs and
   * publishes a kind 30443 addressable event to the specified relays, and
   * records the event.
   *
   * The `d` (slot identifier) is resolved in order:
   * 1. `options.d` (explicit)
   * 2. `this.clientId` (manager default)
   * 3. Throws {@link MissingSlotIdentifierError}
   *
   * @param options - Creation options, including required relay URLs
   * @returns The stored key package (without private material)
   * @throws {MissingRelayError} if relays is empty
   * @throws {MissingSlotIdentifierError} if no slot identifier can be determined
   */
  async create(options: CreateKeyPackageOptions): Promise<ListedKeyPackage> {
    if (!options.relays || options.relays.length === 0) {
      throw new MissingRelayError();
    }

    const d = options.d ?? this.clientId;
    if (!d) {
      throw new MissingSlotIdentifierError();
    }

    this.#log("creating key package on relays: %O", options.relays);

    const pubkey = await this.signer.getPublicKey();
    const credential = createCredential(pubkey);
    const ciphersuite = await this.#getCiphersuiteImpl(options.ciphersuite);

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl: ciphersuite,
      isLastResort: options.isLastResort,
    });

    // Store private material locally, including the slot identifier
    await this.store.add({ ...keyPackage, d });

    // Build, sign and publish the kind 30443 event
    const eventTemplate = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      d,
      relays: options.relays,
      client: options.client,
      protected: options.protected,
    });
    const signed = await this.signer.signEvent(eventTemplate);
    await this.network.publish(options.relays, signed);

    // Record the published event on the stored entry
    const stored = await this.store.getKeyPackage(keyPackage.publicPackage);
    if (!stored) throw new Error("Key package not found after store operation");
    const refHex = bytesToHex(stored.keyPackageRef);
    await this.store.addPublished(refHex, signed);

    this.emit("keyPackagePublished", refHex, signed.id, options.relays);
    this.#log("created and published key package %s with slot %s", refHex, d);

    return {
      keyPackageRef: stored.keyPackageRef,
      publicPackage: stored.publicPackage,
      d: stored.d,
    };
  }

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  /**
   * Rotates a key package: publishes a new kind 30443 event (reusing the same
   * `d` slot so relays replace the old event automatically), then removes the
   * old private key material.
   *
   * For legacy kind-443 published events on the entry, a NIP-09 deletion is
   * sent before publishing the replacement. Kind-30443 published events do not
   * need explicit deletion — the new event supersedes them on relays.
   *
   * The `d` tag for the new event is resolved as:
   * 1. `existing.d` from the stored entry (preferred — reuses same slot)
   * 2. `options.d` (explicit override)
   * 3. A freshly generated random 32-byte hex string
   *
   * Relay URLs are resolved as:
   * 1. `options.relays` (explicit)
   * 2. Relays tag from the most recent published event of the old key package
   *
   * @param ref - The key package reference of the key package to rotate
   * @param options - Options for the new key package
   * @returns The new stored key package (without private material)
   * @throws {KeyPackageNotFoundError} if the key package ref is not found in the local store
   * @throws {KeyPackageRotatePreconditionError} if no relay URLs can be determined for the new key package
   */
  async rotate(
    ref: Uint8Array | string,
    options?: RotateKeyPackageOptions,
  ): Promise<ListedKeyPackage> {
    const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
    this.#log("rotating key package %s", refHex);

    const existing = await this.store.getKeyPackage(ref);
    if (!existing) {
      throw new KeyPackageNotFoundError(refHex);
    }

    // Determine relays for the new key package
    const oldEvents = existing.published ?? [];
    const relaysForNew =
      options?.relays ??
      (oldEvents.length > 0
        ? getKeyPackageRelays(oldEvents[oldEvents.length - 1])
        : undefined);

    if (!relaysForNew || relaysForNew.length === 0) {
      throw new KeyPackageRotatePreconditionError();
    }

    // Resolve the slot identifier for the new event:
    // prefer the stored entry's d (same slot = relay auto-replaces),
    // then an explicit override, then generate a fresh random value.
    const newD = existing.d ?? options?.d ?? bytesToHex(randomBytes(32));

    // Publish NIP-09 deletion only for legacy kind-443 published events.
    // Kind-30443 events are superseded automatically by the new event on relays.
    const legacyEvents = oldEvents.filter((e) => e.kind === KEY_PACKAGE_KIND);
    if (legacyEvents.length > 0) {
      const eventIds = legacyEvents.map((e) => e.id);
      const deleteTemplate = createDeleteKeyPackageEvent({ events: eventIds });
      const signedDelete = await this.signer.signEvent(deleteTemplate);
      const allOldRelays = [
        ...new Set(legacyEvents.flatMap((e) => getKeyPackageRelays(e) ?? [])),
      ];
      await this.network.publish(allOldRelays, signedDelete);
    }

    // Create and publish the new key package under the resolved slot
    const newPkg = await this.create({
      relays: relaysForNew,
      d: newD,
      ciphersuite: options?.ciphersuite,
      isLastResort: options?.isLastResort,
      client: options?.client,
      protected: options?.protected,
    });

    // Remove old private key material (and its published events)
    await this.store.remove(ref);

    return newPkg;
  }

  // ---------------------------------------------------------------------------
  // Removal
  // ---------------------------------------------------------------------------

  /**
   * Removes a key package from local private key storage only.
   *
   * Does not publish a relay deletion and does not touch publish records.
   * Use when the key package was never published, or when relay cleanup has
   * already been handled separately.
   *
   * @param ref - The key package reference to remove
   */
  async remove(ref: Uint8Array | string): Promise<void> {
    const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
    await this.store.remove(ref);
    this.#log("removed key package %s from local store", refHex);
  }

  /**
   * Completely purges one or more key packages: publishes a NIP-09 deletion
   * for all known relay event IDs, removes local private key material, and
   * clears the publish records.
   *
   * For kind-30443 published events, both `e` and `a` (addressable coordinate)
   * deletion tags are included. For legacy kind-443 events, only `e` tags are
   * used.
   *
   * Accepts a single ref or an array of refs so callers can bulk-purge in one
   * shot (e.g. "nuke everything and start fresh"). Refs with no recorded
   * published events are silently skipped for the network step — no kind 5 is
   * published for them — but their local private key material is still removed.
   *
   * @param refs - One or more key package references (hex string or Uint8Array)
   */
  async purge(
    refs: Uint8Array | string | Array<Uint8Array | string>,
  ): Promise<void> {
    const refList = Array.isArray(refs) ? refs : [refs];
    this.#log("purging %d key package(s)", refList.length);

    // Collect all published events and relays across the provided refs
    const allEvents: NostrEvent[] = [];
    const allRelays = new Set<string>();

    for (const ref of refList) {
      const stored = await this.store.getKeyPackage(ref);
      const events = stored?.published ?? [];
      for (const event of events) {
        allEvents.push(event);
        for (const relay of getKeyPackageRelays(event) ?? []) {
          allRelays.add(relay);
        }
      }
    }

    // Publish a single kind 5 deletion covering all events, if any
    if (allEvents.length > 0) {
      const draft = createDeleteKeyPackageEvent({ events: allEvents });
      const signed = await this.signer.signEvent(draft);
      await this.network.publish([...allRelays], signed);
      this.#log(
        "published %s delete event for %d key packages",
        signed.id,
        allEvents.length,
      );
    }

    // Remove local private key material for all refs
    for (const ref of refList) {
      await this.store.remove(ref);
    }
  }

  // ---------------------------------------------------------------------------
  // Publish tracking
  // ---------------------------------------------------------------------------

  /**
   * Observes a Nostr event and, if it is a kind 443 or kind 30443 key package
   * event with a valid `i` tag (MIP-00 keyPackageRef), records it in the store.
   *
   * This is the primary way for apps to populate publish records from relay
   * subscriptions. Records all observed key package events regardless of whether
   * private key material is held locally — enabling deletion of key packages
   * published by other devices.
   *
   * @param event - Any Nostr event; non-key-package events are silently ignored
   * @returns `true` if the event was recorded, `false` if ignored
   */
  async track(event: NostrEvent): Promise<boolean> {
    if (
      event.kind !== KEY_PACKAGE_KIND &&
      event.kind !== ADDRESSABLE_KEY_PACKAGE_KIND
    ) {
      return false;
    }

    const refHex = getKeyPackageReference(event);
    if (!refHex) return false;

    try {
      await this.store.addPublished(refHex, event);
    } catch {
      // Event body could not be decoded as a KeyPackage — treat as invalid
      return false;
    }

    const relays = getKeyPackageRelays(event) ?? [];
    this.emit("keyPackagePublished", refHex, event.id, relays);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Lists all locally stored key packages, each enriched with their published
   * Nostr events.
   *
   * Returns the same shape as {@link watchKeyPackages} snapshots so apps can
   * use identical rendering logic for both the initial load and live updates.
   */
  async list(): Promise<KeyPackageEntry[]> {
    return this.#buildSnapshot();
  }

  /** Returns the number of locally stored key packages. */
  async count(): Promise<number> {
    return this.store.count();
  }

  /** Checks whether a key package exists in local private key storage. */
  async has(ref: Uint8Array | string): Promise<boolean> {
    return this.store.has(ref);
  }

  /** Retrieves the full key package from the store. */
  async get(ref: Uint8Array | string): Promise<StoredKeyPackage | null> {
    return this.store.getKeyPackage(ref);
  }

  /**
   * Retrieves the private key material for a key package.
   * Used internally by {@link MarmotClient} when processing Welcome messages.
   *
   * @param ref - The key package reference
   * @returns The private key package, or null if not found
   */
  async getPrivateKey(
    ref: Uint8Array | string,
  ): Promise<PrivateKeyPackage | null> {
    return this.store.getPrivateKey(ref);
  }

  /**
   * Marks a key package as used by setting `used = true` on the stored entry.
   *
   * This flag signals that the key package has been consumed (e.g. used to join
   * a group). Applications can use this to periodically list and rotate used
   * key packages to maintain a fresh supply on relays.
   *
   * Does nothing if no entry is found for the given ref.
   *
   * @param ref - The key package reference
   */
  async markUsed(ref: Uint8Array | string): Promise<void> {
    const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
    await this.store.markUsed(ref);
    this.#log("marked key package %s as used", refHex);
  }

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  /**
   * Watches for any change to key packages or their published events.
   *
   * Yields the current snapshot on subscription (after listeners are installed),
   * then re-yields on every subsequent change. Each snapshot is a list of all
   * locally stored key packages merged with their published Nostr events.
   *
   * Listens to both `keyPackageAdded`/`keyPackageRemoved` (private store changes)
   * and `keyPackagePublished` (publish record changes) to ensure the snapshot
   * stays up to date regardless of what changed.
   *
   * @example
   * ```ts
   * for await (const packages of client.keyPackages.watchKeyPackages()) {
   *   console.log(`${packages.length} key packages, ` +
   *     `${packages.filter(p => p.published.length > 0).length} published`);
   * }
   * ```
   */
  async *watchKeyPackages(): AsyncGenerator<KeyPackageEntry[]> {
    let resolveNext: (() => void) | null = null;
    let pending = false;

    const signal = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      } else {
        pending = true;
      }
    };

    this.on("keyPackageAdded", signal);
    this.on("keyPackageRemoved", signal);
    this.on("keyPackageUpdated", signal);
    this.on("keyPackagePublished", signal);

    try {
      // Yield initial snapshot after listeners are installed to avoid missing
      // updates that occur between snapshot and subscription.
      yield await this.#buildSnapshot();

      while (true) {
        await new Promise<void>((resolve) => {
          if (pending) {
            pending = false;
            resolve();
          } else {
            resolveNext = resolve;
          }
        });
        yield await this.#buildSnapshot();
      }
    } finally {
      this.off("keyPackageAdded", signal);
      this.off("keyPackageRemoved", signal);
      this.off("keyPackageUpdated", signal);
      this.off("keyPackagePublished", signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #buildSnapshot(): Promise<KeyPackageEntry[]> {
    const local = await this.store.list();
    return local.map((pkg) => ({
      ...pkg,
      published: pkg.published ?? [],
    }));
  }

  async #getCiphersuiteImpl(name?: CiphersuiteName) {
    const { defaultCryptoProvider } = await import("ts-mls");
    const { ciphersuites } = await import("ts-mls/crypto/ciphersuite.js");
    const ciphersuiteName =
      name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
    const id = ciphersuites[ciphersuiteName];
    return defaultCryptoProvider.getCiphersuiteImpl(id);
  }
}
