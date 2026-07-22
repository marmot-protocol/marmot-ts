import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  finalizeEvent,
  generateSecretKey,
  verifiedSymbol,
} from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  bytesToBase64,
  defaultCryptoProvider,
  encode,
  getCiphersuiteImpl,
  mlsMessageEncoder,
  wireformats,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import { accountProofSignerFor } from "../../../__tests__/helpers/account-proof.js";
import { createCredential } from "../../../core/credential.js";
import { createKeyPackageEvent } from "../../../core/key-package-event.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../../core/protocol.js";
import { fakeVerifyEvent } from "../../verify.js";
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

  describe("trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path", () => {
    /** See `corruptSignature` in groups-manager.test.ts: strips the cached verifiedSymbol. */
    function corruptSignature(event: NostrEvent): NostrEvent {
      const corrupted: NostrEvent = { ...event, sig: "0".repeat(128) };
      delete (corrupted as Record<PropertyKey, unknown>)[verifiedSymbol];
      return corrupted;
    }

    it("throws createInviteIntent: ... for a signature-corrupted keyPackageEvent", async () => {
      const { event } = await inviteeKeyPackageEvent();
      const corrupted = corruptSignature(event);

      expect(() =>
        createInviteIntent({
          keyPackageEvent: corrupted,
          actorPubkey: "a".repeat(64),
        }),
      ).toThrow(/^createInviteIntent: .*signature verification/);
    });

    it("delegates verification to an injected fakeVerifyEvent (trust-upstream)", async () => {
      const { event } = await inviteeKeyPackageEvent();
      const corrupted = corruptSignature(event);

      expect(() =>
        createInviteIntent({
          keyPackageEvent: corrupted,
          actorPubkey: "a".repeat(64),
          verifyEvent: fakeVerifyEvent,
        }),
      ).not.toThrow(/signature verification/);
    });

    it("throws createInviteIntent: ... for a duplicate d tag (tag-cardinality)", async () => {
      const { event } = await inviteeKeyPackageEvent();
      const draft = {
        kind: event.kind,
        created_at: event.created_at,
        content: event.content,
        tags: [...event.tags, ["d", "duplicate-slot"]],
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      expect(() =>
        createInviteIntent({
          keyPackageEvent: badEvent,
          actorPubkey: "a".repeat(64),
        }),
      ).toThrow(/^createInviteIntent: .*cardinality/);
    });

    it("throws createInviteIntent: ... for a bad mls_protocol_version (tag-cardinality)", async () => {
      const { event } = await inviteeKeyPackageEvent();
      const draft = {
        kind: event.kind,
        created_at: event.created_at,
        content: event.content,
        tags: event.tags.map((t) =>
          t[0] === "mls_protocol_version" ? ["mls_protocol_version", "2.0"] : t,
        ),
      };
      const badEvent = finalizeEvent(draft, generateSecretKey());

      expect(() =>
        createInviteIntent({
          keyPackageEvent: badEvent,
          actorPubkey: "a".repeat(64),
        }),
      ).toThrow(/^createInviteIntent: .*cardinality/);
    });

    it("throws createInviteIntent: ... for a KeyPackage lifetime over the cap", async () => {
      const invitee = PrivateKeyAccount.generateNew();
      const pubkey = await invitee.signer.getPublicKey();
      const keyPackage = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        accountProofSigner: accountProofSignerFor(invitee),
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const overCapPackage = {
        ...keyPackage.publicPackage,
        leafNode: {
          ...keyPackage.publicPackage.leafNode,
          lifetime: { notBefore: now, notAfter: now + 7261201n },
        },
      };
      const framedBytes = encode(mlsMessageEncoder, {
        version: overCapPackage.version,
        wireformat: wireformats.mls_key_package,
        keyPackage: overCapPackage,
      });
      const draft = {
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: bytesToBase64(framedBytes),
        tags: [
          ["d", pubkey],
          ["i", "a".repeat(64)],
          ["mls_protocol_version", "1.0"],
        ],
      };
      const badEvent = await invitee.signer.signEvent(draft);

      expect(() =>
        createInviteIntent({
          keyPackageEvent: badEvent,
          actorPubkey: "a".repeat(64),
        }),
      ).toThrow(/^createInviteIntent: .*lifetime/);
    });

    it("throws createInviteIntent: ... for an expired-beyond-grace KeyPackage lifetime", async () => {
      const invitee = PrivateKeyAccount.generateNew();
      const pubkey = await invitee.signer.getPublicKey();
      const keyPackage = await generateKeyPackage({
        credential: createCredential(pubkey),
        ciphersuiteImpl: ciphersuite,
        accountProofSigner: accountProofSignerFor(invitee),
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiredPackage = {
        ...keyPackage.publicPackage,
        leafNode: {
          ...keyPackage.publicPackage.leafNode,
          lifetime: { notBefore: now - 100_000n, notAfter: now - 10_000n },
        },
      };
      const framedBytes = encode(mlsMessageEncoder, {
        version: expiredPackage.version,
        wireformat: wireformats.mls_key_package,
        keyPackage: expiredPackage,
      });
      const draft = {
        kind: ADDRESSABLE_KEY_PACKAGE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: bytesToBase64(framedBytes),
        tags: [
          ["d", pubkey],
          ["i", "b".repeat(64)],
          ["mls_protocol_version", "1.0"],
        ],
      };
      const badEvent = await invitee.signer.signEvent(draft);

      expect(() =>
        createInviteIntent({
          keyPackageEvent: badEvent,
          actorPubkey: "a".repeat(64),
        }),
      ).toThrow(/^createInviteIntent: .*lifetime/);
    });

    it("still builds a commit intent for a fully-valid keyPackageEvent (no regression)", async () => {
      const { event, pubkey } = await inviteeKeyPackageEvent();
      const actorPubkey = "a".repeat(64);

      const intent = createInviteIntent({
        keyPackageEvent: event,
        actorPubkey,
      });

      expect(intent.kind).toBe("commit");
      expect(intent.welcomeRecipients).toEqual([
        {
          pubkey,
          keyPackageEventId: event.id,
          keyPackageEvent: event,
        },
      ]);
    });
  });
});
