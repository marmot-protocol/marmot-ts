import { bytesToHex } from "@noble/hashes/utils.js";
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import {
  Capabilities,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  KeyPackage,
  makePskIndex,
  PrivateKeyPackage,
} from "ts-mls";
import {
  CiphersuiteId,
  CiphersuiteName,
  getCiphersuiteFromId,
} from "ts-mls/crypto/ciphersuite.js";
import { createCredential } from "../core/credential.js";
import { defaultCapabilities } from "../core/default-capabilities.js";
import { createSimpleGroup, SimpleGroupOptions } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { getWelcome } from "../core/welcome.js";
import { GroupStore } from "../store/group-store.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { MarmotGroup } from "./group/marmot-group.js";
import { NostrNetworkInterface } from "./nostr-interface.js";

export type MarmotClientOptions = {
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The capabilities to use for the client */
  capabilities?: Capabilities;
  /** The backend to store and load the groups from */
  groupStore: GroupStore;
  /** The backend to store and load the key packages from */
  keyPackageStore: KeyPackageStore;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** The nostr relay pool to use for the client. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
};

export class MarmotClient {
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** The capabilities to use for the client */
  readonly capabilities: Capabilities;
  /** The backend to store and load the groups from */
  readonly groupStore: GroupStore;
  /** The backend to store and load the key packages from */
  readonly keyPackageStore: KeyPackageStore;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;

  /** Internal store for group classes */
  private groups = new Map<string, MarmotGroup>();

  constructor(options: MarmotClientOptions) {
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.groupStore = options.groupStore;
    this.keyPackageStore = options.keyPackageStore;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
  }

  /** Get a ciphersuite implementation from a name or id */
  private async getCiphersuiteImpl(name: CiphersuiteName | CiphersuiteId = 1) {
    const suite =
      typeof name === "string"
        ? getCiphersuiteFromName(name)
        : getCiphersuiteFromId(name);

    // Get a new ciphersuite implementation
    return await getCiphersuiteImpl(suite, this.cryptoProvider);
  }

  /** Gets a group from cache or loads it from store */
  async getGroup(groupId: Uint8Array | string) {
    const groupIdHex =
      typeof groupId === "string" ? groupId : bytesToHex(groupId);
    let group = this.groups.get(groupIdHex);
    if (!group) {
      group = await MarmotGroup.load(groupId, {
        store: this.groupStore,
        signer: this.signer,
        cryptoProvider: this.cryptoProvider,
        network: this.network,
      });

      // Save group to cache
      this.groups.set(groupIdHex, group);
    }

    return group;
  }

  /** Adds a group to client */
  async addGroup(state: ClientState): Promise<MarmotGroup> {
    // Get the group's ciphersuite implementation
    const cipherSuite = await getCiphersuiteImpl(
      getCiphersuiteFromName(state.groupContext.cipherSuite),
      this.cryptoProvider,
    );

    const group = new MarmotGroup(state, {
      ciphersuite: cipherSuite,
      store: this.groupStore,
      signer: this.signer,
      network: this.network,
    });

    // Save group to store
    await this.groupStore.add(state);

    // Add group to cache
    this.groups.set(bytesToHex(state.groupContext.groupId), group);

    return group;
  }

  /** Creates a new simple group */
  async createGroup(
    name: string,
    options?: SimpleGroupOptions & {
      ciphersuite?: CiphersuiteName | CiphersuiteId;
    },
  ): Promise<Uint8Array> {
    const ciphersuiteImpl = await this.getCiphersuiteImpl(options?.ciphersuite);

    // generate a new key package
    const pubkey = await this.signer.getPublicKey();
    const credential = await createCredential(pubkey);
    const keyPackage = await generateKeyPackage({
      credential,
      ciphersuiteImpl,
    });

    const { clientState } = await createSimpleGroup(
      keyPackage,
      ciphersuiteImpl,
      name,
      // Always include the creator as an admin
      { ...options, adminPubkeys: [pubkey, ...(options?.adminPubkeys || [])] },
    );

    // Save the group to the store
    await this.groupStore.add(clientState);

    // Return the group id
    return clientState.groupContext.groupId;
  }

  /**
   * Joins a group from a Welcome message received via NIP-59 gift wrap.
   *
   * This method:
   * 1. Decodes the Welcome message from the kind 444 event
   * 2. Finds the matching local KeyPackage private material from the store
   * 3. Calls ts-mls joinGroup() to create a new ClientState
   * 4. Persists the resulting ClientState
   * 5. Returns a MarmotGroup instance ready to ingest group events
   *
   * @param options - Options for joining from a Welcome message
   * @param options.welcomeRumor - The unwrapped kind 444 rumor event containing the Welcome message
   * @param options.keyPackageEventId - Optional ID of the KeyPackage event used for the add (for finding the right key package)
   * @returns Promise resolving to a MarmotGroup instance
   * @throws Error if no matching KeyPackage is found or if joining fails
   */
  async joinGroupFromWelcome(options: {
    welcomeRumor: Rumor;
    keyPackageEventId?: string;
  }): Promise<MarmotGroup> {
    const { welcomeRumor, keyPackageEventId: explicitKeyPackageEventId } =
      options;

    // Decode the Welcome message from the kind 444 event
    const welcome = getWelcome(welcomeRumor);

    // Extract keyPackageEventId from welcome rumor tags if not explicitly provided
    // The keyPackageEventId is stored as an "e" tag in the welcome message per MIP-00
    const keyPackageEventId =
      explicitKeyPackageEventId ??
      welcomeRumor.tags.find((tag) => tag[0] === "e")?.[1];

    // Get the ciphersuite implementation for the Welcome
    const ciphersuiteImpl = await this.getCiphersuiteImpl(welcome.cipherSuite);

    // Find all local KeyPackage candidates with matching cipherSuite
    const allKeyPackages = await this.keyPackageStore.list();
    const candidatePackages: Array<{
      publicPackage: KeyPackage;
      privatePackage: PrivateKeyPackage;
      keyPackageRef: Uint8Array;
      hasMatchingSecret: boolean;
    }> = [];

    // Collect all key packages with matching cipher suite and compute their KeyPackageRef
    // KeyPackageRef is used to identify which encrypted secret in the welcome is ours (RFC 9420)
    for (const keyPackage of allKeyPackages) {
      if (keyPackage.publicPackage.cipherSuite !== welcome.cipherSuite)
        continue;

      const privatekeyPackage = await this.keyPackageStore.getPrivateKey(
        keyPackage.keyPackageRef,
      );
      if (!privatekeyPackage) continue;

      // Check if this key package's ref matches any secret in the welcome
      // This is the RFC 9420 KeyPackageRef matching semantics
      const hasMatchingSecret = welcome.secrets.some(
        (secret) =>
          secret.newMember.length === keyPackage.keyPackageRef.length &&
          secret.newMember.every(
            (val, idx) => val === keyPackage.keyPackageRef[idx],
          ),
      );

      candidatePackages.push({
        publicPackage: keyPackage.publicPackage,
        privatePackage: privatekeyPackage,
        keyPackageRef: keyPackage.keyPackageRef,
        hasMatchingSecret,
      });
    }

    if (candidatePackages.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    // Log the keyPackageEventId for debugging if available
    if (keyPackageEventId) {
      console.log(
        `Welcome message references key package event: ${keyPackageEventId}`,
      );
    }

    // Prioritize packages that have matching secrets in the welcome
    // This ensures we try the most likely candidates first (RFC 9420 compliance)
    const prioritizedKeyPackages = [
      ...candidatePackages.filter((p) => p.hasMatchingSecret),
      ...candidatePackages.filter((p) => !p.hasMatchingSecret),
    ];

    // Create an empty PSK index (no pre-shared keys for now)
    const pskIndex = makePskIndex(undefined, {});

    // Try each key package in priority order until one successfully decrypts the Welcome message
    let clientState: any = null;
    let lastError: Error | null = null;

    for (const keyPackage of prioritizedKeyPackages) {
      try {
        // Attempt to join the group with this key package
        // The joinGroup function internally uses KeyPackageRef to find the correct secret
        clientState = await joinGroup(
          welcome,
          keyPackage.publicPackage,
          keyPackage.privatePackage,
          pskIndex,
          ciphersuiteImpl,
        );
        // If successful, break out of the loop
        break;
      } catch (error) {
        // Store the error and continue to the next candidate
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue trying with the next key package
      }
    }

    if (!clientState) {
      // All key packages failed, throw the last error encountered
      const errorMessage = lastError
        ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
        : "Failed to join group with any matching key package";
      throw new Error(errorMessage);
    }

    // Save the group state to the store
    await this.groupStore.add(clientState);

    // Create and cache the MarmotGroup instance
    const group = new MarmotGroup(clientState, {
      ciphersuite: ciphersuiteImpl,
      store: this.groupStore,
      signer: this.signer,
      network: this.network,
    });

    // Add the group to the cache
    this.groups.set(bytesToHex(clientState.groupContext.groupId), group);

    return group;
  }
}
