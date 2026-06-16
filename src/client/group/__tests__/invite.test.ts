import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  type CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import { accountProofSignerFor } from "../../../__tests__/helpers/account-proof.js";
import { createCredential } from "../../../core/credential.js";
import { createKeyPackageEvent } from "../../../core/key-package-event.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../../core/protocol.js";
import { createInviteIntent } from "../invite.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

describe("createInviteIntent", () => {
  let ciphersuite: CiphersuiteImpl;

  beforeAll(async () => {
    ciphersuite = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  });

  async function inviteeKeyPackageEvent() {
    const invitee = PrivateKeyAccount.generateNew();
    const pubkey = await invitee.signer.getPublicKey();
    const keyPackage = await generateKeyPackage({
      credential: createCredential(pubkey),
      ciphersuiteImpl: ciphersuite,
      accountProofSigner: accountProofSignerFor(invitee),
    });
    const event = await invitee.signer.signEvent(
      await createKeyPackageEvent({
        keyPackage: keyPackage.publicPackage,
        identifier: pubkey,
        relays: ["wss://mock-relay.test"],
      }),
    );
    return { event, pubkey };
  }

  it("builds a commit intent with an Add proposal and welcome recipient", async () => {
    const { event, pubkey } = await inviteeKeyPackageEvent();
    const actorPubkey = "a".repeat(64);

    const intent = createInviteIntent({ keyPackageEvent: event, actorPubkey });

    expect(intent.kind).toBe("commit");
    expect(intent.actorPubkey).toBe(actorPubkey);
    expect(intent.extraProposals).toHaveLength(1);
    expect(typeof intent.extraProposals?.[0]).toBe("function");
    expect(intent.welcomeRecipients).toEqual([
      {
        pubkey,
        keyPackageEventId: event.id,
        keyPackageEvent: event,
      },
    ]);
  });

  it("throws when the event is not a KeyPackage kind", async () => {
    const { event } = await inviteeKeyPackageEvent();
    const wrongKind = { ...event, kind: 1 };

    expect(() =>
      createInviteIntent({
        keyPackageEvent: wrongKind,
        actorPubkey: "a".repeat(64),
      }),
    ).toThrow(new RegExp(`kind ${ADDRESSABLE_KEY_PACKAGE_KIND}`));
  });

  it("throws when the credential identity does not match the event author", async () => {
    const { event } = await inviteeKeyPackageEvent();
    // Spoof a different author than the one embedded in the credential.
    const mismatched = { ...event, pubkey: "b".repeat(64) };

    expect(() =>
      createInviteIntent({
        keyPackageEvent: mismatched,
        actorPubkey: "a".repeat(64),
      }),
    ).toThrow(/does not match event pubkey/);
  });
});
