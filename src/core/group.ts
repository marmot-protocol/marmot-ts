/** @module @category Core - Group */
import { randomBytes } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  ClientState,
  ComponentData,
  appDataDictionaryExtensionType,
  createGroup as MLSCreateGroup,
  GroupContextExtension,
} from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { defaultMarmotClientConfig } from "./client-config.js";
import { marmotRequiredCapabilitiesExtension } from "./capabilities.js";
import {
  adminPolicyEntry,
  encryptedMediaEntry,
  getEncryptedMediaPolicy,
  GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
  type EncryptedMediaPolicyV2,
  AppComponentId,
  appComponentsEntry,
  DEFAULT_GROUP_COMPONENT_IDS,
  GROUP_LIFECYCLE_COMPONENT_ID,
  groupLifecycleEntry,
  groupProtocolLifecycleValues,
  groupProfileEntry,
  makeAppComponentsExtension,
  nostrRoutingEntry,
} from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
import { CompleteKeyPackage } from "./key-package.js";

/** Thrown when caller-supplied GroupContext extensions are invalid. */
export class InvalidGroupContextExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGroupContextExtensionError";
  }
}

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
  /**
   * Additional group context extensions (optional), with unique extension types.
   * Do not supply `app_data_dictionary`; dictionary data belongs in {@link components}.
   */
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

  const extensionTypes = new Set<number>();
  for (const extension of extensions) {
    if (extension.extensionType === appDataDictionaryExtensionType) {
      throw new InvalidGroupContextExtensionError(
        "app_data_dictionary must not be supplied in extensions; put dictionary data in components",
      );
    }
    if (extensionTypes.has(extension.extensionType)) {
      throw new InvalidGroupContextExtensionError(
        `Duplicate group context extension type: ${extension.extensionType}`,
      );
    }
    extensionTypes.add(extension.extensionType);
  }

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
  // Keep the dictionary last, matching MDK: app_data_update replaces it in
  // place in ts-mls, while OpenMLS removes it and appends it to the end.
  const groupExtensions = [
    ...(hasRequiredCapabilities ? [] : [marmotRequiredCapabilitiesExtension()]),
    ...extensions,
    appDataExtension,
  ];

  const mediaPolicy = getEncryptedMediaPolicy(groupExtensions);
  if (
    requiredIds.includes(GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID) &&
    !mediaPolicy
  )
    throw new InvalidGroupContextExtensionError(
      "Required encrypted-media v2 policy is missing",
    );

  const clientState = await MLSCreateGroup({
    context: {
      cipherSuite: ciphersuiteImpl,
      authService: marmotAuthService,
      clientConfig: defaultMarmotClientConfig,
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
  encryptedMedia?: EncryptedMediaPolicyV2;
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

  if (options?.encryptedMedia)
    components.push(encryptedMediaEntry(options.encryptedMedia));

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
