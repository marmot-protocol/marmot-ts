/** @module @category Client - Group Manager */
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteName,
  ciphersuites,
  CryptoProvider,
  defaultCryptoProvider,
} from "ts-mls";
import type { SerializedClientState } from "../core/client-state.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import type { AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import { createCredential } from "../core/credential.js";
import { createSimpleGroup, SimpleGroupOptions } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";

/** Options accepted by {@link GroupFactory}. */
export type GroupFactoryOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore: GenericKeyValueStore<Uint8Array>;
  /** Dedicated store for the per-group rewind-history blob (optional). */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /**
   * Persisted removed-inactive marker store (D-12) inherited by new groups;
   * see {@link MarmotGroupOptions.removedMarkerStore}.
   */
  removedMarkerStore?: GenericKeyValueStore<boolean>;
  signer: EventSigner;
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by new groups. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  cryptoProvider?: CryptoProvider;
  accountProofSigner?: AccountIdentityProofSigner;
  historyFactory?: GroupHistoryFactory<THistory>;
  mediaFactory?: GroupMediaFactory<TMedia>;
  /** Convergence policy applied to newly created/imported groups. */
  convergencePolicy?: ConvergencePolicy;
  /** Ingestion-pool tuning applied to newly created/imported groups. */
  ingestionPool?: IngestionPoolOptions;
};

export type CreateGroupOptions = SimpleGroupOptions & {
  ciphersuite?: CiphersuiteName;
};

/**
 * Builds new {@link MarmotGroup} instances. Isolates the only consumers of the
 * account-identity-proof signer and the ciphersuite implementation — i.e. the
 * native-sensitive group-creation seam (darkmatter's `do_create_group`). The
 * factory only constructs and persists; caching/eventing is the registry's job.
 */
export class GroupFactory<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> {
  readonly #store: GenericKeyValueStore<SerializedClientState>;
  readonly #ingestStateStore: GenericKeyValueStore<Uint8Array>;
  readonly #rewindStore?: GenericKeyValueStore<Uint8Array>;
  readonly #removedMarkerStore?: GenericKeyValueStore<boolean>;
  readonly #signer: EventSigner;
  readonly #network: NostrNetworkInterface;
  readonly #audit?: AuditSink;
  readonly #auditContext?: AuditContextOptions;
  readonly #cryptoProvider: CryptoProvider;
  readonly #accountProofSigner?: AccountIdentityProofSigner;
  readonly #historyFactory: GroupHistoryFactory<THistory>;
  readonly #mediaFactory: GroupMediaFactory<TMedia>;
  readonly #convergencePolicy?: ConvergencePolicy;
  readonly #ingestionPool?: IngestionPoolOptions;

  constructor(options: GroupFactoryOptions<THistory, TMedia>) {
    this.#store = options.store;
    this.#ingestStateStore = options.ingestStateStore;
    this.#rewindStore = options.rewindStore;
    this.#removedMarkerStore = options.removedMarkerStore;
    this.#convergencePolicy = options.convergencePolicy;
    this.#ingestionPool = options.ingestionPool;
    this.#signer = options.signer;
    this.#network = options.network;
    this.#audit = options.audit;
    this.#auditContext = options.auditContext;
    this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.#accountProofSigner = options.accountProofSigner;
    this.#historyFactory =
      options.historyFactory as GroupHistoryFactory<THistory>;
    this.#mediaFactory = options.mediaFactory as GroupMediaFactory<TMedia>;
  }

  /** Resolves a ciphersuite implementation from a name (defaults to X25519/AES128). */
  async #getCiphersuiteImpl(name?: CiphersuiteName) {
    const ciphersuiteName =
      name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
    const id = ciphersuites[ciphersuiteName];
    return await this.#cryptoProvider.getCiphersuiteImpl(id);
  }

  /**
   * Creates and persists a new simple group with the manager's signer as the
   * sole initial admin. The returned group is saved but not cached — the
   * caller (registry/manager) tracks it and emits the `created` event.
   */
  async create(
    name: string,
    options?: CreateGroupOptions,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const ciphersuiteImpl = await this.#getCiphersuiteImpl(
      options?.ciphersuite,
    );

    const pubkey = await this.#signer.getPublicKey();
    const credential = await createCredential(pubkey);
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
      accountProofSigner: this.#accountProofSigner,
    });

    const { clientState } = await createSimpleGroup(
      keyPackage,
      ciphersuiteImpl,
      name,
      {
        ...options,
        adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
      },
    );

    const group = new MarmotGroup<THistory, TMedia>(clientState, {
      ciphersuite: ciphersuiteImpl,
      store: this.#store,
      ingestStateStore: this.#ingestStateStore,
      rewindStore: this.#rewindStore,
      removedMarkerStore: this.#removedMarkerStore,
      convergencePolicy: this.#convergencePolicy,
      ingestionPool: this.#ingestionPool,
      signer: this.#signer,
      network: this.#network,
      audit: this.#audit,
      auditContext: this.#auditContext,
      history: this.#historyFactory,
      media: this.#mediaFactory,
    });
    await group.save(true);

    return group;
  }
}
