/** @module @category Core - Welcome */
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  type AuthenticationService,
  CiphersuiteImpl,
  type ClientState,
  type GroupInfo,
  type GroupInfoExtension,
  joinGroupWithExtensions,
  KeyPackage,
  nodeTypes,
  PrivateKeyPackage,
  type Welcome,
} from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { bytesEqual } from "./components/bytes.js";
import { type MarmotGroupView, getMarmotGroupView } from "./client-state.js";
import { getWelcome } from "./welcome-event.js";

/** The result of {@link joinWelcomeWithAuthor}. */
export interface WelcomeJoinResult {
  /** The joined MLS state. Nothing has been persisted. */
  state: ClientState;
  /** Extensions carried by the Welcome's GroupInfo (e.g. `ratchet_tree`). */
  groupInfoExtensions: GroupInfoExtension[];
  /**
   * Leaf index of the GroupInfo signer, i.e. the Welcome author
   * (`protocol-core/joining.md` receiving-flow step 6).
   */
  authorLeafIndex: number;
}

/**
 * Runs the MLS Welcome join and also identifies the Welcome author: the leaf
 * that signed the GroupInfo.
 *
 * ts-mls verifies the GroupInfo signature against `tree[gi.signer]` but does
 * not return `gi.signer`. It does call `authService.validateCredential` for
 * that signer leaf before anything else, and right before checking the
 * GroupInfo signature against that leaf's key. So the first key passed to the
 * auth service is the verified signer's signature key. The author leaf is then
 * found by that key; MLS requires signature keys to be unique across leaves.
 * If the key cannot be matched to exactly one leaf, the join fails closed.
 *
 * Nothing is persisted, and the KeyPackage is not consumed.
 */
export async function joinWelcomeWithAuthor({
  welcome,
  keyPackage,
  privateKeys,
  ciphersuiteImpl,
  authService = marmotAuthService,
}: {
  welcome: Welcome;
  keyPackage: KeyPackage;
  privateKeys: PrivateKeyPackage;
  ciphersuiteImpl: CiphersuiteImpl;
  authService?: AuthenticationService;
}): Promise<WelcomeJoinResult> {
  let signerKey: Uint8Array | undefined;
  const capturing: AuthenticationService = {
    validateCredential(credential, signaturePublicKey) {
      signerKey ??= signaturePublicKey;
      return authService.validateCredential(credential, signaturePublicKey);
    },
  };

  const { state, groupInfoExtensions } = await joinGroupWithExtensions({
    context: {
      cipherSuite: ciphersuiteImpl,
      authService: capturing,
      externalPsks: {},
    },
    welcome,
    keyPackage,
    privateKeys,
  });

  const matches: number[] = [];
  if (signerKey !== undefined) {
    state.ratchetTree.forEach((node, nodeIndex) => {
      if (
        nodeIndex % 2 === 0 &&
        node?.nodeType === nodeTypes.leaf &&
        bytesEqual(node.leaf.signaturePublicKey, signerKey)
      )
        matches.push(nodeIndex / 2);
    });
  }
  if (matches.length !== 1)
    throw new Error(
      "Welcome author could not be identified from the GroupInfo signer",
    );

  return { state, groupInfoExtensions, authorLeafIndex: matches[0]! };
}

/**
 * Decrypts the {@link GroupInfo} from a Welcome message using the provided key package,
 * without performing a full group join.
 *
 * This is lighter than `joinGroup` — it stops after decrypting the group secrets
 * and group info, giving access to `groupContext` (group ID, epoch, extensions) and
 * `GroupInfo`-level extensions (ratchet tree, external pub).
 *
 * @returns The decrypted GroupInfo
 * @throws Error if the key package does not match any secret in the welcome
 */
export async function readWelcomeGroupInfo({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  /** The MLS Welcome message (or a kind 444 Rumor) */
  welcome: Welcome | Rumor;
  /** The full key package (public + private) used to receive the invite */
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  /** The ciphersuite implementation */
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<GroupInfo> {
  // Unwrap welcome rumor if provided
  if (isRumor(welcome)) welcome = getWelcome(welcome);

  try {
    const { state, groupInfoExtensions, authorLeafIndex } =
      await joinWelcomeWithAuthor({
        welcome,
        keyPackage: keyPackage.publicPackage,
        privateKeys: keyPackage.privatePackage,
        ciphersuiteImpl,
      });

    // `signer` is the real GroupInfo signer (the Welcome author), not the
    // joiner's own leaf. The signature itself is not exposed by ts-mls.
    return {
      groupContext: state.groupContext,
      extensions: groupInfoExtensions,
      confirmationTag: state.confirmationTag,
      signer: authorLeafIndex,
      signature: new Uint8Array(),
    };
  } catch (err) {
    throw new Error(
      `Failed to decrypt group secrets: key package does not match this welcome (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Reads the {@link MarmotGroupView} from a Welcome message using the provided
 * key package, without performing a full group join.
 *
 * Convenience wrapper around {@link readWelcomeGroupInfo} that projects the
 * app-component state from `groupInfo.groupContext.extensions`.
 *
 * @returns The group view, or null if no app components are present
 */
export async function readWelcomeMarmotGroupView({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  /** The MLS Welcome message (or a kind 444 Rumor) */
  welcome: Welcome | Rumor;
  /** The full key package (public + private) used to receive the invite */
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  /** The ciphersuite implementation */
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<MarmotGroupView | null> {
  const groupInfo = await readWelcomeGroupInfo({
    welcome,
    keyPackage,
    ciphersuiteImpl,
  });

  return getMarmotGroupView(groupInfo);
}
