/** @module @category Client - Group Manager */
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  CiphersuiteName,
  ciphersuites,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  Proposal,
  Welcome,
} from "ts-mls";
import type { SerializedClientState } from "../core/client-state.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import { GroupHistoryTree } from "../engine/history-tree.js";
import { MarmotGroupEngine } from "../engine/group-engine.js";
import { RetainedHistoryStore } from "../engine/retained-store.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { ProposalAction } from "../engine/types.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
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
import { createInviteIntent } from "./group/invite.js";
import { NostrGroupPeeler } from "./group/nostr-peeler.js";
import type { WelcomeRecipient } from "./transport/nostr/welcome-delivery.js";
import { defaultVerifyEvent, type VerifyEventMethod } from "./verify.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";

/** Options accepted by {@link GroupFactory}. */
export type GroupFactoryOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore: GenericKeyValueStore<Uint8Array>;
  lifecycleStore: GenericKeyValueStore<Uint8Array>;
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
  historyFactory?: GroupHistoryFactory<THistory>;
  mediaFactory?: GroupMediaFactory<TMedia>;
  /** Convergence policy applied to newly created/imported groups. */
  convergencePolicy?: ConvergencePolicy;
  /** Ingestion-pool tuning applied to newly created/imported groups. */
  ingestionPool?: IngestionPoolOptions;
  /**
   * Injectable event verifier for founding invitee admission (D-11), gating
   * the same 30443 trust boundary `GroupsManager.invite()` already uses.
   * Defaults to applesauce's `verifyEvent`.
   */
  verifyEvent?: VerifyEventMethod;
};

export type CreateGroupOptions = SimpleGroupOptions & {
  ciphersuite?: CiphersuiteName;
  /**
   * Founding invitees' KeyPackage events (kind 30443). Supplying this turns
   * `create()` into a *founding* creation (D-08): one Add commit carrying
   * every invitee is merged locally to epoch 1 and **no** kind-445 group
   * event is published for it (`refs/marmot/protocol-core/joining.md` lines
   * 21-30 — the founding-creation exception). Omitting `invitees` keeps
   * today's exact solo-create behaviour and code path.
   *
   * D-09 footgun: an invitee list with no `relays` supplied is a supported
   * case, not an error — but the resulting group then has no
   * `transport.nostr.routing` component, so it can never carry ordinary
   * group traffic afterwards. A successful founding create can still produce
   * a group that is unusable for messaging; Welcome delivery in that case
   * depends entirely on each recipient's own published NIP-65 inbox relays.
   */
  invitees?: NostrEvent[];
};

/**
 * Result of the founding orchestration (`#createFounding`): the canonical
 * epoch-1 state plus the convergence structures and Welcome material the
 * caller needs to construct and persist the group and fan out Welcomes.
 */
type FoundingCreateResult = {
  state: ClientState;
  retained: RetainedHistoryStore;
  historyTree: GroupHistoryTree;
  welcome: Welcome;
  recipients: WelcomeRecipient[];
};

/**
 * Builds new {@link MarmotGroup} instances. Isolates the identity signer and
 * the ciphersuite implementation — i.e. the native-sensitive group-creation
 * seam (darkmatter's `do_create_group`). The factory only constructs and
 * persists; caching/eventing is the registry's job.
 */
export class GroupFactory<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> {
  readonly #store: GenericKeyValueStore<SerializedClientState>;
  readonly #ingestStateStore: GenericKeyValueStore<Uint8Array>;
  readonly #lifecycleStore: GenericKeyValueStore<Uint8Array>;
  readonly #rewindStore?: GenericKeyValueStore<Uint8Array>;
  readonly #removedMarkerStore?: GenericKeyValueStore<boolean>;
  readonly #signer: EventSigner;
  readonly #network: NostrNetworkInterface;
  readonly #audit?: AuditSink;
  readonly #auditContext?: AuditContextOptions;
  readonly #cryptoProvider: CryptoProvider;
  readonly #historyFactory: GroupHistoryFactory<THistory>;
  readonly #mediaFactory: GroupMediaFactory<TMedia>;
  readonly #convergencePolicy?: ConvergencePolicy;
  readonly #ingestionPool?: IngestionPoolOptions;
  readonly #verifyEvent: VerifyEventMethod;

  constructor(options: GroupFactoryOptions<THistory, TMedia>) {
    this.#store = options.store;
    this.#ingestStateStore = options.ingestStateStore;
    this.#lifecycleStore = options.lifecycleStore;
    this.#rewindStore = options.rewindStore;
    this.#removedMarkerStore = options.removedMarkerStore;
    this.#convergencePolicy = options.convergencePolicy;
    this.#ingestionPool = options.ingestionPool;
    this.#signer = options.signer;
    this.#network = options.network;
    this.#audit = options.audit;
    this.#auditContext = options.auditContext;
    this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.#historyFactory =
      options.historyFactory as GroupHistoryFactory<THistory>;
    this.#mediaFactory = options.mediaFactory as GroupMediaFactory<TMedia>;
    this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
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
   *
   * When `options.invitees` is a non-empty array, this becomes a *founding*
   * creation (D-08): every invitee is admitted through the unchanged invite
   * trust boundary (D-11) into one founding Add commit that is merged
   * locally to epoch 1 with no yield between send and confirm (D-01/D-02),
   * the produced Welcome is asserted to carry exactly one distinct secret
   * per invitee (D-13), and Welcomes are fanned out directly, bypassing
   * `GroupRuntime` (D-05/D-07/D-12). Only one durable write occurs either
   * way (D-03): omitting `invitees` keeps today's exact solo-create result.
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
      signer: this.#signer,
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

    const invitees = options?.invitees;
    const founding =
      invitees && invitees.length > 0
        ? await this.#createFounding(
            pubkey,
            ciphersuiteImpl,
            clientState,
            invitees,
          )
        : undefined;

    const group = new MarmotGroup<THistory, TMedia>(
      founding?.state ?? clientState,
      {
        ciphersuite: ciphersuiteImpl,
        store: this.#store,
        ingestStateStore: this.#ingestStateStore,
        lifecycleStore: this.#lifecycleStore,
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
        retained: founding?.retained,
        historyTree: founding?.historyTree,
      },
    );
    // GroupSession only binds a tree it created itself (its own fresh
    // GroupHistoryTree) — a supplied tree must be bound here before saving,
    // or save()'s history.flush() would throw.
    if (founding && this.#rewindStore)
      founding.historyTree.bindStore(this.#rewindStore);
    await group.save(true);

    // D-05/D-07/D-12: fan out directly, bypassing GroupRuntime entirely — no
    // GroupPublishWork, no GroupEffects, no GroupRuntime publish call. Never
    // throws on partial or total Welcome failure: the group exists at epoch
    // 1 with all N members either way, and failures sit in
    // group.pendingWelcomes for retry.
    if (founding) {
      await group.deliverFoundingWelcomes({
        welcome: founding.welcome,
        author: pubkey,
        recipients: founding.recipients,
      });
    }

    return group;
  }

  /**
   * The founding orchestration (D-01/D-02/D-03/D-11/D-13): admits every
   * invitee through the unchanged invite trust boundary, merges one founding
   * Add commit locally with no yield before confirmation, and asserts the
   * resulting Welcome's shape before any persistence or delivery. Returns
   * the canonical epoch-1 state plus the convergence structures and Welcome
   * material `create()` needs — it performs no persistence and no delivery
   * itself.
   */
  async #createFounding(
    pubkey: string,
    ciphersuiteImpl: CiphersuiteImpl,
    epochZeroState: ClientState,
    invitees: NostrEvent[],
  ): Promise<FoundingCreateResult> {
    // D-13 (pre-burn): reject a duplicate invitee before any KeyPackage
    // material is consumed, before any commit is built. The realistic
    // trigger is the same invitee's KeyPackage passed twice.
    const seenPubkeys = new Set<string>();
    const seenEventIds = new Set<string>();
    for (const event of invitees) {
      if (seenPubkeys.has(event.pubkey) || seenEventIds.has(event.id)) {
        throw new Error(
          `GroupFactory.create: duplicate founding invitee ${event.pubkey}`,
        );
      }
      seenPubkeys.add(event.pubkey);
      seenEventIds.add(event.id);
    }

    // D-11: admit each invitee through the unchanged invite trust boundary —
    // zero new trust-boundary code, so the founding path cannot drift from
    // SEC-01/WIRE-01/WIRE-02 and the credential-identity-equals-author gate.
    // Only the single Add proposal and single Welcome recipient of each
    // resulting commit intent are kept; the rest of the intent is discarded.
    const extraProposals: (
      | Proposal
      | ProposalAction<Proposal>
      | (Proposal | ProposalAction<Proposal>)[]
    )[] = [];
    const recipients: WelcomeRecipient[] = [];
    for (const keyPackageEvent of invitees) {
      const intent = createInviteIntent({
        keyPackageEvent,
        actorPubkey: pubkey,
        verifyEvent: this.#verifyEvent,
      });
      extraProposals.push(intent.extraProposals![0]!);
      recipients.push(intent.welcomeRecipients![0]!);
    }

    // A short-lived engine over the epoch-0 state. Its retained store and
    // history tree are handed to the caller so they can be passed straight
    // into the constructed MarmotGroup, letting the founding commit's CR-09
    // records (retained history + fork tree) survive into the group's own
    // engine. This second engine emits its own engine-start audit context
    // for the same group id — an accepted consequence of D-05's bypass.
    const peeler = new NostrGroupPeeler(ciphersuiteImpl);
    const retained = new RetainedHistoryStore(
      epochZeroState,
      this.#convergencePolicy,
    );
    const historyTree = new GroupHistoryTree(epochZeroState);
    const engine = new MarmotGroupEngine({
      state: epochZeroState,
      ciphersuite: ciphersuiteImpl,
      peeler,
      retained,
      historyTree,
      convergencePolicy: this.#convergencePolicy,
      ingestionPool: this.#ingestionPool,
      audit: this.#audit,
      auditContext: this.#auditContext,
    });

    // D-01/D-02: stage and merge with nothing in between — no await, no
    // logging, no persistence, no group construction. This invariant is
    // enforced by convention, not by signature (R-01); any inserted await
    // here widens a real observable PendingPublish window.
    const result = await engine.send({
      kind: "foundingAdd",
      actorPubkey: pubkey,
      extraProposals,
    });
    if (result.kind !== "foundingGroupCreated") {
      throw new Error(
        `GroupFactory.create: expected a founding-create send result, got ${result.kind}`,
      );
    }
    engine.confirmPublished(result.pending);

    // D-13 (pre-delivery): assert exactly one distinct Welcome secret per
    // invitee before any persistence or delivery attempt, mirroring MDK's
    // guard. Synchronous, so it introduces no new yield point — if it
    // throws, nothing has been persisted (D-03) and no group was ever
    // constructed.
    assertOneWelcomeSecretPerInvitee(result.welcome.welcome, invitees.length);

    return {
      state: engine.state,
      retained,
      historyTree,
      welcome: result.welcome.welcome,
      recipients,
    };
  }
}

/**
 * D-13 (post-confirm, pre-delivery): asserts the founding Welcome carries
 * exactly one distinct secret per invitee, mirroring MDK's `do_create_group`
 * guard (refs/mdk/crates/cgka-engine/src/group_lifecycle.rs). Catches a
 * ts-mls behaviour change or a duplicate-KeyPackage invitee list at the one
 * point where it is cheap — before KeyPackage material is burned.
 */
function assertOneWelcomeSecretPerInvitee(
  welcome: Welcome,
  inviteeCount: number,
): void {
  if (welcome.secrets.length !== inviteeCount) {
    throw new Error(
      `GroupFactory.create: founding creation did not produce one distinct Welcome per invitee (expected ${inviteeCount} secrets, got ${welcome.secrets.length})`,
    );
  }
  const distinctMembers = new Set(
    welcome.secrets.map((secret) => bytesToHex(secret.newMember)),
  );
  if (distinctMembers.size !== inviteeCount) {
    throw new Error(
      "GroupFactory.create: founding creation did not produce one distinct Welcome per invitee (duplicate newMember reference)",
    );
  }
}
