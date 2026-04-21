import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import {
  Capabilities,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  GroupInfo,
  joinGroup,
  KeyPackage,
  PrivateKeyPackage,
  Welcome,
} from "ts-mls";
import { marmotAuthService } from "../core/auth-service.js";
import { SerializedClientState } from "../core/client-state.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { isRumorLike } from "../core/nostr.js";
import {
  getWelcome,
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
import type { StoredKeyPackage } from "./key-package-manager.js";
import { KeyPackageManager } from "./key-package-manager.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";

const log = logger.extend("client");

export type MarmotClientOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /** The backend to store and load the groups from */
  groupStateStore: GenericKeyValueStore<SerializedClientState>;
  /** The backend for key package private material and publish tracking */
  keyPackageStore: GenericKeyValueStore<StoredKeyPackage>;
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
  /** The backend storing serialized group state bytes */
  readonly groupStateStore: GenericKeyValueStore<SerializedClientState>;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;
  /** Manages key package lifecycle: local storage, publishing, and rotation */
  readonly keyPackages: KeyPackageManager;
  /** Manages group lifecycle: persistence, caching, creation, loading, leaving */
  readonly groups: GroupsManager<THistory, TMedia>;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  constructor(options: MarmotClientOptions<THistory, TMedia>) {
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.groupStateStore = options.groupStateStore;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.keyPackages = new KeyPackageManager({
      store: options.keyPackageStore,
      signer: options.signer,
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
      store: this.groupStateStore,
      signer: this.signer,
      network: this.network,
      cryptoProvider: this.cryptoProvider,
      historyFactory,
      mediaFactory,
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
    const welcome = isRumorLike(welcomeRumor)
      ? getWelcome(welcomeRumor)
      : welcomeRumor;
    const refs = getWelcomeKeyPackageRefs(welcome);

    for (const ref of refs) {
      const stored = await this.keyPackages.get(ref);
      if (!stored?.privatePackage) continue;

      try {
        const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
          stored.publicPackage.cipherSuite,
        );
        return await readWelcomeGroupInfo({
          welcome,
          keyPackage: stored,
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
   * @param options - Options for joining from a Welcome message
   * @param options.welcomeRumor - The unwrapped kind 444 rumor event containing the Welcome message
   * @returns Promise resolving to the joined group
   * @throws Error if no matching KeyPackage is found or if joining fails
   */
  async joinGroupFromWelcome(options: { welcomeRumor: Rumor }): Promise<{
    group: MarmotGroup<THistory, TMedia>;
  }> {
    const { welcomeRumor } = options;
    log("joining group from welcome rumor %s", welcomeRumor.id);

    const welcome = getWelcome(welcomeRumor);

    // ts-mls v2: welcome.cipherSuite is a numeric CiphersuiteId
    const ciphersuiteImpl = await this.cryptoProvider.getCiphersuiteImpl(
      welcome.cipherSuite,
    );

    const allKeyPackages = await this.keyPackages.list();
    const candidatePackages: Array<{
      publicPackage: KeyPackage;
      privatePackage: PrivateKeyPackage;
      keyPackageRef: Uint8Array;
      hasMatchingSecret: boolean;
    }> = [];

    // Collect all key packages with matching cipher suite and compute their KeyPackageRef
    // KeyPackageRef is used to identify which encrypted secret in the welcome is ours (RFC 9420)
    for (const keyPackage of allKeyPackages) {
      if (keyPackage.publicPackage.cipherSuite !== welcome.cipherSuite) {
        continue;
      }

      const privateKeyPackage = await this.keyPackages.getPrivateKey(
        keyPackage.keyPackageRef,
      );
      if (!privateKeyPackage) continue;

      // Check if this key package's ref matches any secret in the welcome
      // This is the RFC 9420 KeyPackageRef matching semantics
      const hasMatchingSecret = welcome.secrets.some((secret) =>
        secret.newMember.length === keyPackage.keyPackageRef.length
          ? secret.newMember.every(
              (val, idx) => val === keyPackage.keyPackageRef[idx],
            )
          : false,
      );

      candidatePackages.push({
        publicPackage: keyPackage.publicPackage,
        privatePackage: privateKeyPackage,
        keyPackageRef: keyPackage.keyPackageRef,
        hasMatchingSecret,
      });
    }

    if (candidatePackages.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    // Prioritize packages that have matching secrets in the welcome
    // This ensures we try the most likely candidates first (RFC 9420 compliance)
    const prioritizedKeyPackages = [
      ...candidatePackages.filter((p) => p.hasMatchingSecret),
      ...candidatePackages.filter((p) => !p.hasMatchingSecret),
    ];

    let clientState: ClientState | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;

    for (const keyPackage of prioritizedKeyPackages) {
      try {
        // In v2, joinGroup takes a single params object with context
        clientState = await joinGroup({
          context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            externalPsks: {},
          },
          welcome,
          keyPackage: keyPackage.publicPackage,
          privateKeys: keyPackage.privatePackage,
        });
        consumedKeyPackageRef = keyPackage.keyPackageRef;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (!clientState) {
      const errorMessage = lastError
        ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
        : "Failed to join group with any matching key package";
      throw new Error(errorMessage);
    }

    // Mark the consumed key package as used. Callers can later list used packages
    // with (await client.keyPackages.list()).filter(p => p.used) and rotate them
    // via client.keyPackages.rotate(ref) to publish fresh ones to relays.
    if (consumedKeyPackageRef) {
      await this.keyPackages.markUsed(consumedKeyPackageRef);
    }

    // Persist and register the joined group via the groups manager. The
    // manager emits `joined` on itself; listen on `client.groups` to observe it.
    const group = await this.groups.adoptClientState(clientState, {
      emit: "joined",
    });
    log("joined group %s", group.idStr);

    // MIP-02 SHOULD: callers are responsible for calling group.selfUpdate() after
    // joining to rotate leaf key material for forward secrecy. Doing it automatically
    // here caused the joining member to fork off to a new epoch before other members
    // could ingest the commit.

    return { group };
  }
}
