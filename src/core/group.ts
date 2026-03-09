import { randomBytes } from "@noble/hashes/utils.js";
import { CiphersuiteImpl, createGroup as MLSCreateGroup } from "ts-mls";
import { ClientState } from "ts-mls/clientState.js";
import { GroupContextExtension } from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { CompleteKeyPackage } from "./key-package.js";
import { marmotGroupDataToExtension } from "./marmot-group-data.js";
import { MarmotGroupData } from "./protocol.js";

export interface CreateGroupParams {
  /** Creator's complete key package (public + private) */
  creatorKeyPackage: CompleteKeyPackage;
  /** Marmot Group Data configuration */
  marmotGroupData: MarmotGroupData;
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
    marmotGroupData,
    extensions = [],
    ciphersuiteImpl,
  } = params;
  // MIP-01: MLS group_id MUST be private and distinct from the public
  // nostr_group_id stored in the Marmot Group Data extension.
  const groupId = randomBytes(32);
  // Always include Marmot Group Data as a GroupContext extension.
  const marmotExtension = marmotGroupDataToExtension(marmotGroupData);

  // Combine all extensions (Marmot extension + any additional extensions)
  const groupExtensions = [marmotExtension, ...extensions];

  // ts-mls v2: createGroup takes a single params object with `context`.
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

  return {
    clientState,
  };
}

export type SimpleGroupOptions = {
  description?: string;
  adminPubkeys?: string[];
  relays?: string[];
};

export async function createSimpleGroup(
  creatorKeyPackage: CompleteKeyPackage,
  ciphersuiteImpl: CiphersuiteImpl,
  groupName: string = "New Group",
  options?: SimpleGroupOptions,
): Promise<CreateGroupResult> {
  const marmotGroupData: MarmotGroupData = {
    version: 2,
    nostrGroupId: randomBytes(32),
    name: groupName,
    description: options?.description || "",
    adminPubkeys: [...new Set(options?.adminPubkeys || [])],
    relays: options?.relays || [],
    imageHash: new Uint8Array(0),
    imageKey: new Uint8Array(0),
    imageNonce: new Uint8Array(0),
    imageUploadKey: new Uint8Array(0),
  };

  return createGroup({
    creatorKeyPackage,
    marmotGroupData,
    ciphersuiteImpl,
  });
}
