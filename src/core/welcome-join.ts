/** @module @category Core - Welcome */
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  CiphersuiteImpl,
  type GroupInfo,
  joinGroup,
  KeyPackage,
  PrivateKeyPackage,
  type Welcome,
} from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { type MarmotGroupView, getMarmotGroupView } from "./client-state.js";
import { getWelcome } from "./welcome-event.js";

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
    const clientState = await joinGroup({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
        externalPsks: {},
      },
      welcome,
      keyPackage: keyPackage.publicPackage,
      privateKeys: keyPackage.privatePackage,
    });

    return {
      groupContext: clientState.groupContext,
      extensions: [],
      confirmationTag: clientState.confirmationTag,
      signer: clientState.privatePath.leafIndex,
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
