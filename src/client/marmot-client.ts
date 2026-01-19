import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  Capabilities,
  ClientState,
  CryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
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
  public cryptoProvider?: CryptoProvider;

  /** Internal store for group classes */
  private groups = new Map<string, MarmotGroup>();

  constructor(options: MarmotClientOptions) {
    this.signer = options.signer;
    this.capabilities = options.capabilities ?? defaultCapabilities();
    this.groupStore = options.groupStore;
    this.keyPackageStore = options.keyPackageStore;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider;
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

  /** Gets a group from the cache or loads it from the store */
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

  /** Adds a group to the client */
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

    // Save the group to the store
    await this.groupStore.add(state);

    // Add the group to the cache
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
}
