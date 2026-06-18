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
import { SerializedClientState } from "../core/client-state.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { getWelcome, readWelcomeGroupInfo } from "../core/welcome.js";
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
import { InviteManager, StoredInviteEntry } from "./invite-manager.js";
import type { StoredKeyPackage } from "./key-package-manager.js";
import { KeyPackageManager } from "./key-package-manager.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";

const log = logger.extend("client");

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
  /** The backend for key package private material and publish tracking */
  keyPackageStore: GenericKeyValueStore<StoredKeyPackage>;
  /** Key value store for the {@link InviteManager} class, if non is provided an {@link InMemoryKeyValueStore} is used */
  inviteStore?: GenericKeyValueStore<StoredInviteEntry>;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
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
    this.keyPackages = new KeyPackageManager({
      store: options.keyPackageStore,
      signer: options.signer,
      accountProofSigner: options.accountProofSigner,
      network: options.network,
      clientId: options.clientId,
    });

    const historyFactory = (
      "historyFactory" in options ? options.historyFactory : undefined
    ) as GroupHistoryFactory<THistory>;
    const mediaFactory = (
      "mediaFactory" in options ? options.mediaFactory : undefined
    ) as GroupMediaFactory<TMedia>;

    this.groups = new GroupsManager<THistory, TMedia>({
      store: options.groupStateStore,
      signer: this.signer,
      accountProofSigner: options.accountProofSigner,
      network: this.network,
      cryptoProvider: this.cryptoProvider,
      historyFactory,
      mediaFactory,
    });

    this.invites = new InviteManager({
      signer: this.signer,
      store: options.inviteStore || new InMemoryKeyValueStore(),
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

    // MIP-02 SHOULD: callers are responsible for calling group.selfUpdate() after
    // joining to rotate leaf key material for forward secrecy. Doing it automatically
    // here caused the joining member to fork off to a new epoch before other members
    // could ingest the commit.

    return { group };
  }
}
