import { bytesToHex } from "@noble/hashes/utils.js";
import { CryptoProvider, defaultCryptoProvider } from "ts-mls";
import {
  KeyPackage,
  PrivateKeyPackage,
  decodeKeyPackage,
} from "ts-mls/keyPackage.js";
import { calculateKeyPackageRef } from "../core/key-package.js";
import { KeyValueStoreBackend } from "../utils/key-value.js";

export type StoredKeyPackage = {
  /** The calculated key package reference (should be used to identify the key package) */
  keyPackageRef: Uint8Array;
  /** TLS bytes of the public KeyPackage (portable across backends) */
  keyPackageTls: Uint8Array;
  /** The private key package */
  privatePackage: PrivateKeyPackage;
};

/** A type for listing the key package without the private package */
export type ListedKeyPackage = Omit<StoredKeyPackage, "privatePackage">;

/** A generic interface for a key-value store */
export interface KeyPackageStoreBackend extends KeyValueStoreBackend<StoredKeyPackage> {}

/** Options for creating a {@link KeyPackageStore} instance */
export type KeyPackageStoreOptions = {
  prefix?: string;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** Optional callback invoked when a key package is added/updated */
  onUpdate?: (key?: string) => void;
};

/**
 * Stores key packages in a {@link KeyPackageStoreBackend}.
 *
 * This class provides a simple interface for managing complete key packages, including their private components.
 * It's designed to work with any backend that implements the {@link KeyPackageStoreBackend} interface.
 *
 * @example
 * ```typescript
 * const store = new KeyPackageStore(backend);
 *
 * // Add a complete key package
 * await store.add({ publicPackage, privatePackage });
 * // List all key packages
 * const packages = await store.list();
 * // Get a specific key package by its publicKey
 * const publicPackage = await store.getPublicKey(publicKey);
 * const privatePackage = await store.getPrivateKey(publicKey);
 * // Remove a key package
 * await store.remove(publicPackage);
 * ```
 */
export class KeyPackageStore {
  private backend: KeyPackageStoreBackend;
  private readonly cryptoProvider: CryptoProvider;
  private readonly prefix?: string;
  private readonly onUpdate?: (key?: string) => void;

  /**
   * Creates a new KeyPackageStore instance.
   * @param backend - The storage backend to use (e.g., localForage)
   * @param hash - The hash implementation to use (defaults to SHA-256)
   * @param prefix - Optional prefix to add to all storage keys (useful for namespacing)
   */
  constructor(
    backend: KeyPackageStoreBackend,
    { prefix, onUpdate, cryptoProvider }: KeyPackageStoreOptions = {},
  ) {
    this.backend = backend;
    this.cryptoProvider = cryptoProvider ?? defaultCryptoProvider;
    this.prefix = prefix;
    this.onUpdate = onUpdate;
  }

  /**
   * Resolves the storage key from various input types.
   * @param hashOrPackage - The hash or key package to resolve
   */
  private async resolveStorageKey(
    hashOrPackage: Uint8Array | string | KeyPackage,
  ): Promise<string> {
    let key: string;
    if (typeof hashOrPackage === "string") {
      // Already a hex string, add prefix
      key = hashOrPackage;
    } else if (hashOrPackage instanceof Uint8Array) {
      // Convert Uint8Array to hex and add prefix
      key = bytesToHex(hashOrPackage);
    } else {
      // Calculate the key package reference from the public package
      key = bytesToHex(
        await calculateKeyPackageRef(hashOrPackage, this.cryptoProvider),
      );
    }

    return (this.prefix ?? "") + key;
  }

  /** Ensures that a stored key package object has a key package reference */
  private async ensureKeyPackageRef<T extends { keyPackageTls: Uint8Array }>(
    keyPackage: T,
  ): Promise<T & { keyPackageRef: Uint8Array }> {
    // Skip calculation if the key package reference is already present
    if (
      "keyPackageRef" in keyPackage &&
      keyPackage.keyPackageRef instanceof Uint8Array
    )
      return keyPackage as T & { keyPackageRef: Uint8Array };

    const decoded = decodeKeyPackage(keyPackage.keyPackageTls, 0);
    if (!decoded) throw new Error("Failed to decode stored key package");
    const [publicPackage] = decoded;

    return {
      ...keyPackage,
      keyPackageRef: await calculateKeyPackageRef(
        publicPackage,
        this.cryptoProvider,
      ),
    };
  }

  /**
   * Adds a complete key package to the store.
   *
   * @param keyPackage - The complete key package containing both public and private components
   * @returns A promise that resolves to the storage key used
   *
   * @example
   * ```typescript
   * const keyPackage = await marmot.createKeyPackage(credential);
   * const key = await store.add(keyPackage);
   * console.log(`Stored key package with key: ${key}`);
   * ```
   */
  async add(
    keyPackage: Omit<StoredKeyPackage, "keyPackageRef">,
  ): Promise<string> {
    const decoded = decodeKeyPackage(keyPackage.keyPackageTls, 0);
    if (!decoded) throw new Error("Failed to decode key package");
    const [publicPackage] = decoded;

    const key = await this.resolveStorageKey(publicPackage);

    // Serialize the key package for storage
    const serialized = {
      keyPackageRef: await calculateKeyPackageRef(
        publicPackage,
        this.cryptoProvider,
      ),
      keyPackageTls: keyPackage.keyPackageTls,
      privatePackage: keyPackage.privatePackage,
    };

    await this.backend.setItem(key, serialized);

    // Notify about the change if callback provided
    this.onUpdate?.(key);

    return key;
  }

  /**
   * Retrieves only the public key package from the store.
   *
   * This method is useful when you only need the public component and want to avoid
   * loading the private key into memory.
   *
   * @param ref - The key package reference (as Uint8Array or hex string) or the public key package
   * @returns A promise that resolves to the public key package, or null if not found
   */
  async getPublicKey(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<KeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    if (!stored) return null;
    const decoded = decodeKeyPackage(stored.keyPackageTls, 0);
    if (!decoded) throw new Error("Failed to decode stored key package");
    return decoded[0];
  }

  /**
   * Retrieves only the private key package from the store.
   *
   * Use this method when you need access to the private keys for cryptographic operations.
   * Be cautious about keeping private keys in memory longer than necessary.
   *
   * @param ref - The key package reference (as Uint8Array or hex string) or the public key package
   */
  async getPrivateKey(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<PrivateKeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    return stored ? stored.privatePackage : null;
  }

  /**
   * Retrieves the complete key package (both public and private) from the store.
   *
   * @param ref - The key package reference (as Uint8Array or hex string) or the public key package
   * @returns A promise that resolves to the complete key package, or null if not found
   */
  async getKeyPackage(
    ref: Uint8Array | string | KeyPackage,
  ): Promise<StoredKeyPackage | null> {
    const key = await this.resolveStorageKey(ref);
    const stored = await this.backend.getItem(key);
    return stored && (await this.ensureKeyPackageRef(stored));
  }

  /**
   * Removes a key package from the store.
   * @param ref - The key package reference (as Uint8Array or hex string) or the public key package
   */
  async remove(ref: Uint8Array | string | KeyPackage): Promise<void> {
    const key = await this.resolveStorageKey(ref);
    await this.backend.removeItem(key);

    // Notify about the change if callback provided
    this.onUpdate?.(key);
  }

  /**
   * Lists all public key packages stored in the store.
   * @returns An array of public key packages
   */
  async list(): Promise<ListedKeyPackage[]> {
    const allKeys = await this.backend.keys();

    // Filter keys by prefix
    const keys = this.prefix
      ? allKeys.filter((key) => key.startsWith(this.prefix!))
      : allKeys;

    const packages = await Promise.all(
      keys.map((key) =>
        this.backend
          .getItem(key)
          .then((pkg) => pkg && this.ensureKeyPackageRef(pkg)),
      ),
    );

    // Filter out null values and validate that items are CompleteKeyPackages
    return packages
      .filter((pkg) => pkg !== null)
      .map((pkg) => ({
        // NOTE: Explicicly omit the private key package here since in most cases clients will not need it for listing stored key packages
        keyPackageRef: pkg.keyPackageRef,
        keyPackageTls: pkg.keyPackageTls,
      }));
  }

  /** Gets the count of key packages stored. */
  async count(): Promise<number> {
    const packages = await this.list();
    return packages.length;
  }

  /** Clears all key packages from the store (only those matching the prefix if one is set). */
  async clear(): Promise<void> {
    if (this.prefix) {
      // Only clear keys with this prefix
      const allKeys = await this.backend.keys();
      const keysToRemove = allKeys.filter((key) =>
        key.startsWith(this.prefix!),
      );
      await Promise.all(
        keysToRemove.map((key) => this.backend.removeItem(key)),
      );
    } else {
      // Clear all keys
      await this.backend.clear();
    }

    // Notify about the change if callback provided
    if (this.onUpdate) {
      this.onUpdate();
    }
  }

  /**
   * Checks if a key package exists in the store.
   * @param ref - The key package reference (as Uint8Array or hex string) or the public key package
   */
  async has(ref: Uint8Array | string | KeyPackage): Promise<boolean> {
    const key = await this.resolveStorageKey(ref);
    const item = await this.backend.getItem(key);
    return item !== null;
  }
}
