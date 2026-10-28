/** @module @category Client - Key Package Manager */
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import {
  Capabilities,
  CiphersuiteImpl,
  CiphersuiteName,
  ciphersuites,
  CryptoProvider,
  defaultCryptoProvider,
  KeyPackage,
  PrivateKeyPackage,
} from "ts-mls";

import { createCredential } from "../core/credential.js";
import {
  createDeleteKeyPackageEvent,
  createKeyPackageEvent,
} from "../core/key-package-event.js";
import {
  generateKeyPackage,
  type SignatureKeyPair,
} from "../core/key-package.js";
import { logger } from "../utils/debug.js";
import { NostrNetworkInterface } from "./nostr-interface.js";
import { KeyPackagePublishError } from "./key-package-errors.js";

/** Options for constructing a {@link KeyPackagePublisher}. */
export type KeyPackagePublisherOptions = {
  /** The signer used for the client's Nostr identity */
  signer: EventSigner;
  /** The nostr relay pool used to publish key package and deletion events */
  network: NostrNetworkInterface;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** Capabilities to advertise in generated key packages; Marmot's required ones are always added. */
  capabilities?: Capabilities;
  /** Load a persisted signing identity for the selected ciphersuite. */
  getSignatureKeyPair?: (
    ciphersuite: CiphersuiteImpl,
  ) => Promise<SignatureKeyPair>;
};

/** A freshly generated key package and its private material. */
export type GeneratedKeyPackage = {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
};

/** Options for {@link KeyPackagePublisher.generate}. */
export type GenerateKeyPackageOptions = {
  /** Ciphersuite to use (default: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) */
  ciphersuite?: CiphersuiteName;
  /** Whether to include the canonical reusable KeyPackage component (default: true) */
  isLastResort?: boolean;
};

/** Options for {@link KeyPackagePublisher.publish}. */
export type PublishKeyPackageOptions = {
  /** The public key package to advertise */
  keyPackage: KeyPackage;
  /** Addressable slot identifier (`d` tag value) for the kind 30443 event */
  identifier: string;
  /** Relay URLs where the key package event will be published */
  relays: string[];
  /** Client identifier string to include in the key package event */
  client?: string;
  /** Whether to include the NIP-70 protected tag on the event */
  protected?: boolean;
};

/**
 * The native-sensitive boundary of key package management: generates key
 * package material, builds and signs the kind-30443 advertisement event, and
 * publishes it (or a kind-5 deletion) to relays. Every `signer.signEvent`,
 * `network.publish`, and `randomBytes` site lives here, isolated for audit
 * against darkmatter's `KeyPackagePublisher`.
 */
export class KeyPackagePublisher {
  readonly #signer: EventSigner;
  readonly #network: NostrNetworkInterface;
  readonly #cryptoProvider: CryptoProvider;
  readonly #capabilities: Capabilities | undefined;
  readonly #getSignatureKeyPair: KeyPackagePublisherOptions["getSignatureKeyPair"];
  #log = logger.extend("KeyPackagePublisher");

  constructor(options: KeyPackagePublisherOptions) {
    this.#getSignatureKeyPair = options.getSignatureKeyPair;
    this.#signer = options.signer;
    this.#network = options.network;
    this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.#capabilities = options.capabilities;
  }

  /** Generates a fresh random addressable slot identifier (`d` tag value). */
  freshIdentifier(): string {
    return bytesToHex(randomBytes(32));
  }

  /**
   * Generates a new key package bound to this client's Nostr identity,
   * returning the public and private material. Does not persist or publish.
   */
  async generate(
    options?: GenerateKeyPackageOptions,
  ): Promise<GeneratedKeyPackage> {
    const pubkey = await this.#signer.getPublicKey();
    const credential = createCredential(pubkey);
    const ciphersuiteImpl = await this.#getCiphersuiteImpl(
      options?.ciphersuite,
    );

    return generateKeyPackage({
      credential,
      ciphersuiteImpl,
      signatureKeyPair: await this.#getSignatureKeyPair?.(ciphersuiteImpl),
      capabilities: this.#capabilities,
      isLastResort: options?.isLastResort,
      signer: this.#signer,
    });
  }

  /**
   * Builds, signs and publishes a kind-30443 key package event to the given
   * relays, returning the signed event after at least one requested relay ACKs.
   * @throws {KeyPackagePublishError} if no requested relay accepts the event
   */
  async publish(options: PublishKeyPackageOptions): Promise<NostrEvent> {
    const eventTemplate = await createKeyPackageEvent({
      keyPackage: options.keyPackage,
      identifier: options.identifier,
      relays: options.relays,
      client: options.client,
      protected: options.protected,
    });
    const signed = await this.#signer.signEvent(eventTemplate);
    await this.#publishAcknowledged(options.relays, signed);
    this.#log(
      "published key package event %s with slot %s",
      signed.id,
      options.identifier,
    );
    return signed;
  }

  /**
   * Builds, signs and publishes a single NIP-09 deletion covering the given
   * key package events to the given relays, returning the signed event after at
   * least one requested relay ACKs. An ACK does not prove all copies were erased.
   * @throws {KeyPackagePublishError} if no requested relay accepts the event
   */
  async delete(events: NostrEvent[], relays: string[]): Promise<NostrEvent> {
    const draft = createDeleteKeyPackageEvent({ events });
    const signed = await this.#signer.signEvent(draft);
    await this.#publishAcknowledged(relays, signed);
    this.#log(
      "published delete event %s for %d events",
      signed.id,
      events.length,
    );
    return signed;
  }

  async #publishAcknowledged(
    relays: string[],
    event: NostrEvent,
  ): Promise<void> {
    const responses = await this.#network.publish(relays, event);
    if (!relays.some((relay) => responses[relay]?.ok === true)) {
      throw new KeyPackagePublishError(event, relays, responses);
    }
  }

  async #getCiphersuiteImpl(name?: CiphersuiteName) {
    const ciphersuiteName =
      name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
    const id = ciphersuites[ciphersuiteName];
    return this.#cryptoProvider.getCiphersuiteImpl(id);
  }
}
