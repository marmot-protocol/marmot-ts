/** @module @category Client - Marmot Client */
import { bytesToHex } from "@noble/hashes/utils.js";
import { watchCurrent } from "../utils/watch-current.js";
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import {
  Capabilities,
  CryptoProvider,
  defaultCryptoProvider,
  GroupInfo,
  Welcome,
} from "ts-mls";
import { getMarmotGroupView } from "../core/client-state.js";
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
import type { MarmotDatabase } from "./storage/database/types.js";
import { MarmotGroup } from "./group/marmot-group.js";
import { GroupsManager } from "./groups-manager.js";
import { InviteManager, type UnreadInvite } from "./invite-manager.js";
import {
  KeyPackageManager,
  type KeyPackageManagerOptions,
} from "./key-package-manager.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
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

export type MarmotClientOptions = {
  /**
   * The signer used for the client's Nostr identity. Also signs the kind-450
   * account identity proof carried by every KeyPackage and leaf this client
   * creates.
   */
  signer: EventSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /**
   * Where the client persists everything: one database per group (protocol
   * state, fork history, ingest ledgers, lifecycle records and decrypted
   * messages) plus an account database (key packages including private keys,
   * invites and the group list). See {@link MarmotDatabase} for the adapter
   * contract. Use {@link memoryDatabase} only for tests and demos.
   */
  database: MarmotDatabase;
  /**
   * Convergence policy applied to every group: branch selection and the
   * `maxRewindCommits` rollback horizon. Keep the finite profile-1 default
   * ({@link DEFAULT_CONVERGENCE_POLICY}) for production. `Infinity` is an
   * explicit debugging/forensics choice that keeps arbitrarily old forks
   * eligible and can retain unbounded evidence; the horizon does not guarantee
   * pruning of every full-history tree record.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Ingestion-pool tuning applied to every group: max entries and max epoch-age
   * for undecryptable events held and retried as history grows. Defaults bound
   * it; a debugging tool that retains and processes everything can raise both
   * (e.g. a large `maxSize` and a very large `maxRewindCommits`).
   */
  ingestionPool?: IngestionPoolOptions;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** Load a persisted installation signing identity for KeyPackages. */
  getSignatureKeyPair?: KeyPackageManagerOptions["getSignatureKeyPair"];
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
   * Generate 32 random bytes once and persist their 64-character lowercase hex
   * encoding so key packages share a stable addressable slot on relays.
   */
  clientId?: string;
};

export class MarmotClient {
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The capabilities to use for the client */
  readonly capabilities: Capabilities;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;
  /** Manages key package lifecycle: local storage, publishing, and rotation */
  readonly keyPackages: KeyPackageManager;
  /** Manages group lifecycle: persistence, caching, creation, loading, leaving */
  readonly groups: GroupsManager;
  /** Manages invite lifecycle: ingestion, decryption, and storage */
  readonly invites: InviteManager;
  /** The client's account and per-group databases. */
  readonly database: MarmotDatabase;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  constructor(options: MarmotClientOptions) {
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
    this.database = options.database;
    this.keyPackages = new KeyPackageManager({
      database: options.database.account,
      signer: options.signer,
      network: options.network,
      clientId: options.clientId,
      cryptoProvider: this.cryptoProvider,
      capabilities: options.capabilities,
      getSignatureKeyPair: options.getSignatureKeyPair,
      verifyEvent,
      hasAdoptedGroup: async (groupId, adoptionTag) => {
        if (adoptionTag === undefined) return this.groups.has(groupId);
        const database = await this.database.groups.open(bytesToHex(groupId));
        try {
          const record = await database.group();
          return (
            (record.state !== undefined ||
              record.disbandTombstone !== undefined) &&
            record.adoptionIds?.includes(adoptionTag) === true
          );
        } finally {
          await database.close();
        }
      },
    });

    this.groups = new GroupsManager({
      database: options.database,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      signer: this.signer,
      network: this.network,
      audit: options.audit,
      auditContext: options.auditContext,
      cryptoProvider: this.cryptoProvider,
      verifyEvent,
    });

    this.invites = new InviteManager({
      signer: this.signer,
      database: options.database.account,
      network: this.network,
      verifyEvent,
    });
  }

  /**
   * Releases loaded groups and their connections without deleting persisted
   * state. Safe to call repeatedly. The injected database and network remain
   * owned by the caller and are not closed.
   *
   * Do not reuse this client after disposal. Caller-owned invite listeners and
   * watchers should still be stopped with their handles or AbortSignals.
   */
  dispose(): void {
    this.groups.dispose();
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
   *
   * Pass an AbortSignal to stop watching. Abort, return, throw, and async
   * disposal release listeners and interrupt pending reads without another event.
   * Abandoned reads may finish internally; their results are ignored.
   */
  watchInvites(
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AnnotatedInvite[]> {
    return watchCurrent({
      ...options,
      read: async () => {
        const invites = await this.invites.getUnread();
        const joinable = await Promise.all(
          invites.map((invite) => this.canJoinInvite(invite)),
        );
        return invites.map((invite, index) => ({
          invite,
          joinable: joinable[index]!,
        }));
      },
      subscribe: (changed) => {
        const offInvites = this.invites.onUnreadChanged(changed);
        // Joinability depends on which KeyPackages are held locally.
        this.keyPackages.on("added", changed);
        this.keyPackages.on("removed", changed);
        this.keyPackages.on("updated", changed);
        return () => {
          offInvites();
          this.keyPackages.off("added", changed);
          this.keyPackages.off("removed", changed);
          this.keyPackages.off("updated", changed);
        };
      },
    });
  }

  /**
   * Joins a group from a Welcome message received via NIP-59 gift wrap.
   *
   * This method:
   * 1. Decodes the Welcome message from the kind 444 event
   * 2. Finds the matching local KeyPackage private material from the store
   * 3. Calls ts-mls joinGroup() to create a new ClientState
   * 4. Persists the resulting ClientState via `this.groups.adoptClientState()`
   * 5. Finalizes a durable consumption receipt: retires single-use private
   *    material and retains reusable packages marked as used
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
    group: MarmotGroup;
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
    await this.keyPackages.finalizeConsumptions();
    const candidates = await this.keyPackages.selectForWelcome(welcome);
    const { group, consumedKeyPackageRef } = await this.groups.joinFromWelcome({
      welcome,
      candidates,
      ciphersuiteImpl,
      beforeAdopt: (groupId, ref, adoptionTag) =>
        this.keyPackages.recordConsumption(groupId, ref, adoptionTag),
    });

    // Receipt retirement follows durable group adoption. A crash between stores
    // delays cleanup until manager startup/retry; it never consumes rejected keys.
    if (consumedKeyPackageRef) await this.keyPackages.finalizeConsumptions();

    log("joined group %s", group.idStr);

    // refs/marmot/protocol-core/joining.md: callers are responsible for calling
    // group.selfUpdate() after joining to rotate leaf key material for forward
    // secrecy. Doing it automatically here caused the joining member to fork off
    // to a new epoch before other members could ingest the commit.

    return { group };
  }
}
