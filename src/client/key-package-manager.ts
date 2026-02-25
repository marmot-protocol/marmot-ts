import { bytesToHex } from "@noble/hashes/utils.js";
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
import { KEY_PACKAGE_KIND } from "../core/protocol.js";
import {
  KeyPackageStore,
  ListedKeyPackage,
  PublishedKeyPackageRecord,
  PublishedKeyPackageStoreBackend,
  StoredKeyPackage,
} from "../store/key-package-store.js";
import { NostrNetworkInterface } from "./nostr-interface.js";

/**
 * A key package entry as returned by {@link KeyPackageManager.list}
 * and {@link KeyPackageManager.watch}.
 *
 * Merges the locally stored key package with its publish records from the
 * published backend, giving a unified view of both private storage state and
 * relay publish state in a single object.
 */
export type KeyPackageEntry = ListedKeyPackage & {
  published: PublishedKeyPackageRecord[];
};

/** Options for creating a new key package */
export type CreateKeyPackageOptions = {
  /** Relay URLs where the key package event will be published (required) */
  relays: string[];
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
  keyPackageAdded: (keyPackage: ListedKeyPackage) => void;
  /** Emitted when a key package is removed from local storage */
  keyPackageRemoved: (keyPackageRef: Uint8Array) => void;
  /** Emitted when a key package publish is recorded (own publish or observed relay event) */
  keyPackagePublished: (
    refHex: string,
    eventId: string,
    relays: string[],
  ) => void;
};

/**
 * Manages the full lifecycle of MLS key packages — local private material and
 * the Nostr kind 443 events that advertise this client to potential inviters.
 *
 * Uses two independent storage backends:
 * - `keyPackageStore` ({@link KeyPackageStore}) — holds private key material
 * - `publishedKeyPackageStore` ({@link PublishedKeyPackageStoreBackend}) — a
 *   plain key-value backend (keyPackageRef hex → {@link PublishedKeyPackageRecord}[])
 *   tracking which relay events have been published for each ref, independently
 *   of whether private keys are held locally (enables cross-device deletion)
 *
 * @example
 * ```typescript
 * // Create and publish a key package
 * const pkg = await client.keyPackages.create({ relays: ["wss://relay.example.com"] });
 *
 * // Feed observed relay events — any kind 443 with an `i` tag is recorded
 * await client.keyPackages.track(nostrEvent);
 *
 * // Rotate: delete old from relays, publish new
 * const newPkg = await client.keyPackages.rotate(pkg.keyPackageRef);
 *
 * // List all key packages, filtering to those with published events
 * const published = (await client.keyPackages.list())
 *   .filter(p => p.published.length > 0);
 * ```
 */
export class KeyPackageManager extends EventEmitter<KeyPackageManagerEvents> {
  /** The underlying private key material store */
  readonly store: KeyPackageStore;

  private readonly published: PublishedKeyPackageStoreBackend;
  private readonly signer: EventSigner;
  private readonly network: NostrNetworkInterface;

  constructor(options: {
    keyPackageStore: KeyPackageStore;
    /** Raw key-value backend: keyPackageRef hex → PublishedKeyPackageRecord[] */
    publishedKeyPackageStore: PublishedKeyPackageStoreBackend;
    signer: EventSigner;
    network: NostrNetworkInterface;
  }) {
    super();
    this.store = options.keyPackageStore;
    this.published = options.publishedKeyPackageStore;
    this.signer = options.signer;
    this.network = options.network;

    // Forward store events
    this.store.on("keyPackageAdded", (pkg) => {
      this.emit("keyPackageAdded", {
        keyPackageRef: pkg.keyPackageRef,
        publicPackage: pkg.publicPackage,
      });
    });
    this.store.on("keyPackageRemoved", (ref) => {
      this.emit("keyPackageRemoved", ref);
    });
  }

  // ---------------------------------------------------------------------------
  // Creation and publishing
  // ---------------------------------------------------------------------------

  /**
   * Creates a new key package, stores the private material locally, signs and
   * publishes a kind 443 event to the specified relays, and records the event ID.
   *
   * @param options - Creation options, including required relay URLs
   * @returns The stored key package (without private material)
   * @throws Error if relays is empty
   */
  async create(options: CreateKeyPackageOptions): Promise<ListedKeyPackage> {
    if (!options.relays || options.relays.length === 0) {
      throw new Error(
        "At least one relay URL is required to publish a key package",
      );
    }

    const pubkey = await this.signer.getPublicKey();
    const credential = createCredential(pubkey);
    const ciphersuite = await this.#getCiphersuiteImpl(options.ciphersuite);

    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl: ciphersuite,
      isLastResort: options.isLastResort,
    });

    // Store private material locally
    await this.store.add(keyPackage);

    // Build, sign and publish the kind 443 event
    const eventTemplate = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      relays: options.relays,
      client: options.client,
      protected: options.protected,
    });
    const signed = await this.signer.signEvent(eventTemplate);
    await this.network.publish(options.relays, signed);

    // Record the publish using the ref from the stored entry
    const stored = await this.store.getKeyPackage(keyPackage.publicPackage);
    if (!stored) throw new Error("Key package not found after store operation");
    const refHex = bytesToHex(stored.keyPackageRef);
    await this.#addPublishRecord(refHex, signed.id, options.relays);
    this.emit("keyPackagePublished", refHex, signed.id, options.relays);

    return {
      keyPackageRef: stored.keyPackageRef,
      publicPackage: stored.publicPackage,
    };
  }

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  /**
   * Rotates a key package: publishes a kind 5 deletion for all known relay event
   * IDs of the old key package, then creates and publishes a new one, and removes
   * the old private key material and publish records.
   *
   * If the old key package has no recorded published events, the deletion step is
   * skipped. If no relays are passed in options, the relays from the most recent
   * publish of the old key package are reused.
   *
   * @param ref - The key package reference of the key package to rotate
   * @param options - Options for the new key package
   * @returns The new stored key package (without private material)
   * @throws Error if the key package ref is not found in the private key store
   * @throws Error if no relay URLs can be determined for the new key package
   */
  async rotate(
    ref: Uint8Array | string,
    options?: RotateKeyPackageOptions,
  ): Promise<ListedKeyPackage> {
    const refHex = typeof ref === "string" ? ref : bytesToHex(ref);

    const existing = await this.store.getKeyPackage(ref);
    if (!existing) {
      throw new Error(`Key package not found: ${refHex}`);
    }

    // Determine relays for the new key package
    const oldRecords = await this.#getPublishRecords(refHex);
    const relaysForNew =
      options?.relays ??
      (oldRecords.length > 0
        ? oldRecords[oldRecords.length - 1].relays
        : undefined);

    if (!relaysForNew || relaysForNew.length === 0) {
      throw new Error(
        "Cannot rotate: no relay URLs available. Pass relays in options or ensure the old key package has published events.",
      );
    }

    // Publish kind 5 deletion for all known event IDs of the old key package
    if (oldRecords.length > 0) {
      const eventIds = oldRecords.map((r) => r.eventId);
      const deleteTemplate = createDeleteKeyPackageEvent({ events: eventIds });
      const signedDelete = await this.signer.signEvent(deleteTemplate);
      const allOldRelays = [...new Set(oldRecords.flatMap((r) => r.relays))];
      await this.network.publish(allOldRelays, signedDelete);
    }

    // Create and publish the new key package
    const newPkg = await this.create({
      relays: relaysForNew,
      ciphersuite: options?.ciphersuite,
      isLastResort: options?.isLastResort,
      client: options?.client,
      protected: options?.protected,
    });

    // Remove old private key material and its publish records
    await this.store.remove(ref);
    await this.published.removeItem(refHex);

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
    await this.store.remove(ref);
  }

  /**
   * Completely purges one or more key packages: publishes a kind 5 (NIP-09)
   * deletion for all known relay event IDs, removes local private key material,
   * and clears the publish records.
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

    // Collect all event IDs and relays across the provided refs
    const allEventIds: string[] = [];
    const allRelays = new Set<string>();
    const resolvedHexes: string[] = [];

    for (const ref of refList) {
      const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
      resolvedHexes.push(refHex);
      const records = await this.#getPublishRecords(refHex);
      for (const record of records) {
        allEventIds.push(record.eventId);
        for (const relay of record.relays) {
          allRelays.add(relay);
        }
      }
    }

    // Publish a single kind 5 deletion covering all event IDs, if any
    if (allEventIds.length > 0) {
      const deleteTemplate = createDeleteKeyPackageEvent({
        events: allEventIds,
      });
      const signedDelete = await this.signer.signEvent(deleteTemplate);
      await this.network.publish([...allRelays], signedDelete);
    }

    // Remove local private key material and publish records for all refs
    for (const ref of refList) {
      await this.store.remove(ref);
    }
    for (const refHex of resolvedHexes) {
      await this.published.removeItem(refHex);
    }
  }

  // ---------------------------------------------------------------------------
  // Publish tracking
  // ---------------------------------------------------------------------------

  /**
   * Observes a Nostr event and, if it is a kind 443 key package event with a
   * valid `i` tag (MIP-00 keyPackageRef), records it in the published backend.
   *
   * This is the primary way for apps to populate publish records from relay
   * subscriptions. Records all observed kind 443 events regardless of whether
   * private key material is held locally — enabling deletion of key packages
   * published by other devices.
   *
   * @param event - Any Nostr event; non-443 events are silently ignored
   * @returns `true` if the event was recorded, `false` if ignored
   */
  async track(event: NostrEvent): Promise<boolean> {
    if (event.kind !== KEY_PACKAGE_KIND) return false;

    let refHex = getKeyPackageReference(event);
    if (!refHex) return false;

    const relays = getKeyPackageRelays(event) ?? [];
    await this.#addPublishRecord(refHex, event.id, relays);
    this.emit("keyPackagePublished", refHex, event.id, relays);
    return true;
  }

  /**
   * Records a publish that happened out-of-band (i.e. without going through
   * {@link create}). Useful when the app manages signing and publishing itself.
   *
   * @param ref - The key package reference (hex string or Uint8Array)
   * @param eventId - The Nostr event ID of the published kind 443 event
   * @param relays - The relay URLs the event was published to
   */
  async recordPublished(
    ref: Uint8Array | string,
    eventId: string,
    relays: string[],
  ): Promise<void> {
    const refHex = typeof ref === "string" ? ref : bytesToHex(ref);
    await this.#addPublishRecord(refHex, eventId, relays);
    this.emit("keyPackagePublished", refHex, eventId, relays);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Lists all locally stored key packages, each enriched with their publish
   * records from the published backend.
   *
   * Returns the same shape as {@link watch} snapshots so apps can
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
   * Returns all Nostr event IDs that a given key package ref has been published under.
   * Returns an empty array if no records exist.
   */
  async getPublishedEventIds(ref: Uint8Array | string): Promise<string[]> {
    return (await this.#getPublishRecords(ref)).map((r) => r.eventId);
  }

  /**
   * Returns all publish records for a given key package ref.
   * Returns an empty array if no records exist.
   */
  async getPublishedEvents(
    ref: Uint8Array | string,
  ): Promise<PublishedKeyPackageRecord[]> {
    return this.#getPublishRecords(ref);
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

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  /**
   * Watches for any change to key packages or their published events.
   *
   * Yields the current snapshot on subscription (after listeners are installed),
   * then re-yields on every subsequent change. Each snapshot is a list of all
   * locally stored key packages merged with their published event records from
   * the published backend.
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
  async *watch(): AsyncGenerator<KeyPackageEntry[]> {
    let resolveNext: (() => void) | null = null;

    const signal = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.on("keyPackageAdded", signal);
    this.on("keyPackageRemoved", signal);
    this.on("keyPackagePublished", signal);

    try {
      // Yield initial snapshot after listeners are installed to avoid missing
      // updates that occur between snapshot and subscription.
      yield await this.#buildSnapshot();

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        yield await this.#buildSnapshot();
      }
    } finally {
      this.off("keyPackageAdded", signal);
      this.off("keyPackageRemoved", signal);
      this.off("keyPackagePublished", signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #resolveRefHex(ref: Uint8Array | string): string {
    return typeof ref === "string" ? ref : bytesToHex(ref);
  }

  async #getPublishRecords(
    ref: Uint8Array | string,
  ): Promise<PublishedKeyPackageRecord[]> {
    const key = this.#resolveRefHex(ref);
    return (await this.published.getItem(key)) ?? [];
  }

  async #addPublishRecord(
    refHex: string,
    eventId: string,
    relays: string[],
  ): Promise<void> {
    const existing = (await this.published.getItem(refHex)) ?? [];
    const record: PublishedKeyPackageRecord = {
      eventId,
      relays,
      publishedAt: Math.floor(Date.now() / 1000),
    };
    await this.published.setItem(refHex, [...existing, record]);
  }

  async #buildSnapshot(): Promise<KeyPackageEntry[]> {
    const local = await this.store.list();
    return Promise.all(
      local.map(async (pkg) => ({
        ...pkg,
        published: await this.#getPublishRecords(pkg.keyPackageRef),
      })),
    );
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
