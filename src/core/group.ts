/** @module @category Core - Group */
import { randomBytes } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  ClientState,
  ComponentData,
  createGroup as MLSCreateGroup,
  GroupContextExtension,
} from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import {
  adminPolicyEntry,
  AppComponentId,
  appComponentsEntry,
  groupProfileEntry,
  makeAppComponentsExtension,
  nostrRoutingEntry,
} from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
import { CompleteKeyPackage } from "./key-package.js";

export interface CreateGroupParams {
  /** Creator's complete key package (public + private) */
  creatorKeyPackage: CompleteKeyPackage;
  /**
   * Initial app components seeded into the group's `app_data_dictionary`
   * GroupContext extension. The `app_components` (`0x0001`) advertising entry is
   * added automatically from {@link requiredComponentIds}.
   */
  components: ComponentData[];
  /**
   * Component ids advertised in the `app_components` (`0x0001`) entry. Defaults
   * to the ids present in {@link components}.
   */
  requiredComponentIds?: AppComponentId[];
  /** Additional group context extensions (optional) */
  extensions?: GroupContextExtension[];
  /** Cipher suite implementation for cryptographic operations */
  ciphersuiteImpl: CiphersuiteImpl;
}

export interface CreateGroupResult {
  /** The ClientState for the created group */
  clientState: ClientState;
}

export async function createGroup(
  params: CreateGroupParams,
): Promise<CreateGroupResult> {
  const {
    creatorKeyPackage,
    components,
    requiredComponentIds,
    extensions = [],
    ciphersuiteImpl,
  } = params;

  // The MLS group_id MUST be private and distinct from the public
  // nostr_group_id carried by the transport.nostr.routing component.
  const groupId = randomBytes(32);

  // Advertise the required component ids (defaults to whatever was provided),
  // then seed each component's state into the app_data_dictionary extension.
  const requiredIds =
    requiredComponentIds ?? components.map((c) => c.componentId);
  const appDataExtension = makeAppComponentsExtension([
    appComponentsEntry(requiredIds),
    ...components,
  ]);

  const groupExtensions = [appDataExtension, ...extensions];

  const clientState = await MLSCreateGroup({
    context: {
      cipherSuite: ciphersuiteImpl,
      authService: marmotAuthService,
    },
    groupId,
    keyPackage: creatorKeyPackage.publicPackage,
    privateKeyPackage: creatorKeyPackage.privatePackage,
    extensions: groupExtensions,
  });

  return { clientState };
}

export type SimpleGroupOptions = {
  description?: string;
  adminPubkeys?: string[];
  relays?: string[];
};

/**
 * Creates a Marmot v2 group seeded with the default group components: a
 * `group.profile.v1` (name + description), an `admin-policy.v1` (the creator
 * plus any extra admins), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
 */
export async function createSimpleGroup(
  creatorKeyPackage: CompleteKeyPackage,
  ciphersuiteImpl: CiphersuiteImpl,
  groupName: string = "New Group",
  options?: SimpleGroupOptions,
): Promise<CreateGroupResult> {
  // The creator is always an admin (matches darkmatter's create flow).
  const creatorPubkey = getCredentialPubkey(
    creatorKeyPackage.publicPackage.leafNode.credential,
  );
  const adminPubkeys = [
    ...new Set([creatorPubkey, ...(options?.adminPubkeys ?? [])]),
  ];

  const components: ComponentData[] = [
    groupProfileEntry({
      name: groupName,
      description: options?.description ?? "",
    }),
    adminPolicyEntry(adminPubkeys),
  ];

  const relays = options?.relays ?? [];
  if (relays.length > 0) {
    components.push(
      nostrRoutingEntry({ nostrGroupId: randomBytes(32), relays }),
    );
  }

  return createGroup({
    creatorKeyPackage,
    components,
    ciphersuiteImpl,
  });
}
