/** @module @category Client - Key Package Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteName,
  CryptoProvider,
  PrivateKeyPackage,
  Welcome,
} from "ts-mls";

import type { AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import {
  getKeyPackageReference,
  getKeyPackageRelays,
} from "../core/key-package-event.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../core/protocol.js";
import { logger } from "../utils/debug.js";
import { GenericKeyValueStore } from "../utils/key-value.js";
import {
  KeyPackageNotFoundError,
  KeyPackageRotatePreconditionError,
  MissingRelayError,
  MissingSlotIdentifierError,
} from "./key-package-errors.js";
import { KeyPackagePublisher } from "./key-package-publisher.js";
import {
  KeyPackageStore,
  ListedKeyPackage,
  LocalKeyPackage,
  StoredKeyPackage,
  WelcomeKeyPackageCandidate,
} from "./key-package-store.js";
import { NostrNetworkInterface } from "./nostr-interface.js";

// Re-export the storage entry types and errors from their dedicated modules so
// existing imports from this module keep working.
export {
  KeyPackageNotFoundError,
  KeyPackageRotatePreconditionError,
  MissingRelayError,
  MissingSlotIdentifierError,
} from "./key-package-errors.js";
export {
  KeyPackageStore,
  type KeyPackageStoreEvents,
  type ListedKeyPackage,
  type LocalKeyPackage,
  type StoredKeyPackage,
  type TrackedKeyPackage,
  type WelcomeKeyPackageCandidate,
} from "./key-package-store.js";
export {
  KeyPackagePublisher,
  type KeyPackagePublisherOptions,
} from "./key-package-publisher.js";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/** Options for creating a new key package */
export type CreateKeyPackageOptions = {
  /** Relay URLs where the key package event will be published (required) */
  relays: string[];
  /**
   * Addressable slot identifier (`d` tag value) for the kind 30443 event.
   * If omitted, falls back to the manager's `clientId`. Throws
   * {@link MissingSlotIdentifierError} if neither is available.
   */
  identifier?: string;
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
   * stored entry has no `d`, a fresh random value is generated.
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

export type KeyPackageManagerEvents = {
  /** Emitted when a key package is stored locally */
  added: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package is removed from local storage */
  removed: (keyPackageRef: Uint8Array) => void;
  /** Emitted when a key package is updated */
  updated: (keyPackage: StoredKeyPackage) => void;
  /** Emitted when a key package publish is recorded (own publish or observed relay event) */
  published: (refHex: string, eventId: string, relays: string[]) => void;
};

/** Options for creating a new KeyPackageManager */
export type KeyPackageManagerOptions = {
  /** The backend to store and load the key packages from */
  store: GenericKeyValueStore<StoredKeyPackage>;
  /** Default `d` tag value for {@link KeyPackageManager.create} and {@link KeyPackageManager.rotate}. Falls back to this when no explicit `d` is passed. */
  clientId?: string;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /**
   * Optional Nostr-account proof signer. When provided, generated key packages
   * carry a `marmot.account-identity-proof.v2` LeafNode extension binding the
   * account to the leaf signature key (required for darkmatter wire interop).
   * Accepts either a raw-secret-key digest signer (e.g. a PrivateKeyAccount
   * secret key via `signAccountIdentityProof`) or an external Nostr event
   * signer (`{ signEvent }`, e.g. NIP-07/NIP-46/hardware); the applesauce
   * `EventSigner` alone cannot sign the proof.
   */
  accountProofSigner?: AccountIdentityProofSigner;
  /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
};

/**
 * Manages the full lifecycle of MLS key packages — local private material and
 * the Nostr kind-30443 events that advertise this client to potential inviters.
 *
 * A thin coordinator over a {@link KeyPackageStore} (persistence) and a
 * {@link KeyPackagePublisher} (the sign/publish boundary).
 */
export class KeyPackageManager extends EventEmitter<KeyPackageManagerEvents> {
  /**
   * Default slot identifier (`d` tag value) used by {@link create} when no
   * explicit `d` is passed in options. Set this to a stable string (e.g.
   * `"my-app-desktop"`) so all key packages from this manager share a single
   * addressable slot on relays.
   */
  readonly clientId: string | undefined;

  readonly #store: KeyPackageStore;
  readonly #publisher: KeyPackagePublisher;
  #log = logger.extend("KeyPackageManager");

  constructor(options: KeyPackageManagerOptions) {
    super();
    this.clientId = options.clientId;
    this.#store = new KeyPackageStore(options.store, options.cryptoProvider);
    this.#publisher = new KeyPackagePublisher({
      signer: options.signer,
      network: options.network,
      accountProofSigner: options.accountProofSigner,
      cryptoProvider: options.cryptoProvider,
    });

    // Re-emit storage lifecycle events so the manager's public event surface is
    // unchanged by the internal split.
    this.#store.on("added", (keyPackage) => this.emit("added", keyPackage));
    this.#store.on("removed", (ref) => this.emit("removed", ref));
    this.#store.on("updated", (keyPackage) => this.emit("updated", keyPackage));
  }

  // ---------------------------------------------------------------------------
  // Creation and publishing
  // ---------------------------------------------------------------------------

  /**
   * Adds a {@link LocalKeyPackage} to local storage. Delegates to
   * {@link KeyPackageStore.add}.
   *
   * @returns The storage key (hex ref string)
   */
  async add(
    keyPackage: Pick<LocalKeyPackage, "publicPackage" | "privatePackage"> &
      Partial<Pick<LocalKeyPackage, "published" | "identifier">>,
  ): Promise<string> {
    return this.#store.add(keyPackage);
  }

  /**
   * Creates a new key package, stores the private material locally, signs and
   * publishes a kind 30443 addressable event to the specified relays, and
   * records the event.
   *
   * The `d` (slot identifier) is resolved in order:
   * 1. `options.identifier` (explicit)
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

    const identifier = options.identifier ?? this.clientId;
    if (!identifier) {
      throw new MissingSlotIdentifierError();
    }

    this.#log("creating key package on relays: %O", options.relays);

    const keyPackage = await this.#publisher.generate({
      ciphersuite: options.ciphersuite,
      isLastResort: options.isLastResort,
    });

    // Store private material locally, including the slot identifier
    const refHex = await this.#store.add({ ...keyPackage, identifier });

    // Build, sign and publish the kind 30443 event
    const signed = await this.#publisher.publish({
      keyPackage: keyPackage.publicPackage,
      identifier,
      relays: options.relays,
      client: options.client,
      protected: options.protected,
    });

    // Record the published event on the stored entry
    await this.#store.addPublished(refHex, signed);

    const stored = await this.#store.get(refHex);
    if (!stored) throw new Error("Key package not found after store operation");

    this.emit("published", refHex, signed.id, options.relays);
    this.#log(
      "created and published key package %s with slot %s",
      refHex,
      identifier,
    );

    return {
      keyPackageRef: stored.keyPackageRef,
      publicPackage: stored.publicPackage,
      identifier: stored.identifier,
    };
  }

  /**
   * Ensures this client has at least one unused KeyPackage published, so peers
   * can always invite it. A no-op (returning the existing unused KeyPackage)
   * when one already exists; otherwise creates and publishes a fresh one to
   * `options.relays` via {@link create}. Idempotent — safe to call on every
   * startup.
   *
   * @returns The existing unused KeyPackage, or the freshly created one.
   */
  async ensurePublished(
    options: CreateKeyPackageOptions,
  ): Promise<ListedKeyPackage> {
    const existing = await this.list();
    const unused = existing.find((pkg) => !pkg.used);
    if (unused) return unused;
    return this.create(options);
  }

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  /**
   * Rotates a key package: publishes a new kind 30443 event (reusing the same
   * `d` slot so relays replace the old event automatically), then removes the
   * old private key material.
   *
   * Kind-30443 published events do not need explicit deletion — the new event
   * supersedes them on relays.
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

    const existing = await this.#store.get(ref);
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
    // prefer an explicit override, then the stored entry's d (same slot = relay auto-replaces),
    // then generate a fresh random value.
    const newD =
      options?.d ?? existing.identifier ?? this.#publisher.freshIdentifier();

    // Kind-30443 events are superseded automatically by the new event on the
    // relays (same `d` slot), so no explicit NIP-09 deletion is needed.

    // Create and publish the new key package under the resolved slot
    const newPkg = await this.create({
      relays: relaysForNew,
      identifier: newD,
      ciphersuite: options?.ciphersuite,
      isLastResort: options?.isLastResort,
      client: options?.client,
      protected: options?.protected,
    });

    // Remove old private key material (and its published events)
    await this.#store.remove(ref);

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
    await this.#store.remove(ref);
    this.#log("removed key package %s from local store", refHex);
  }

  /**
   * Completely purges one or more key packages: publishes a NIP-09 deletion
   * for all known relay event IDs, removes local private key material, and
   * clears the publish records.
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
      const stored = await this.#store.get(ref);
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
      await this.#publisher.delete(allEvents, [...allRelays]);
    }

    // Remove local private key material for all refs
    for (const ref of refList) {
      await this.#store.remove(ref);
    }
  }

  // ---------------------------------------------------------------------------
  // Publish tracking
  // ---------------------------------------------------------------------------

  /**
   * Observes a Nostr event and, if it is a kind 30443 key package event whose
   * `i` tag (MIP-00 KeyPackageRef) matches its decoded body, records it in the
   * store. Events with no `i` tag, an undecodable body, or an `i` tag that does
   * not match the recomputed ref are rejected.
   *
   * @param event - Any Nostr event; non-key-package events are silently ignored
   * @returns `true` if the event was recorded, `false` if ignored or rejected
   */
  async track(event: NostrEvent): Promise<boolean> {
    if (event.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
      return false;
    }

    const refHex = getKeyPackageReference(event);
    if (!refHex) return false;

    try {
      await this.#store.addPublished(refHex, event);
    } catch {
      // Event body could not be decoded as a KeyPackage — treat as invalid
      return false;
    }

    const relays = getKeyPackageRelays(event) ?? [];
    this.emit("published", refHex, event.id, relays);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Lists all locally stored key packages, each enriched with their published
   * Nostr events.
   */
  async list(): Promise<ListedKeyPackage[]> {
    return this.#store.snapshot();
  }

  /** Returns the number of locally stored key packages. */
  async count(): Promise<number> {
    return this.#store.count();
  }

  /** Checks whether a key package exists in local private key storage. */
  async has(ref: Uint8Array | string): Promise<boolean> {
    return this.#store.has(ref);
  }

  /** Retrieves the full key package from the store. */
  async get(ref: Uint8Array | string): Promise<StoredKeyPackage | null> {
    return this.#store.get(ref);
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
    return this.#store.getPrivateKey(ref);
  }

  /**
   * Selects the locally-held key packages that could receive a given Welcome,
   * ordered with the RFC 9420 KeyPackageRef matches first.
   *
   * Filters to packages whose ciphersuite matches the Welcome and for which
   * local private material is held, computes whether each package's ref matches
   * one of the Welcome's encrypted secrets, and returns the matching packages
   * before the non-matching ones so `GroupsManager.joinFromWelcome` tries the
   * most likely candidate first. This is the TypeScript analog of the private
   * key-bundle lookup the darkmatter engine performs inside `do_join_welcome`.
   *
   * @param welcome - The decoded MLS Welcome message.
   * @returns Candidate key packages in priority order (may be empty).
   */
  async selectForWelcome(
    welcome: Welcome,
  ): Promise<WelcomeKeyPackageCandidate[]> {
    const entries = await this.list();
    const candidates: WelcomeKeyPackageCandidate[] = [];

    for (const entry of entries) {
      if (entry.publicPackage.cipherSuite !== welcome.cipherSuite) continue;

      const privatePackage = await this.getPrivateKey(entry.keyPackageRef);
      if (!privatePackage) continue;

      // RFC 9420 KeyPackageRef matching: does this package's ref equal the
      // `newMember` ref of any encrypted secret in the Welcome?
      const hasMatchingSecret = welcome.secrets.some(
        (secret) =>
          secret.newMember.length === entry.keyPackageRef.length &&
          secret.newMember.every(
            (val, idx) => val === entry.keyPackageRef[idx],
          ),
      );

      candidates.push({
        publicPackage: entry.publicPackage,
        privatePackage,
        keyPackageRef: entry.keyPackageRef,
        hasMatchingSecret,
      });
    }

    // Try packages whose ref matches a Welcome secret first (RFC 9420 compliance).
    return [
      ...candidates.filter((c) => c.hasMatchingSecret),
      ...candidates.filter((c) => !c.hasMatchingSecret),
    ];
  }

  /**
   * Marks a key package as used by setting `used = true` on the stored entry.
   *
   * Does nothing if no entry is found for the given ref.
   *
   * @param ref - The key package reference
   */
  async markUsed(ref: Uint8Array | string): Promise<void> {
    return this.#store.markUsed(ref);
  }

  /** Clears all entries (local and tracked) from the store. */
  async clear(): Promise<void> {
    return this.#store.clear();
  }

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  /**
   * Watches for any change to key packages or their published events.
   *
   * Yields the current snapshot on subscription, then re-yields on every
   * subsequent change.
   */
  async *watchKeyPackages(): AsyncGenerator<ListedKeyPackage[]> {
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

    this.on("added", signal);
    this.on("removed", signal);
    this.on("updated", signal);
    this.on("published", signal);

    try {
      yield [...(await this.#store.snapshot())];

      while (true) {
        await new Promise<void>((resolve) => {
          if (pending) {
            pending = false;
            resolve();
          } else {
            resolveNext = resolve;
          }
        });
        yield [...(await this.#store.snapshot())];
      }
    } finally {
      this.off("added", signal);
      this.off("removed", signal);
      this.off("updated", signal);
      this.off("published", signal);
    }
  }
}
