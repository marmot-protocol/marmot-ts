/** @module @category Client - Marmot Client */
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import {
  Capabilities,
  CryptoProvider,
  defaultCryptoProvider,
  GroupInfo,
  Welcome,
} from "ts-mls";
import { type AccountIdentityProofSigner } from "../core/account-identity-proof.js";
import {
  getMarmotGroupView,
  SerializedClientState,
} from "../core/client-state.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import {
  getWelcome,
  getWelcomeGroupRelays,
  getWelcomeKeyPackageEventId,
  getWelcomeKeyPackageRefs,
  readWelcomeGroupInfo,
} from "../core/welcome.js";
import { logger } from "../utils/debug.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import { GroupsManager } from "./groups-manager.js";
import {
  InviteManager,
  StoredInviteEntry,
  type UnreadInvite,
} from "./invite-manager.js";
import type { StoredKeyPackage } from "./key-package-manager.js";
import { KeyPackageManager } from "./key-package-manager.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";
import { defaultVerifyEvent, type VerifyEventMethod } from "./verify.js";

const log = logger.extend("client");

/** Decrypted group metadata previewed from a Welcome before joining. */
export interface WelcomePreviewGroup {
  name: string;
  description: string;
  adminPubkeys: string[];
  relays: string[];
}

/**
 * Everything that can be surfaced about an invite *before* committing to join —
 * see {@link MarmotClient.previewWelcome}. The rumor-level fields decode without
 * key material; `group` requires decrypting the Welcome with a held KeyPackage
 * and is null when none matches or the decode fails.
 */
export interface WelcomePreview {
  /** Group relay URLs from the Welcome's `relays` tag. */
  relays: string[];
  /** Kind-30443 KeyPackage event id this Welcome consumed, if tagged. */
  keyPackageEventId?: string;
  /** MLS cipher suite id from the Welcome struct. */
  cipherSuite?: number;
  /** Number of recipients the Welcome targets. */
  recipientCount?: number;
  /** Group epoch from the previewed GroupInfo. */
  epoch?: bigint;
  /** Decrypted group metadata, or null when unavailable. */
  group: WelcomePreviewGroup | null;
}

/** An unread invite annotated with whether we can act on it (see {@link MarmotClient.watchInvites}). */
export interface AnnotatedInvite {
  invite: UnreadInvite;
  /** True iff we still hold the KeyPackage the Welcome is addressed to. */
  joinable: boolean;
}

export type MarmotClientOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The signer used for the clients identity */
  signer: EventSigner;
  /**
   * Optional Nostr-account proof signer. When provided, key packages this
   * client publishes carry a `marmot.account-identity-proof.v1` LeafNode
   * extension required for darkmatter wire interop. Supply from a signer with
   * raw BIP-340 access (the applesauce `EventSigner` cannot sign the digest).
   */
  accountProofSigner?: AccountIdentityProofSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /** The backend to store and load the groups from */
  groupStateStore: GenericKeyValueStore<SerializedClientState>;
  /**
   * Dedicated backend for the per-group full-fork history tree (the single
   * persisted source for fork recovery and the {@link MarmotGroup.forkTree}
   * API). When provided, the tree is persisted so fork recovery survives a
   * restart; back it with the same durable (ideally encrypted) backend as
   * `groupStateStore`. Optional — when omitted, history is in-memory only and is
   * rebuilt from the current tip after each restart.
   */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /**
   * Dedicated backend for the persisted removed-inactive marker (D-12), keyed
   * by group-id hex like `groupStateStore`. When provided, the fact that an
   * involuntary removal was already realized survives a restart, so the
   * `removed` event fires exactly once across process boundaries and a
   * re-convergence that supersedes the removing commit can clear it durably.
   * Back it with the same durable backend as `groupStateStore`. Optional —
   * when omitted, realization is in-memory-only and does not survive a restart.
   */
  removedMarkerStore?: GenericKeyValueStore<boolean>;
  /**
   * Convergence policy applied to every group: branch selection and the
   * `maxRewindCommits` rollback horizon. Set `maxRewindCommits: Infinity` to
   * preserve the whole MLS history and keep forks of any age eligible for
   * re-convergence. Defaults to the profile-1 policy
   * ({@link DEFAULT_CONVERGENCE_POLICY}).
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Ingestion-pool tuning applied to every group: max entries and max epoch-age
   * for undecryptable events held and retried as history grows. Defaults bound
   * it; a debugging tool that retains and processes everything can raise both
   * (e.g. a large `maxSize` and a very large `maxEpochAge`).
   */
  ingestionPool?: IngestionPoolOptions;
  /** The backend for key package private material and publish tracking */
  keyPackageStore: GenericKeyValueStore<StoredKeyPackage>;
  /** Key value store for the {@link InviteManager} class, if non is provided an {@link InMemoryKeyValueStore} is used */
  inviteStore?: GenericKeyValueStore<StoredInviteEntry>;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by groups. Omitted by default. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  /**
   * Injectable Nostr event verifier gating the inbound trust boundary (SEC-01)
   * across all three entry points: the 445 group-message drain, the 1059
   * gift-wrap ingest, and the 30443 KeyPackage publish/track path. Defaults to
   * applesauce's `verifyEvent` (real BIP-340 Schnorr signature verification).
   * Callers that trust their event source upstream (e.g. already verified by
   * a relay pool) may inject `fakeVerifyEvent` instead, or supply a
   * native/WASM verifier for performance — do not introduce a separate
   * boolean skip-verification flag.
   */
  verifyEvent?: VerifyEventMethod;
  /**
   * Default `d` tag value (slot identifier) for key package events.
   * Used by {@link KeyPackageManager.create} when no explicit `d` is passed.
   * Set this to a stable per-device string (e.g. `"my-app-desktop"`) so all
   * key packages from this client share a single addressable slot on relays.
   */
  clientId?: string;
} & (THistory extends undefined
  ? {}
  : {
      /** The group history interface to be passed to group instance */
      historyFactory: GroupHistoryFactory<THistory>;
    }) &
  (TMedia extends undefined
    ? {}
    : {
        /** The group media interface to be passed to group instance */
        mediaFactory: GroupMediaFactory<TMedia>;
      });

export class MarmotClient<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> {
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The capabilities to use for the client */
  readonly capabilities: Capabilities;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;
  /** Manages key package lifecycle: local storage, publishing, and rotation */
  readonly keyPackages: KeyPackageManager;
  /** Manages group lifecycle: persistence, caching, creation, loading, leaving */
  readonly groups: GroupsManager<THistory, TMedia>;
  /** Manages invite lifecycle: ingestion, decryption, and storage */
  readonly invites: InviteManager;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  constructor(options: MarmotClientOptions<THistory, TMedia>) {
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
    this.keyPackages = new KeyPackageManager({
      store: options.keyPackageStore,
      signer: options.signer,
      accountProofSigner: options.accountProofSigner,
      network: options.network,
      clientId: options.clientId,
      verifyEvent,
    });

    const historyFactory = (
      "historyFactory" in options ? options.historyFactory : undefined
    ) as GroupHistoryFactory<THistory>;
    const mediaFactory = (
      "mediaFactory" in options ? options.mediaFactory : undefined
    ) as GroupMediaFactory<TMedia>;

    this.groups = new GroupsManager<THistory, TMedia>({
      store: options.groupStateStore,
      rewindStore: options.rewindStore,
      removedMarkerStore: options.removedMarkerStore,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      signer: this.signer,
      accountProofSigner: options.accountProofSigner,
      network: this.network,
      audit: options.audit,
      auditContext: options.auditContext,
      cryptoProvider: this.cryptoProvider,
      historyFactory,
      mediaFactory,
      verifyEvent,
    });

    this.invites = new InviteManager({
      signer: this.signer,
      store: options.inviteStore || new InMemoryKeyValueStore(),
      network: this.network,
      verifyEvent,
    });
  }

  // ---------------------------------------------------------------------------
  // Welcome / invite flows
  //
  // These are higher-level methods that combine key package lookup with
  // MLS join logic. They delegate group persistence/caching to `this.groups`.
  // ---------------------------------------------------------------------------

  /**
   * Reads the {@link GroupInfo} from a Welcome rumor without joining the group.
   *
   * Finds the local key package that matches one of the welcome's recipient slots,
   * then decrypts the group info using that key package. Useful for previewing
   * group metadata (name, relays, admins) before deciding to join.
   *
   * @param welcomeRumor - The decrypted kind 444 welcome rumor
   * @returns The decrypted GroupInfo, or null if no matching key package is found or decryption fails
   */
  async readInviteGroupInfo(
    welcomeRumor: Rumor | Welcome,
  ): Promise<GroupInfo | null> {
    const welcome = isRumor(welcomeRumor)
      ? getWelcome(welcomeRumor)
      : welcomeRumor;

    // Reuse the same candidate selection as joinGroupFromWelcome (ref matches
    // first), then try decrypting the group info with each until one succeeds.
    const candidates = await this.keyPackages.selectForWelcome(welcome);
    for (const candidate of candidates) {
      try {
        const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
          candidate.publicPackage.cipherSuite,
        );
        return await readWelcomeGroupInfo({
          welcome,
          keyPackage: candidate,
          ciphersuiteImpl,
        });
      } catch {
        // Ignore error, try other key packages
      }
    }

    return null;
  }

  /**
   * Whether we still hold the private KeyPackage a Welcome is addressed to —
   * i.e. whether {@link joinGroupFromWelcome} can succeed for this invite.
   * Accepting an invite whose KeyPackage we no longer hold (e.g. it rotated
   * away) would fail with "No matching KeyPackage found". Never throws: an
   * unparseable Welcome yields `false`.
   */
  async canJoinInvite(invite: UnreadInvite): Promise<boolean> {
    try {
      for (const ref of getWelcomeKeyPackageRefs(invite)) {
        if (await this.keyPackages.has(ref)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Decodes everything showable about an invite *before* committing to join.
   * Rumor-level fields (relays, KeyPackage event id, cipher suite, recipient
   * count) decode without key material; the `group` block requires decrypting
   * the Welcome with a held KeyPackage via {@link readInviteGroupInfo} and is
   * null when we don't hold it. Never throws — a malformed Welcome or failed
   * preview just yields the fields it could read.
   */
  async previewWelcome(invite: UnreadInvite): Promise<WelcomePreview> {
    const preview: WelcomePreview = {
      relays: getWelcomeGroupRelays(invite),
      keyPackageEventId: getWelcomeKeyPackageEventId(invite),
      group: null,
    };

    try {
      const welcome = getWelcome(invite);
      preview.cipherSuite = welcome.cipherSuite;
      preview.recipientCount = welcome.secrets.length;
    } catch {
      // Unparseable Welcome — leave the MLS-struct fields undefined.
    }

    try {
      const groupInfo = await this.readInviteGroupInfo(invite);
      if (groupInfo) {
        preview.epoch = groupInfo.groupContext.epoch;
        const view = getMarmotGroupView(groupInfo);
        if (view) {
          preview.group = {
            name: view.name,
            description: view.description,
            adminPubkeys: view.adminPubkeys,
            relays: view.relays,
          };
        }
      }
    } catch {
      // Best-effort preview; keep the rumor-level fields already decoded.
    }

    return preview;
  }

  /**
   * Like {@link InviteManager.watchUnread}, but annotates each invite with
   * whether it's {@link canJoinInvite | joinable}. Lets an app default to showing
   * only acceptable invites while still being able to reveal the rest.
   */
  async *watchInvites(): AsyncGenerator<AnnotatedInvite[]> {
    for await (const invites of this.invites.watchUnread()) {
      const joinable = await Promise.all(
        invites.map((invite) => this.canJoinInvite(invite)),
      );
      yield invites.map((invite, index) => ({
        invite,
        joinable: joinable[index]!,
      }));
    }
  }

  /**
   * Joins a group from a Welcome message received via NIP-59 gift wrap.
   *
   * This method:
   * 1. Decodes the Welcome message from the kind 444 event
   * 2. Finds the matching local KeyPackage private material from the store
   * 3. Calls ts-mls joinGroup() to create a new ClientState
   * 4. Persists the resulting ClientState via `this.groups.adoptClientState()`
   * 5. Marks the consumed key package as used via `this.keyPackages.markUsed()`
   * 6. Returns a MarmotGroup instance
   *
   * After joining, callers can list used key packages with
   * `(await client.keyPackages.list()).filter(p => p.used)` and rotate them
   * via `client.keyPackages.rotate(ref)` to publish fresh ones to relays.
   *
   * @returns Promise resolving to the joined group
   * @throws Error if no matching KeyPackage is found or if joining fails
   */
  async joinGroupFromWelcome(options: {
    /** The unwrapped kind 444 rumor event containing the Welcome message */
    welcomeRumor: Rumor;
  }): Promise<{
    group: MarmotGroup<THistory, TMedia>;
  }> {
    const { welcomeRumor } = options;
    log("joining group from welcome rumor %s", welcomeRumor.id);

    const welcome = getWelcome(welcomeRumor);

    // ts-mls v2: welcome.cipherSuite is a numeric CiphersuiteId
    const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
      welcome.cipherSuite,
    );

    // Candidate selection (KeyPackageRef matching) lives in the key-package
    // layer; the MLS join + leaf-proof validation + persistence live in the
    // group layer — mirroring darkmatter's engine `do_join_welcome` rather than
    // doing protocol matching here in the composition root.
    const candidates = await this.keyPackages.selectForWelcome(welcome);
    const { group, consumedKeyPackageRef } = await this.groups.joinFromWelcome({
      welcome,
      candidates,
      ciphersuiteImpl,
    });

    // Mark the consumed key package as used. Callers can later list used packages
    // with (await client.keyPackages.list()).filter(p => p.used) and rotate them
    // via client.keyPackages.rotate(ref) to publish fresh ones to relays.
    if (consumedKeyPackageRef) {
      await this.keyPackages.markUsed(consumedKeyPackageRef);
    }

    log("joined group %s", group.idStr);

    // refs/marmot/protocol-core/joining.md: callers are responsible for calling
    // group.selfUpdate() after joining to rotate leaf key material for forward
    // secrecy. Doing it automatically here caused the joining member to fork off
    // to a new epoch before other members could ingest the commit.

    return { group };
  }
}
