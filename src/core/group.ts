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
import { marmotRequiredCapabilitiesExtension } from "./capabilities.js";
import {
  adminPolicyEntry,
  AppComponentId,
  appComponentsEntry,
  DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS,
  DEFAULT_GROUP_COMPONENT_IDS,
  type EncryptedMediaPolicyV2,
  encryptedMediaV2BlossomDefault,
  encryptedMediaV2Entry,
  GROUP_LIFECYCLE_COMPONENT_ID,
  groupLifecycleEntry,
  groupProtocolLifecycleValues,
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
  const requiredIds = [
    ...new Set([
      ...DEFAULT_GROUP_COMPONENT_IDS,
      ...(requiredComponentIds ?? components.map((c) => c.componentId)),
    ]),
  ];
  const initialComponents = components.some(
    (component) => component.componentId === GROUP_LIFECYCLE_COMPONENT_ID,
  )
    ? components
    : [...components, groupLifecycleEntry(groupProtocolLifecycleValues.active)];
  const appDataExtension = makeAppComponentsExtension([
    appComponentsEntry(requiredIds),
    ...initialComponents,
  ]);

  // Every Marmot group declares the protocol-mandatory required_capabilities so
  // MLS enforces them on every add (capability-negotiation.md §5.2). A caller
  // may override by supplying their own required_capabilities in `extensions`.
  const hasRequiredCapabilities = extensions.some(
    (e) =>
      e.extensionType === marmotRequiredCapabilitiesExtension().extensionType,
  );
  const groupExtensions = [
    appDataExtension,
    ...(hasRequiredCapabilities ? [] : [marmotRequiredCapabilitiesExtension()]),
    ...extensions,
  ];

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
  /**
   * The group's `marmot.group.encrypted-media.v2` (`0x800b`) policy. Defaults
   * to a Blossom policy over {@link DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS},
   * which is what MDK puts in every new current-profile group. Pass `false`
   * for a non-media group (`protocol-core/group-setup.md` lets it omit the
   * component), e.g. to invite peers whose KeyPackages lack `0x800b`.
   */
  encryptedMedia?: EncryptedMediaPolicyV2 | false;
};

/**
 * Creates a Marmot v2 group seeded with the default group components: a
 * `group.profile.v1` (name + description), an `admin-policy.v1` (the creator
 * plus any extra admins), a `group.encrypted-media.v2` media policy (unless
 * `options.encryptedMedia` is `false`), and — when relays are supplied — a
 * `transport.nostr.routing.v1` carrying a fresh nostr group id and the relays.
 * Every seeded component is listed as required, so invitees must advertise
 * support for it (MDK requires `0x800b` the same way).
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

  // Media-capable profile: new groups carry and require 0x800b, like MDK
  // (`protocol-core/group-setup.md` "Creation flow"; MDK
  // `encrypted_media_component_for_new_group`).
  if (options?.encryptedMedia !== false) {
    components.push(
      encryptedMediaV2Entry(
        options?.encryptedMedia ??
          encryptedMediaV2BlossomDefault([
            ...DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS,
          ]),
      ),
    );
  }

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
