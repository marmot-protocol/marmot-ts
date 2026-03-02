import { bytesToHex } from "@noble/hashes/utils.js";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { CryptoProvider, defaultCryptoProvider } from "ts-mls";
import { KeyPackage, PrivateKeyPackage } from "ts-mls/keyPackage.js";
import { getKeyPackage } from "../core/key-package-event.js";
import { calculateKeyPackageRef } from "../core/key-package.js";
import { KeyValueStoreBackend } from "../utils/key-value.js";
import { logger } from "../utils/debug.js";

/**
 * A key package that has local private material.
 *
 * Created by {@link KeyPackageStore.add} when generating or importing a key
 * package for which the private keys are held locally. Narrow from
 * {@link StoredKeyPackage} by checking `privatePackage !== undefined`.
 */
export type LocalKeyPackage = {
  /** The calculated key package reference */
  keyPackageRef: Uint8Array;
  /** The public key package */
  publicPackage: KeyPackage;
  /** The private key package — its presence is the discriminant for a local entry */
  privatePackage: PrivateKeyPackage;
  /** Nostr kind-443 events this key package has been published under */
  published?: NostrEvent[];
  /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
  used?: boolean;
};

/**
 * A key package observed on relays for which no private material is held locally.
 *
 * Created by {@link KeyPackageStore.addPublished} when tracking a kind-443 event
 * from another device. Enables cross-device deletion without requiring the
 * private keys to be present. The public key package is always present — events
 * that cannot be decoded are rejected as invalid.
 *
 * Narrow from {@link StoredKeyPackage} by checking `privatePackage === undefined`.
 */
export type TrackedKeyPackage = {
  /** The calculated key package reference */
  keyPackageRef: Uint8Array;
  /** The public key package, decoded from the kind-443 event body */
  publicPackage: KeyPackage;
  /** Always undefined — the discriminant that identifies this as a tracked entry */
  privatePackage?: undefined;
  /** Nostr kind-443 events this key package has been published under */
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

/** Backend interface for the key package store */
export interface KeyPackageStoreBackend extends KeyValueStoreBackend<StoredKeyPackage> {}

/** Options for creating a {@link KeyPackageStore} instance */
export type KeyPackageStoreOptions = {
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
};

type KeyPackageStoreEvents = {
  /** Emitted when a key package is added or first tracked */
  keyPackageAdded: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package is removed */
  keyPackageRemoved: (keyPackageRef: Uint8Array) => void;
  /** Emitted when a key package is updated (publish event added) */
  keyPackageUpdated: (keyPackage: StoredKeyPackage) => void;
};

/**
 * Stores key packages in a {@link KeyPackageStoreBackend}.
 *
 * Two kinds of entries coexist in the same backend:
 * - {@link LocalKeyPackage} — has private material; created by {@link add}
 * - {@link TrackedKeyPackage} — no private material; created by {@link addPublished}
 *   for key packages observed on relays from other devices
 *
 * {@link list} and {@link has} only surface local key packages; use
 * {@link getKeyPackage} to retrieve any entry regardless of type.
 *
 * @example
 * ```typescript
 * const store = new KeyPackageStore(backend);
 *
 * // Add a key package with local private material
 * await store.add({ publicPackage, privatePackage });
 * // List all key packages that have local private material
 * const packages = await store.list();
 * // Get any entry by ref (local or tracked)
 * const entry = await store.getKeyPackage(ref);
 * if (entry?.privatePackage !== undefined) { /* LocalKeyPackage *\/ }
 * // Track a published kind-443 event from another device
 * await store.addPublished(refHex, nostrEvent);
 * ```
 */
export class KeyPackageStore extends EventEmitter<KeyPackageStoreEvents> {
  private backend: KeyPackageStoreBackend;
  private readonly cryptoProvider: CryptoProvider;

  #log = logger.extend("KeyPackageStore");

  /**
   * Creates a new KeyPackageStore instance.
   * @param backend - The storage backend to use (e.g., localForage)
   * @param options - Options for the store
   */
  constructor(
    backend: KeyPackageStoreBackend,
    { cryptoProvider }: KeyPackageStoreOptions = {},
  ) {
    super();
    this.backend = backend;
    this.cryptoProvider = cryptoProvider ?? defaultCryptoProvider;
  }

  /** Resolves a ref/package argument to a hex storage key */
  private async resolveStorageKey(
    hashOrPackage: Uint8Array | string | KeyPackage,
  ): Promise<string> {
    if (typeof hashOrPackage === "string") return hashOrPackage;
    if (hashOrPackage instanceof Uint8Array) return bytesToHex(hashOrPackage);

    return bytesToHex(
      await calculateKeyPackageRef(hashOrPackage, this.cryptoProvider),
    );
  }

  /**
   * Adds a {@link LocalKeyPackage} to the store.
   *
   * Use this for locally-generated key packages where the private material is
   * available. For foreign-device publish tracking use {@link addPublished}.
   *
   * @param keyPackage - Must include `publicPackage` and `privatePackage`.
   *   `keyPackageRef` is computed automatically.
   * @returns The storage key (hex ref string)
   */
  async add(
    keyPackage: Pick<LocalKeyPackage, "publicPackage" | "privatePackage"> &
      Partial<Pick<LocalKeyPackage, "published">>,
  ): Promise<string> {
    const key = await this.resolveStorageKey(keyPackage.publicPackage);

    const keyPackageRef = await calculateKeyPackageRef(
      keyPackage.publicPackage,
      this.cryptoProvider,
    );

    const entry: LocalKeyPackage = {
      keyPackageRef,
      publicPackage: keyPackage.publicPackage,
      privatePackage: keyPackage.privatePackage,
      ...(keyPackage.published !== undefined
        ? { published: keyPackage.published }
        : {}),
    };

    await this.backend.setItem(key, entry);
    this.emit("keyPackageAdded", entry);
    this.#log(
      "added %s" + (entry.privatePackage ? " with private key" : ""),
      key,
    );

    return key;
  }

  /**
   * Appends a kind-443 Nostr event to the `published` list of the key package
   * identified by `ref`. If no entry exists yet, a {@link TrackedKeyPackage} is
   * created by decoding the public key package from the event body.
   *
   * Throws if the event body cannot be decoded as a valid key package — callers
   * should validate events before calling this method (or use
   * {@link KeyPackageManager.track} which catches decode errors automatically).
   *
   * @param ref - The key package reference hex string (from the event's `i` tag)
   * @param event - The signed kind-443 Nostr event to record
   * @throws If no entry exists and the event body cannot be decoded as a KeyPackage
   */
  async addPublished(
    ref: string | Uint8Array,
    event: NostrEvent,
  ): Promise<void> {
    const key = typeof ref === "string" ? ref : bytesToHex(ref);
    const existing = await this.backend.getItem(key);

    if (existing) {
      // Skip if event is already in array
      if (existing.published?.some((e) => e.id === event.id)) return;

      const updated: StoredKeyPackage = {
        ...existing,
        published: [...(existing.published ?? []), event],
      };

      await this.backend.setItem(key, updated);
      this.emit("keyPackageUpdated", updated);
      this.#log("stored published event %s for %s", event.id, ref);
    } else {
      // No local entry — decode the public key package from the event body.
      // Throws if the event content is not a valid encoded KeyPackage.
      const publicPackage = getKeyPackage(event);

      const keyPackageRef = await calculateKeyPackageRef(
        publicPackage,
        this.cryptoProvider,
      );

      const entry: TrackedKeyPackage = {
        keyPackageRef,
        publicPackage,
        published: [event],
      };

      await this.backend.setItem(key, entry);
      this.emit("keyPackageAdded", entry);
      this.#log("added key package from event %s", event.id);
    }
  }

  /**
   * Retrieves only the public key package from the store.
   *
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   * @returns The public key package, or null if not found
   */
  async getPublicKey(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<KeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    return stored?.publicPackage ?? null;
  }

  /**
   * Retrieves only the private key package from the store.
   *
   * Returns null for {@link TrackedKeyPackage} entries (no private material).
   * Be cautious about keeping private keys in memory longer than necessary.
   *
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   * @returns The private key package, or null if not found or if the entry is tracked-only
   */
  async getPrivateKey(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<PrivateKeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    return stored?.privatePackage ?? null;
  }

  /**
   * Retrieves the stored key package entry from the store.
   *
   * Returns any entry regardless of whether it has private material.
   * Check `privatePackage !== undefined` to narrow to a {@link LocalKeyPackage}.
   *
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   * @returns The stored entry, or null if not found
   */
  async getKeyPackage(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<StoredKeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    return this.backend.getItem(key);
  }

  /**
   * Removes a key package from the store (local or tracked).
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   */
  async remove(ref: Uint8Array | string | KeyPackage): Promise<void> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    await this.backend.removeItem(key);

    if (stored) {
      this.emit("keyPackageRemoved", stored.keyPackageRef);
      this.#log("removed key package %s", key);
    }
  }

  /**
   * Lists all {@link LocalKeyPackage} entries (those with private material),
   * without the private package itself.
   *
   * {@link TrackedKeyPackage} entries are excluded — use {@link getKeyPackage}
   * to retrieve a specific tracked entry by ref.
   */
  async list(): Promise<ListedKeyPackage[]> {
    const allKeys = await this.backend.keys();

    const packages = await Promise.all(
      allKeys.map((key) => this.backend.getItem(key)),
    );

    return packages
      .filter(
        (pkg): pkg is LocalKeyPackage =>
          pkg !== null && pkg.privatePackage !== undefined,
      )
      .map(({ keyPackageRef, publicPackage, published, used }) => ({
        keyPackageRef,
        publicPackage,
        ...(published !== undefined ? { published } : {}),
        ...(used !== undefined ? { used } : {}),
      }));
  }

  /** Gets the count of {@link LocalKeyPackage} entries (those with private material). */
  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** Clears all entries (local and tracked) from the store. */
  async clear(): Promise<void> {
    const allKeys = await this.backend.keys();
    for (const key of allKeys) {
      const stored = await this.backend.getItem(key);
      await this.backend.removeItem(key);
      if (stored) {
        this.emit("keyPackageRemoved", stored.keyPackageRef);
      }
    }
  }

  /**
   * Returns `true` only if a {@link LocalKeyPackage} (with private material)
   * exists for the given ref. Returns `false` for {@link TrackedKeyPackage} entries.
   *
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   */
  async has(ref: Uint8Array | string | KeyPackage): Promise<boolean> {
    const key = await this.resolveStorageKey(ref);
    const item = await this.backend.getItem(key);
    return item !== null && item.privatePackage !== undefined;
  }

  /**
   * Marks a stored key package as used by setting `used = true` and persisting the update.
   *
   * Emits `keyPackageUpdated`. This flag allows applications to distinguish consumed
   * key packages (e.g. used to join a group) from fresh ones, and to periodically
   * rotate or clean up used packages.
   *
   * Does nothing if no entry exists for the given ref.
   *
   * @param ref - The key package reference (as Uint8Array, hex string, or KeyPackage)
   */
  async markUsed(ref: Uint8Array | string | KeyPackage): Promise<void> {
    const key = await this.resolveStorageKey(ref);
    const existing = await this.backend.getItem(key);
    if (!existing) return;

    const updated: StoredKeyPackage = { ...existing, used: true };
    await this.backend.setItem(key, updated);
    this.emit("keyPackageUpdated", updated);
    this.#log("marked key package %s as used", key);
  }
}
