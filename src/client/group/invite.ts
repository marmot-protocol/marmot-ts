/** @module @category Client - Group */
import type { NostrEvent } from "applesauce-core/helpers/event";

import { getCredentialPubkey } from "../../core/credential.js";
import {
  getKeyPackage,
  getKeyPackageLifetime,
} from "../../core/key-package-event.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  KEY_PACKAGE_MLS_VERSION_TAG,
} from "../../core/protocol.js";
import { getSingletonTagValue } from "../../utils/tag-cardinality.js";
import {
  isLifetimeCurrentWithGrace,
  isLifetimeWithinCap,
} from "../../utils/timestamp.js";
import type { GroupSessionSendIntent } from "../session/group-effects.js";
import {
  defaultVerifyEvent,
  safeVerifyEvent,
  type VerifyEventMethod,
} from "../verify.js";
import { proposeInviteUser } from "./proposals/invite-user.js";

/** Options for {@link createInviteIntent}. */
export type CreateInviteIntentOptions = {
  /** The invitee's KeyPackage event (kind 30443). */
  keyPackageEvent: NostrEvent;
  /**
   * The committing member's Nostr public key (hex) — usually the local signer.
   * Recorded as the commit actor on the resulting group event.
   */
  actorPubkey: string;
  /**
   * Injectable event verifier for the 30443 trust boundary (SEC-01), applied
   * to `keyPackageEvent` before it is trusted. This is the second 30443
   * consumption path — it bypasses `KeyPackageStore`/`KeyPackageManager.track()`
   * entirely, so it independently gates on the same verify/cardinality/
   * lifetime rules. Defaults to applesauce's `verifyEvent`.
   */
  verifyEvent?: VerifyEventMethod;
};

/**
 * Builds a `commit` session intent that adds a user from their KeyPackage event
 * and delivers a Welcome to them after the commit acks.
 *
 * Validates that the event is a KeyPackage (kind 30443), passes the trust
 * boundary (SEC-01: signature; WIRE-02: `d`/`i`/`mls_protocol_version`
 * cardinality; WIRE-01: Lifetime cap/current), and that the embedded
 * credential identity matches the event author, before constructing the Add
 * proposal. Pair the result with {@link GroupSession.send} /
 * {@link GroupsManager.send}; {@link GroupsManager.invite} wraps this helper and
 * resolves `actorPubkey` from the signer.
 *
 * @throws Error if the event is not a KeyPackage kind, fails signature
 *   verification, has invalid required-tag cardinality, has an over-long or
 *   not-current Lifetime, or the credential identity does not match the
 *   event author.
 */
export function createInviteIntent(
  options: CreateInviteIntentOptions,
): Extract<GroupSessionSendIntent, { kind: "commit" }> {
  const { keyPackageEvent, actorPubkey } = options;

  if (keyPackageEvent.kind !== ADDRESSABLE_KEY_PACKAGE_KIND) {
    throw new Error(
      `createInviteIntent: Expected KeyPackage event kind ${ADDRESSABLE_KEY_PACKAGE_KIND}, got ${keyPackageEvent.kind}`,
    );
  }

  // Trust boundary (SEC-01/WIRE-01/WIRE-02): this is the second 30443
  // consumption path — it bypasses KeyPackageStore/KeyPackageManager.track()
  // entirely, so it must independently verify + cardinality + lifetime-cap
  // check the raw event before building an Add proposal.
  const verify = options.verifyEvent ?? defaultVerifyEvent;
  if (!safeVerifyEvent(verify, keyPackageEvent)) {
    throw new Error(
      "createInviteIntent: KeyPackage event failed signature verification",
    );
  }

  if (
    getSingletonTagValue(keyPackageEvent, "d") === undefined ||
    getSingletonTagValue(keyPackageEvent, "i") === undefined ||
    getSingletonTagValue(keyPackageEvent, KEY_PACKAGE_MLS_VERSION_TAG) !== "1.0"
  ) {
    throw new Error(
      "createInviteIntent: KeyPackage event has invalid required-tag cardinality",
    );
  }

  const lifetime = getKeyPackageLifetime(keyPackageEvent);
  if (
    !lifetime ||
    !isLifetimeWithinCap(lifetime) ||
    !isLifetimeCurrentWithGrace(lifetime)
  ) {
    throw new Error(
      "createInviteIntent: KeyPackage lifetime exceeds cap or is not current",
    );
  }

  const keyPackage = getKeyPackage(keyPackageEvent);
  const credentialIdentity = getCredentialPubkey(
    keyPackage.leafNode.credential,
  );
  if (credentialIdentity !== keyPackageEvent.pubkey) {
    throw new Error(
      `createInviteIntent: Credential identity ${credentialIdentity} does not match event pubkey ${keyPackageEvent.pubkey}`,
    );
  }

  return {
    kind: "commit",
    actorPubkey,
    extraProposals: [proposeInviteUser(keyPackageEvent)],
    welcomeRecipients: [
      {
        pubkey: keyPackageEvent.pubkey,
        keyPackageEventId: keyPackageEvent.id,
        keyPackageEvent,
      },
    ],
  };
}
