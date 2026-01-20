import { randomBytes } from "@noble/hashes/utils.js";
import {
  CiphersuiteImpl,
  createGroup as MLSCreateGroup,
  type GroupContextExtension,
} from "ts-mls";
import { ClientState } from "ts-mls/clientState.js";
import { CompleteKeyPackage } from "./key-package.js";
import { marmotGroupDataToExtension } from "./marmot-group-data.js";
import { MarmotGroupData } from "./protocol.js";
import { marmotAuthService } from "./auth-service.js";

/**
 * Parameters for creating a new MLS group.
 */
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

/**
 * Result of a successful group creation operation.
 */
export interface CreateGroupResult {
  /** The ClientState for the created group */
  clientState: ClientState;
}

/**
 * Creates a new MLS group with Marmot Group Data Extension.
 *
 * This function orchestrates the creation of an MLS group with the creator as the sole member,
 * including proper Marmot Group Data Extension integration and RFC 9420 compliance.
 *
 * @param params - Parameters for group creation
 * @returns Promise resolving to the created group and related messages
 * @throws Error if group creation fails or parameters are invalid
 */
export async function createGroup(
  params: CreateGroupParams,
): Promise<CreateGroupResult> {
  const {
    creatorKeyPackage,
    marmotGroupData,
    extensions = [],
    ciphersuiteImpl,
  } = params;
  const groupId = marmotGroupData.nostrGroupId;
  // Create Marmot Group Data Extension
  const marmotExtension = marmotGroupDataToExtension(marmotGroupData);

  // Combine all extensions (Marmot extension + any additional extensions)
  const groupExtensions = [marmotExtension, ...extensions];

  // Create the MLS group using ts-mls primitives and capture the ClientState
  const clientState = await MLSCreateGroup({
    context: { cipherSuite: ciphersuiteImpl, authService: marmotAuthService },
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

/**
 * Creates a simple group with minimal configuration for testing.
 *
 * @param creatorKeyPackage - Creator's key package
 * @param ciphersuiteImpl - Cipher suite implementation
 * @param groupName - Optional group name
 * @returns Promise resolving to the created group
 */
export async function createSimpleGroup(
  creatorKeyPackage: CompleteKeyPackage,
  ciphersuiteImpl: CiphersuiteImpl,
  groupName: string = "New Group",
  options?: SimpleGroupOptions,
): Promise<CreateGroupResult> {
  const marmotGroupData: MarmotGroupData = {
    version: 1,
    nostrGroupId: randomBytes(32),
    name: groupName,
    description: options?.description || "",
    adminPubkeys: options?.adminPubkeys || [],
    relays: options?.relays || [],
    imageHash: null,
    imageKey: null,
    imageNonce: null,
  };

  return createGroup({
    creatorKeyPackage,
    marmotGroupData,
    ciphersuiteImpl,
  });
}
