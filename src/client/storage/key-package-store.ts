/** @module @category Client - Key Package Manager */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import {
  CryptoProvider,
  decode,
  defaultCryptoProvider,
  encode,
  KeyPackage,
  keyPackageDecoder,
  keyPackageEncoder,
  PrivateKeyPackage,
  privateKeyPackageDecoder,
  privateKeyPackageEncoder,
} from "ts-mls";

import { validateKeyPackageAccountIdentityProof } from "../../core/components/account-identity-proof.js";
import {
  getKeyPackage,
  getKeyPackageIdentifier,
} from "../../core/key-package-event.js";
import {
  calculateKeyPackageRef,
  isReusableKeyPackage,
} from "../../core/key-package.js";
import { validateKeyPackageSlot } from "../../core/key-package-event-encode.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../../utils/relay-url.js";
import { logger } from "../../utils/debug.js";
import type { KeyPackageRow, MarmotAccountDatabase } from "./database/types.js";

/**
 * Computes the replaceable-event coordinate (`kind:pubkey:d`) for a kind-30443
 * key package event, or `undefined` when the event carries no slot identifier.
 */
function getReplaceableEventKey(event: NostrEvent): string | undefined {
  const identifier = getKeyPackageIdentifier(event);
  if (identifier === undefined) return undefined;

  return `${event.kind}:${event.pubkey}:${identifier}`;
}

/**
 * Deduplicates a list of published kind-30443 events.
 *
 * Drops exact duplicate event ids, then collapses replaceable events that share
 * the same `kind:pubkey:d` coordinate down to the newest by `created_at`.
 * Non-addressable events (no slot identifier) are kept as-is.
 */
function deduplicatePublishedEvents(events: NostrEvent[]): NostrEvent[] {
  const seenIds = new Set<string>();
  const replaceableIndexes = new Map<string, number>();
  const deduplicated: NostrEvent[] = [];

  for (const event of events) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    const replaceableKey = getReplaceableEventKey(event);
    if (replaceableKey === undefined) {
      deduplicated.push(event);
      continue;
    }

    const existingIndex = replaceableIndexes.get(replaceableKey);
    if (existingIndex === undefined) {
      replaceableIndexes.set(replaceableKey, deduplicated.length);
      deduplicated.push(event);
      continue;
    }

    const existing = deduplicated[existingIndex];
    if (event.created_at > existing.created_at) {
      deduplicated[existingIndex] = event;
    }
  }

  return deduplicated;
}

/** Local transport destinations, never derived from signed event tags. */
export function normalizeKeyPackageRelays(relays: readonly string[]): string[] {
  return [...new Set(relays.filter(isValidRelayUrl).map(normalizeRelayUrl))];
}

/** Maps a stored entry to its account-database row. */
function keyPackageRow(ref: string, entry: StoredKeyPackage): KeyPackageRow {
  return {
    ref,
    publicPackage: encode(keyPackageEncoder, entry.publicPackage),
    ...(entry.privatePackage !== undefined
      ? {
          privatePackage: encode(
            privateKeyPackageEncoder,
            entry.privatePackage,
          ),
        }
      : {}),
    ...(entry.identifier !== undefined ? { identifier: entry.identifier } : {}),
    notBefore: Number(entry.publicPackage.leafNode.lifetime?.notBefore ?? 0n),
    used: entry.used === true,
    published: entry.published ?? [],
    ...(entry.publicationRelays !== undefined
      ? { relays: entry.publicationRelays }
      : {}),
    consumptionReceipts: (entry.consumptionReceipts ?? []).map((receipt) => ({
      groupId: bytesToHex(receipt.groupId),
      keyPackageRef: bytesToHex(receipt.keyPackageRef),
      ...(receipt.adoptionTag !== undefined
        ? { adoptionTag: receipt.adoptionTag }
        : {}),
    })),
  };
}

/** Decodes an account-database row. Throws when its MLS objects are corrupt. */
function storedKeyPackage(row: KeyPackageRow): StoredKeyPackage {
  const publicPackage = decode(keyPackageDecoder, row.publicPackage);
  if (!publicPackage)
    throw new Error(`Stored key package ${row.ref} has a corrupt KeyPackage`);
  let privatePackage: PrivateKeyPackage | undefined;
  if (row.privatePackage !== undefined) {
    privatePackage = decode(privateKeyPackageDecoder, row.privatePackage);
    if (!privatePackage)
      throw new Error(
        `Stored key package ${row.ref} has a corrupt private key package`,
      );
  }
  return {
    keyPackageRef: hexToBytes(row.ref),
    publicPackage,
    ...(privatePackage !== undefined ? { privatePackage } : {}),
    ...(row.identifier !== undefined ? { identifier: row.identifier } : {}),
    ...(row.published.length ? { published: row.published } : {}),
    ...(row.relays !== undefined ? { publicationRelays: row.relays } : {}),
    ...(row.used ? { used: true } : {}),
    ...(row.consumptionReceipts.length
      ? {
          consumptionReceipts: row.consumptionReceipts.map((receipt) => ({
            groupId: hexToBytes(receipt.groupId),
            keyPackageRef: hexToBytes(receipt.keyPackageRef),
            ...(receipt.adoptionTag !== undefined
              ? { adoptionTag: receipt.adoptionTag }
              : {}),
          })),
        }
      : {}),
  } as StoredKeyPackage;
}

// ---------------------------------------------------------------------------
// Stored entry types
// ---------------------------------------------------------------------------

/** Durable intent; never contains another copy of secret material. */
export type KeyPackageConsumptionReceipt = {
  groupId: Uint8Array;
  keyPackageRef: Uint8Array;
  /** Hex confirmation tag identifying this Welcome adoption, if known. */
  adoptionTag?: string;
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
  readonly #database: MarmotAccountDatabase;
  readonly #cryptoProvider: CryptoProvider;
  #log = logger.extend("KeyPackageStore");

  constructor(
    database: MarmotAccountDatabase,
    cryptoProvider: CryptoProvider = defaultCryptoProvider,
  ) {
    super();
    this.#database = database;
    this.#cryptoProvider = cryptoProvider;
  }

  /** Reads and decodes one stored entry. */
  async #get(key: string): Promise<StoredKeyPackage | undefined> {
    const row = await this.#database.keyPackages.get(key);
    return row && storedKeyPackage(row);
  }

  /** Encodes and writes one entry. */
  async #set(key: string, entry: StoredKeyPackage): Promise<void> {
    const row = keyPackageRow(key, entry);
    await this.#database.transaction((tx) => tx.keyPackages.put(row));
  }

  async #delete(key: string): Promise<void> {
    await this.#database.transaction((tx) => tx.keyPackages.delete(key));
  }

  /** Every stored ref, sorted. */
  async #ids(): Promise<string[]> {
    return (await this.#database.keyPackages.all())
      .map((row) => row.ref)
      .sort();
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

    await this.#set(key, entry);
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

    const existing = await this.#get(key);

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

      await this.#set(key, updated);
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

      await this.#set(key, entry);
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
    return (await this.#get(key)) ?? null;
  }

  /**
   * Removes a key package from the backend.
   */
  async remove(ref: Uint8Array | string): Promise<void> {
    const key = this.#resolveKey(ref);
    const stored = await this.#get(key);
    await this.#delete(key);

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
    const allKeys = await this.#ids();

    const packages = await Promise.all(allKeys.map((key) => this.#get(key)));

    // Oldest first (signed lifetime start), so selection is deterministic and
    // independent of the storage adapter's key order.
    const notBefore = (pkg: LocalKeyPackage) =>
      pkg.publicPackage.leafNode.lifetime?.notBefore ?? 0n;
    return packages
      .filter(
        (pkg): pkg is LocalKeyPackage =>
          pkg !== undefined && pkg.privatePackage !== undefined,
      )
      .sort((a, b) => {
        const order = notBefore(a) - notBefore(b);
        if (order !== 0n) return order < 0n ? -1 : 1;
        return bytesToHex(a.keyPackageRef).localeCompare(
          bytesToHex(b.keyPackageRef),
        );
      })
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
   * Lists all local key packages, oldest first, with their published events defaulted to an
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
    const item = await this.#get(key);
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
    const stored = await this.#get(key);
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
    const existing = await this.#get(key);
    if (!existing) return;

    const updated: StoredKeyPackage = { ...existing, used: true };
    await this.#set(key, updated);
    this.emit("updated", updated);
    this.#log("marked key package %s as used", key);
  }

  /** Records validated intent before adoption, without altering private material. */
  async recordConsumption(
    groupId: Uint8Array,
    ref: Uint8Array,
    adoptionTag?: string,
  ): Promise<void> {
    const key = this.#resolveKey(ref);
    const existing = await this.#get(key);
    // Direct GroupsManager users can supply external candidates without a local entry.
    if (!existing) return;
    const receipts = existing.consumptionReceipts ?? [];
    if (
      receipts.some(
        (receipt) =>
          bytesToHex(receipt.groupId) === bytesToHex(groupId) &&
          receipt.adoptionTag === adoptionTag,
      )
    )
      return;
    await this.#set(key, {
      ...existing,
      consumptionReceipts: [
        ...receipts,
        {
          groupId: groupId.slice(),
          keyPackageRef: ref.slice(),
          ...(adoptionTag !== undefined ? { adoptionTag } : {}),
        },
      ],
    });
  }

  /**
   * Separate stores are not atomic: a crash may delay retirement until recovery.
   * Tagged receipts require proof of that exact Welcome adoption, not just a group id.
   */
  async finalizeConsumptions(
    hasAdoptedGroup: (
      groupId: Uint8Array,
      adoptionTag?: string,
    ) => Promise<boolean>,
  ): Promise<void> {
    for (const key of await this.#ids()) {
      const entry = await this.#get(key);
      if (!entry?.consumptionReceipts?.length) continue;
      let adopted = false;
      const remaining: KeyPackageConsumptionReceipt[] = [];
      for (const receipt of entry.consumptionReceipts) {
        if (bytesToHex(receipt.keyPackageRef) !== key)
          throw new Error("Consumption receipt KeyPackageRef mismatch");
        if (await hasAdoptedGroup(receipt.groupId, receipt.adoptionTag))
          adopted = true;
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
      await this.#set(key, {
        ...retired,
        consumptionReceipts: entry.consumptionReceipts,
      });
      const { consumptionReceipts: _completed, ...finished } = retired;
      const updated = remaining.length
        ? { ...finished, consumptionReceipts: remaining }
        : finished;
      await this.#set(key, updated);
      this.emit("updated", updated);
      // Never zero privatePackage: adopted MLS state can alias its arrays.
      void privatePackage;
    }
  }

  /** Clears all entries (local and tracked) from the store. */
  async clear(): Promise<void> {
    const allKeys = await this.#ids();
    for (const key of allKeys) {
      const stored = await this.#get(key);
      await this.#delete(key);
      if (stored) {
        this.emit("removed", stored.keyPackageRef);
      }
    }
  }
}
