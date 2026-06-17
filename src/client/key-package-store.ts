/** @module @category Client - Key Package Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import {
  CryptoProvider,
  defaultCryptoProvider,
  KeyPackage,
  PrivateKeyPackage,
} from "ts-mls";

import {
  getKeyPackage,
  getKeyPackageIdentifier,
} from "../core/key-package-event.js";
import { calculateKeyPackageRef } from "../core/key-package.js";
import { logger } from "../utils/debug.js";
import { GenericKeyValueStore } from "../utils/key-value.js";
import { deduplicatePublishedEvents } from "./key-package-events.js";

// ---------------------------------------------------------------------------
// Stored entry types
// ---------------------------------------------------------------------------

/**
 * A key package that has local private material.
 *
 * Created when generating or importing a key package for which the private
 * keys are held locally. Narrow from {@link StoredKeyPackage} by checking
 * `privatePackage !== undefined`.
 */
export type LocalKeyPackage = {
  /** The calculated key package reference */
  keyPackageRef: Uint8Array;
  /** The public key package */
  publicPackage: KeyPackage;
  /** The private key package — its presence is the discriminant for a local entry */
  privatePackage: PrivateKeyPackage;
  /** Nostr kind-30443 addressable slot identifier (`d` tag value) */
  identifier?: string;
  /** Nostr kind-30443 events this key package has been published under */
  published?: NostrEvent[];
  /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
  used?: boolean;
};

/**
 * A key package observed on relays for which no private material is held locally.
 *
 * Created when tracking a kind-30443 event from another device.
 * Enables cross-device deletion without requiring the private keys to be
 * present. The public key package is always present — events that cannot be
 * decoded are rejected as invalid.
 *
 * Narrow from {@link StoredKeyPackage} by checking `privatePackage === undefined`.
 */
export type TrackedKeyPackage = {
  /** The calculated key package reference */
  keyPackageRef: Uint8Array;
  /** The public key package, decoded from the kind-30443 event body */
  publicPackage: KeyPackage;
  /** Always undefined — the discriminant that identifies this as a tracked entry */
  privatePackage?: undefined;
  /** Nostr kind-30443 addressable slot identifier (`d` tag value) */
  identifier?: string;
  /** Nostr kind-30443 events this key package has been published under */
  published?: NostrEvent[];
  /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
  used?: boolean;
};

/**
 * A stored key package — either a locally-held one (with private material) or
 * a tracked foreign one (without private material).
 *
 * Use `privatePackage` to narrow the type:
 *
 * ```ts
 * if (pkg.privatePackage !== undefined) {
 *   // pkg is LocalKeyPackage
 * } else {
 *   // pkg is TrackedKeyPackage
 * }
 * ```
 */
export type StoredKeyPackage = LocalKeyPackage | TrackedKeyPackage;

/** A {@link LocalKeyPackage} without the private material, safe to expose in listings */
export type ListedKeyPackage = Omit<StoredKeyPackage, "privatePackage">;

/** Events emitted by {@link KeyPackageStore} as its entries change. */
export type KeyPackageStoreEvents = {
  /** Emitted when a key package is stored locally */
  added: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package is removed from local storage */
  removed: (keyPackageRef: Uint8Array) => void;
  /** Emitted when a key package is updated */
  updated: (keyPackage: StoredKeyPackage) => void;
};

/**
 * Owns the persisted key package entries — the local private material and the
 * tracked kind-30443 events that advertise each package. Pure storage: it never
 * signs or publishes (that is {@link KeyPackagePublisher}'s job). Mirrors
 * darkmatter's `AccountSecretStore` seam.
 */
export class KeyPackageStore extends EventEmitter<KeyPackageStoreEvents> {
  readonly #store: GenericKeyValueStore<StoredKeyPackage>;
  readonly #cryptoProvider: CryptoProvider;
  #log = logger.extend("KeyPackageStore");

  constructor(
    store: GenericKeyValueStore<StoredKeyPackage>,
    cryptoProvider: CryptoProvider = defaultCryptoProvider,
  ) {
    super();
    this.#store = store;
    this.#cryptoProvider = cryptoProvider;
  }

  /** Resolves a ref argument to a hex storage key */
  #resolveKey(ref: Uint8Array | string): string {
    if (typeof ref === "string") return ref;
    return bytesToHex(ref);
  }

  /**
   * Adds a {@link LocalKeyPackage} to the store.
   *
   * @param keyPackage - Must include `publicPackage` and `privatePackage`.
   *   Optionally include `identifier` to persist the addressable slot identifier.
   * @returns The storage key (hex ref string)
   */
  async add(
    keyPackage: Pick<LocalKeyPackage, "publicPackage" | "privatePackage"> &
      Partial<Pick<LocalKeyPackage, "published" | "identifier">>,
  ): Promise<string> {
    const keyPackageRef = await calculateKeyPackageRef(
      keyPackage.publicPackage,
      this.#cryptoProvider,
    );
    const key = bytesToHex(keyPackageRef);

    const entry: LocalKeyPackage = {
      keyPackageRef,
      publicPackage: keyPackage.publicPackage,
      privatePackage: keyPackage.privatePackage,
      ...(keyPackage.identifier !== undefined
        ? { identifier: keyPackage.identifier }
        : {}),
      ...(keyPackage.published !== undefined
        ? { published: deduplicatePublishedEvents(keyPackage.published) }
        : {}),
    };

    await this.#store.setItem(key, entry);
    this.emit("added", entry);
    this.#log(
      "added %s" + (entry.privatePackage ? " with private key" : ""),
      key,
    );

    return key;
  }

  /**
   * Appends a kind-30443 Nostr event to the `published` list of
   * the key package identified by `ref`. If no entry exists yet, a
   * {@link TrackedKeyPackage} is created by decoding the public key package
   * from the event body.
   *
   * Throws if the event body cannot be decoded as a valid key package.
   */
  async addPublished(
    ref: string | Uint8Array,
    event: NostrEvent,
  ): Promise<void> {
    const key = this.#resolveKey(ref);
    const existing = await this.#store.getItem(key);

    // Extract the addressable slot identifier if this is a kind 30443 event
    const identifier = getKeyPackageIdentifier(event);

    if (existing) {
      const published = deduplicatePublishedEvents([
        ...(existing.published ?? []),
        event,
      ]);
      const shouldPersistIdentifier =
        identifier !== undefined && existing.identifier === undefined;
      const publishedChanged =
        existing.published === undefined ||
        published.length !== existing.published.length ||
        !published.every(
          (e, index) => e.id === existing.published?.[index]?.id,
        );

      if (!publishedChanged && !shouldPersistIdentifier) {
        return;
      }

      const updated: StoredKeyPackage = {
        ...existing,
        // Persist identifier if discovered for the first time on this entry
        ...(shouldPersistIdentifier ? { identifier } : {}),
        published,
      };

      await this.#store.setItem(key, updated);
      this.emit("updated", updated);
      this.#log("stored published event %s for %s", event.id, ref);
    } else {
      // No local entry — decode the public key package from the event body.
      // Throws if the event content is not a valid encoded KeyPackage.
      const publicPackage = getKeyPackage(event);

      const keyPackageRef = await calculateKeyPackageRef(
        publicPackage,
        this.#cryptoProvider,
      );

      const entry: TrackedKeyPackage = {
        keyPackageRef,
        publicPackage,
        ...(identifier !== undefined ? { identifier } : {}),
        published: [event],
      };

      await this.#store.setItem(key, entry);
      this.emit("added", entry);
      this.#log("added key package from event %s", event.id);
    }
  }

  /**
   * Retrieves the stored key package entry.
   * Returns any entry regardless of whether it has private material.
   */
  async get(ref: Uint8Array | string): Promise<StoredKeyPackage | null> {
    const key = this.#resolveKey(ref);
    return this.#store.getItem(key);
  }

  /**
   * Removes a key package from the backend.
   */
  async remove(ref: Uint8Array | string): Promise<void> {
    const key = this.#resolveKey(ref);
    const stored = await this.#store.getItem(key);
    await this.#store.removeItem(key);

    if (stored) {
      this.emit("removed", stored.keyPackageRef);
      this.#log("removed key package %s", key);
    }
  }

  /**
   * Lists all {@link LocalKeyPackage} entries (those with private material),
   * without the private package itself.
   */
  async list(): Promise<ListedKeyPackage[]> {
    const allKeys = await this.#store.keys();

    const packages = await Promise.all(
      allKeys.map((key) => this.#store.getItem(key)),
    );

    return packages
      .filter(
        (pkg): pkg is LocalKeyPackage =>
          pkg !== null && pkg.privatePackage !== undefined,
      )
      .map(({ keyPackageRef, publicPackage, identifier, published, used }) => ({
        keyPackageRef,
        publicPackage,
        ...(identifier !== undefined ? { identifier } : {}),
        ...(published !== undefined ? { published } : {}),
        ...(used !== undefined ? { used } : {}),
      }));
  }

  /**
   * Lists all local key packages with their published events defaulted to an
   * empty array, suitable for emitting as a stable snapshot.
   */
  async snapshot(): Promise<ListedKeyPackage[]> {
    const local = await this.list();
    return local.map((pkg) => ({
      ...pkg,
      published: pkg.published ?? [],
    }));
  }

  /** Returns the number of locally stored key packages (those with private material). */
  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** Checks whether a key package with local private material exists. */
  async has(ref: Uint8Array | string): Promise<boolean> {
    const key = this.#resolveKey(ref);
    const item = await this.#store.getItem(key);
    return item !== null && item.privatePackage !== undefined;
  }

  /**
   * Retrieves the private key material for a key package.
   *
   * @param ref - The key package reference
   * @returns The private key package, or null if not found
   */
  async getPrivateKey(
    ref: Uint8Array | string,
  ): Promise<PrivateKeyPackage | null> {
    const key = this.#resolveKey(ref);
    const stored = await this.#store.getItem(key);
    return stored?.privatePackage ?? null;
  }

  /**
   * Marks a key package as used by setting `used = true` on the stored entry.
   *
   * Does nothing if no entry is found for the given ref.
   *
   * @param ref - The key package reference
   */
  async markUsed(ref: Uint8Array | string): Promise<void> {
    const key = this.#resolveKey(ref);
    const existing = await this.#store.getItem(key);
    if (!existing) return;

    const updated: StoredKeyPackage = { ...existing, used: true };
    await this.#store.setItem(key, updated);
    this.emit("updated", updated);
    this.#log("marked key package %s as used", key);
  }

  /** Clears all entries (local and tracked) from the store. */
  async clear(): Promise<void> {
    const allKeys = await this.#store.keys();
    for (const key of allKeys) {
      const stored = await this.#store.getItem(key);
      await this.#store.removeItem(key);
      if (stored) {
        this.emit("removed", stored.keyPackageRef);
      }
    }
  }
}
