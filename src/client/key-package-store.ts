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

import { validateKeyPackageAccountIdentityProof } from "../core/components/account-identity-proof.js";
import {
  getKeyPackage,
  getKeyPackageIdentifier,
} from "../core/key-package-event.js";
import {
  calculateKeyPackageRef,
  isReusableKeyPackage,
} from "../core/key-package.js";
import { validateKeyPackageSlot } from "../core/key-package-event-encode.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { logger } from "../utils/debug.js";
import { RecordStore } from "../utils/record-codec.js";
import type { MarmotStorage } from "../utils/storage.js";
import { KEY_PACKAGE_PREFIX } from "./storage-keys.js";
import { deduplicatePublishedEvents } from "./key-package-events.js";

/** Local transport destinations, never derived from signed event tags. */
export function normalizeKeyPackageRelays(relays: readonly string[]): string[] {
  return [...new Set(relays.filter(isValidRelayUrl).map(normalizeRelayUrl))];
}

// ---------------------------------------------------------------------------
// Stored entry types
// ---------------------------------------------------------------------------

/** Durable intent; never contains another copy of secret material. */
export type KeyPackageConsumptionReceipt = {
  groupId: Uint8Array;
  keyPackageRef: Uint8Array;
};

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
  /** Normalized local publication/observation destinations. Older entries omit this field. */
  publicationRelays?: string[];
  /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
  used?: boolean;
  consumptionReceipts?: KeyPackageConsumptionReceipt[];
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
  /** Normalized local publication/observation destinations. Older entries omit this field. */
  publicationRelays?: string[];
  /** Whether this key package has been consumed (e.g. used to join a group). Undefined means unused. */
  used?: boolean;
  consumptionReceipts?: KeyPackageConsumptionReceipt[];
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

/**
 * A {@link LocalKeyPackage} without the private material, safe to expose in listings.
 *
 * `nonCurrent` is `true` when the stored KeyPackage lacks a valid current account identity
 * proof (`0x8009`) — for example a package built by a pre-v2 release with the legacy proof
 * extension. {@link KeyPackageManager.ensurePublished} does not pick such packages when
 * deciding whether a current one is already published, but the flag is informational
 * everywhere else: `selectForWelcome` still returns them as Welcome candidates, and
 * `rotate()`, `remove()`, `clear()`, and `purge()` act on them like any other entry. They are
 * never removed automatically, and their kind-30443 events stay discoverable on relays (so
 * peers' invites that pick them will fail) until `purge()` publishes a NIP-09 deletion.
 */
export type ListedKeyPackage = Omit<StoredKeyPackage, "privatePackage"> & {
  nonCurrent?: boolean;
};

/**
 * A locally-held key package selected as a candidate for joining from a
 * specific Welcome message. Produced by `KeyPackageManager.selectForWelcome`
 * and consumed by `GroupsManager.joinFromWelcome`.
 */
export type WelcomeKeyPackageCandidate = {
  /** The public key package to hand to `joinGroup`. */
  publicPackage: KeyPackage;
  /** The matching local private material. */
  privatePackage: PrivateKeyPackage;
  /** The RFC 9420 KeyPackageRef of this package. */
  keyPackageRef: Uint8Array;
  /** Whether this package's ref matches an encrypted secret in the Welcome. */
  hasMatchingSecret: boolean;
};

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
  readonly #store: RecordStore<StoredKeyPackage>;
  readonly #cryptoProvider: CryptoProvider;
  #log = logger.extend("KeyPackageStore");

  constructor(
    storage: MarmotStorage,
    cryptoProvider: CryptoProvider = defaultCryptoProvider,
  ) {
    super();
    this.#store = new RecordStore<StoredKeyPackage>(
      storage,
      KEY_PACKAGE_PREFIX,
    );
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
      Partial<
        Pick<LocalKeyPackage, "published" | "identifier" | "publicationRelays">
      >,
  ): Promise<string> {
    if (keyPackage.identifier !== undefined)
      validateKeyPackageSlot(keyPackage.identifier);
    const keyPackageRef = await calculateKeyPackageRef(
      keyPackage.publicPackage,
      this.#cryptoProvider,
    );
    const key = bytesToHex(keyPackageRef);

    const entry: LocalKeyPackage = {
      keyPackageRef,
      publicPackage: keyPackage.publicPackage,
      privatePackage: keyPackage.privatePackage,
      ...(keyPackage.publicationRelays !== undefined
        ? {
            publicationRelays: normalizeKeyPackageRelays(
              keyPackage.publicationRelays,
            ),
          }
        : {}),
      ...(keyPackage.identifier !== undefined
        ? { identifier: keyPackage.identifier }
        : {}),
      ...(keyPackage.published !== undefined
        ? { published: deduplicatePublishedEvents(keyPackage.published) }
        : {}),
    };

    await this.#store.set(key, entry);
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
   * Throws if the event body cannot be decoded as a valid key package, or if
   * the event's `i` tag (KeyPackageRef) does not match the decoded body.
   */
  async addPublished(
    ref: string | Uint8Array,
    event: NostrEvent,
    relays: readonly string[] = [],
  ): Promise<void> {
    const key = this.#resolveKey(ref);
    const identifier = getKeyPackageIdentifier(event);
    if (identifier === undefined)
      throw new Error("KeyPackage publication requires a valid slot");
    validateKeyPackageSlot(identifier);

    // The `i` tag IS the KeyPackageRef of the event body. Receivers MUST
    // verify it against the decoded KeyPackage and reject on mismatch
    // (transports/nostr.md §KeyPackage publication) so a forged `i` tag cannot
    // make us index a package under a ref that is not its own. Decoding here
    // also throws if the body is not a valid KeyPackage. This is the single
    // chokepoint for both tracked (untrusted) and self-published events.
    const publicPackage = getKeyPackage(event);
    isReusableKeyPackage(publicPackage);
    const computedRefBytes = await calculateKeyPackageRef(
      publicPackage,
      this.#cryptoProvider,
    );
    const computedRef = bytesToHex(computedRefBytes);
    if (computedRef !== key.toLowerCase()) {
      throw new Error(
        `KeyPackage event ${event.id} carries i tag ${key} but its body's KeyPackageRef is ${computedRef}`,
      );
    }

    const existing = await this.#store.get(key);

    if (existing) {
      const publicationRelays = normalizeKeyPackageRelays([
        ...(existing.publicationRelays ?? []),
        ...relays,
      ]);
      const routesChanged =
        publicationRelays.length !==
          (existing.publicationRelays?.length ?? 0) ||
        publicationRelays.some(
          (relay, index) => relay !== existing.publicationRelays?.[index],
        );
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

      if (!publishedChanged && !shouldPersistIdentifier && !routesChanged) {
        return;
      }

      const updated: StoredKeyPackage = {
        ...existing,
        // Persist identifier if discovered for the first time on this entry
        ...(shouldPersistIdentifier ? { identifier } : {}),
        published,
        publicationRelays,
      };

      await this.#store.set(key, updated);
      this.emit("updated", updated);
      this.#log("stored published event %s for %s", event.id, ref);
    } else {
      // No local entry — record the package decoded and ref-verified above.
      const entry: TrackedKeyPackage = {
        keyPackageRef: computedRefBytes,
        publicPackage,
        ...(identifier !== undefined ? { identifier } : {}),
        published: [event],
        publicationRelays: normalizeKeyPackageRelays(relays),
      };

      await this.#store.set(key, entry);
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
    return (await this.#store.get(key)) ?? null;
  }

  /**
   * Removes a key package from the backend.
   */
  async remove(ref: Uint8Array | string): Promise<void> {
    const key = this.#resolveKey(ref);
    const stored = await this.#store.get(key);
    await this.#store.delete(key);

    if (stored) {
      this.emit("removed", stored.keyPackageRef);
      this.#log("removed key package %s", key);
    }
  }

  /**
   * Lists all {@link LocalKeyPackage} entries (those with private material),
   * without the private package itself.
   *
   * Classifies each entry's `nonCurrent` flag by running
   * `validateKeyPackageAccountIdentityProof` against its `publicPackage` — one BIP-340
   * verify per stored package.
   */
  async list(): Promise<ListedKeyPackage[]> {
    const allKeys = await this.#store.ids();

    const packages = await Promise.all(
      allKeys.map((key) => this.#store.get(key)),
    );

    return packages
      .filter(
        (pkg): pkg is LocalKeyPackage =>
          pkg !== undefined && pkg.privatePackage !== undefined,
      )
      .map(
        ({
          keyPackageRef,
          publicPackage,
          identifier,
          published,
          used,
          publicationRelays,
        }) => {
          let nonCurrent = false;
          try {
            validateKeyPackageAccountIdentityProof(publicPackage);
          } catch {
            nonCurrent = true;
          }

          return {
            keyPackageRef,
            publicPackage,
            ...(identifier !== undefined ? { identifier } : {}),
            ...(published !== undefined ? { published } : {}),
            ...(publicationRelays !== undefined
              ? {
                  publicationRelays:
                    normalizeKeyPackageRelays(publicationRelays),
                }
              : {}),
            ...(used !== undefined ? { used } : {}),
            ...(nonCurrent ? { nonCurrent: true as const } : {}),
          };
        },
      );
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
    const item = await this.#store.get(key);
    return item !== undefined && item.privatePackage !== undefined;
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
    const stored = await this.#store.get(key);
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
    const existing = await this.#store.get(key);
    if (!existing) return;

    const updated: StoredKeyPackage = { ...existing, used: true };
    await this.#store.set(key, updated);
    this.emit("updated", updated);
    this.#log("marked key package %s as used", key);
  }

  /** Records validated intent before adoption, without altering private material. */
  async recordConsumption(groupId: Uint8Array, ref: Uint8Array): Promise<void> {
    const key = this.#resolveKey(ref);
    const existing = await this.#store.get(key);
    // Direct GroupsManager users can supply external candidates without a local entry.
    if (!existing) return;
    const receipts = existing.consumptionReceipts ?? [];
    if (
      receipts.some(
        (receipt) => bytesToHex(receipt.groupId) === bytesToHex(groupId),
      )
    )
      return;
    await this.#store.set(key, {
      ...existing,
      consumptionReceipts: [
        ...receipts,
        { groupId: groupId.slice(), keyPackageRef: ref.slice() },
      ],
    });
  }

  /**
   * Separate stores are not atomic: a crash may delay retirement until recovery.
   * Pre-adoption receipts remain harmless until their group actually exists.
   */
  async finalizeConsumptions(
    hasAdoptedGroup: (groupId: Uint8Array) => Promise<boolean>,
  ): Promise<void> {
    for (const key of await this.#store.ids()) {
      const entry = await this.#store.get(key);
      if (!entry?.consumptionReceipts?.length) continue;
      let adopted = false;
      const remaining: KeyPackageConsumptionReceipt[] = [];
      for (const receipt of entry.consumptionReceipts) {
        if (bytesToHex(receipt.keyPackageRef) !== key)
          throw new Error("Consumption receipt KeyPackageRef mismatch");
        if (await hasAdoptedGroup(receipt.groupId)) adopted = true;
        else remaining.push(receipt);
      }
      if (!adopted) continue;
      const {
        privatePackage,
        consumptionReceipts: _receipts,
        ...publicMetadata
      } = entry;
      const retired: StoredKeyPackage = isReusableKeyPackage(
        entry.publicPackage,
      )
        ? { ...entry, used: true }
        : { ...publicMetadata, used: true };
      // Persist retirement before clearing the receipt, making retries idempotent.
      await this.#store.set(key, {
        ...retired,
        consumptionReceipts: entry.consumptionReceipts,
      });
      const { consumptionReceipts: _completed, ...finished } = retired;
      const updated = remaining.length
        ? { ...finished, consumptionReceipts: remaining }
        : finished;
      await this.#store.set(key, updated);
      this.emit("updated", updated);
      // Never zero privatePackage: adopted MLS state can alias its arrays.
      void privatePackage;
    }
  }

  /** Clears all entries (local and tracked) from the store. */
  async clear(): Promise<void> {
    const allKeys = await this.#store.ids();
    for (const key of allKeys) {
      const stored = await this.#store.get(key);
      await this.#store.delete(key);
      if (stored) {
        this.emit("removed", stored.keyPackageRef);
      }
    }
  }
}
