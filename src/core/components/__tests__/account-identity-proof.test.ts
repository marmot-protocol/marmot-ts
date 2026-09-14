/**
 * Tests for the `marmot.member.account-identity-proof.v2` proof class (component `0x8009`):
 * the fixed kind-450 template, the spec signing test vector reproduced byte-for-byte
 * through `produceAccountIdentityProof`, and (added in a later task) the leaf/KeyPackage/
 * whole-tree validators, GroupContext profile classifier, and container location guards.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md ("Signing test vector")
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthorizationProofError,
  decodeAuthorizationProof,
} from "../../authorization-proof.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT,
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
} from "../ids.js";
import {
  AccountIdentityProofError,
  accountIdentityProofTemplate,
  mlsSignatureSchemeForCiphersuite,
  produceAccountIdentityProof,
} from "../account-identity-proof.js";
import { authorizationProofEventId } from "../../authorization-proof.js";

// Spec signing test vector (refs/marmot/app-components/account-identity-proof-v2.md):
// BIP-340 secret key `3`, all-zero 32-byte auxiliary randomness.
const VECTOR_SIGNER_PUBKEY_HEX =
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const VECTOR_CREATED_AT = 1700000000;
const VECTOR_EVENT_ID =
  "b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b";
const VECTOR_SIGNATURE_HEX =
  "c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d";
const VECTOR_COMPONENT_HEX =
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000006553f100c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d";
const VECTOR_CANONICAL_JSON =
  '[0,"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",1700000000,450,[["d","marmot.account-identity-proof.v2"],["component","0x8009"],["ciphersuite","0x0001"],["signature_scheme","0x0807"],["mls_signature_key","000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"]],"Authorize this MLS leaf key for my Marmot account"]';

const KEY_00_1F = hexToBytes(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
);

const SECRET_KEY_3 = new Uint8Array(32);
SECRET_KEY_3[31] = 3;
const OTHER_SECRET_KEY = new Uint8Array(32);
OTHER_SECRET_KEY[31] = 7;
const ZERO_AUX = new Uint8Array(32);

/** Signs `draft` with `secretKey` and the spec vector's all-zero aux randomness. */
function signWith(secretKey: Uint8Array, draft: UnsignedEvent) {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const unsigned: UnsignedEvent = { ...draft, pubkey };
  const id = getEventHash(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, ZERO_AUX));
  return { ...unsigned, id, sig };
}

const vectorSigner = {
  signEvent: async (draft: UnsignedEvent) => signWith(SECRET_KEY_3, draft),
};

/** Runs `thunk`, asserts it throws {@link AccountIdentityProofError}, and returns its reason. */
function expectReason(thunk: () => unknown) {
  try {
    thunk();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountIdentityProofError);
    expect((err as Error).name).toBe("AccountIdentityProofError");
    return (err as AccountIdentityProofError).reason;
  }
  throw new Error("expected thunk to throw AccountIdentityProofError");
}

/** Async counterpart of {@link expectReason}, for `AuthorizationProofError` (Phase 6). */
async function expectAuthorizationProofReasonAsync(
  thunk: () => Promise<unknown>,
) {
  try {
    await thunk();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthorizationProofError);
    return (err as AuthorizationProofError).reason;
  }
  throw new Error("expected thunk to throw AuthorizationProofError");
}

describe("component id and name (D-12)", () => {
  it("ACCOUNT_IDENTITY_PROOF_COMPONENT_ID is 0x8009 and ACCOUNT_IDENTITY_PROOF_COMPONENT is the spec name", () => {
    expect(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID).toBe(0x8009);
    expect(ACCOUNT_IDENTITY_PROOF_COMPONENT).toBe(
      "marmot.member.account-identity-proof.v2",
    );
  });
});

describe("mlsSignatureSchemeForCiphersuite", () => {
  it.each([
    [1, 0x0807],
    [2, 0x0403],
    [3, 0x0807],
    [4, 0x0808],
    [5, 0x0603],
    [6, 0x0808],
    [7, 0x0503],
  ])("ciphersuite %i -> scheme 0x%s", (ciphersuite, scheme) => {
    expect(mlsSignatureSchemeForCiphersuite(ciphersuite)).toBe(scheme);
  });

  it("throws ciphersuite-mismatch for ciphersuite 0", () => {
    expect(expectReason(() => mlsSignatureSchemeForCiphersuite(0))).toBe(
      "ciphersuite-mismatch",
    );
  });

  it("throws ciphersuite-mismatch for ciphersuite 0x00ff", () => {
    expect(expectReason(() => mlsSignatureSchemeForCiphersuite(0x00ff))).toBe(
      "ciphersuite-mismatch",
    );
  });
});

describe("accountIdentityProofTemplate", () => {
  it("builds the exact spec template for ciphersuite 1", () => {
    const template = accountIdentityProofTemplate(1, KEY_00_1F);
    expect(template).toEqual({
      kind: 450,
      tags: [
        ["d", "marmot.account-identity-proof.v2"],
        ["component", "0x8009"],
        ["ciphersuite", "0x0001"],
        ["signature_scheme", "0x0807"],
        [
          "mls_signature_key",
          "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        ],
      ],
      content: "Authorize this MLS leaf key for my Marmot account",
    });
  });

  it("ciphersuite 7 uses tags[2] = ciphersuite 0x0007 and tags[3] = signature_scheme 0x0503", () => {
    const template = accountIdentityProofTemplate(7, KEY_00_1F);
    expect(template.tags[2]).toEqual(["ciphersuite", "0x0007"]);
    expect(template.tags[3]).toEqual(["signature_scheme", "0x0503"]);
  });

  it("mutating one call's tags does not affect a second call's result", () => {
    const first = accountIdentityProofTemplate(1, KEY_00_1F);
    first.tags[0]![1] = "tampered";
    first.tags.push(["extra", "tag"]);
    const second = accountIdentityProofTemplate(1, KEY_00_1F);
    expect(second.tags[0]).toEqual(["d", "marmot.account-identity-proof.v2"]);
    expect(second.tags).toHaveLength(5);
  });

  it("reproduces the spec's canonical NIP-01 serialization byte-for-byte", () => {
    const template = accountIdentityProofTemplate(1, KEY_00_1F);
    const serialization = JSON.stringify([
      0,
      VECTOR_SIGNER_PUBKEY_HEX,
      VECTOR_CREATED_AT,
      template.kind,
      template.tags,
      template.content,
    ]);
    expect(serialization).toBe(VECTOR_CANONICAL_JSON);
  });

  it("reproduces the spec vector event id", () => {
    const template = accountIdentityProofTemplate(1, KEY_00_1F);
    const id = authorizationProofEventId(
      template,
      hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      VECTOR_CREATED_AT,
    );
    expect(id).toBe(VECTOR_EVENT_ID);
  });
});

describe("produceAccountIdentityProof (spec signing test vector)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reproduces the exact 104-byte component for the spec vector", async () => {
    const result = await produceAccountIdentityProof({
      signer: vectorSigner,
      accountIdentity: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      mlsSignatureKey: KEY_00_1F,
      ciphersuite: 1,
      createdAt: VECTOR_CREATED_AT,
    });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(104);
    expect(bytesToHex(result)).toBe(VECTOR_COMPONENT_HEX);
    expect(bytesToHex(result)).toBe(VECTOR_COMPONENT_HEX.toLowerCase());
    void VECTOR_SIGNATURE_HEX; // documented in the vector; covered via the full component hex
  });

  it("defaults createdAt to the current wall-clock time when omitted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000123456);
    const result = await produceAccountIdentityProof({
      signer: vectorSigner,
      accountIdentity: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      mlsSignatureKey: KEY_00_1F,
      ciphersuite: 1,
    });
    expect(decodeAuthorizationProof(result).createdAt).toBe(1700000123);
  });

  it("rejects an unknown ciphersuite with ciphersuite-mismatch before ever calling the signer", async () => {
    const signEvent = vi.fn(async (draft: UnsignedEvent) =>
      signWith(SECRET_KEY_3, draft),
    );
    const spySigner = { signEvent };
    let reason: unknown;
    try {
      await produceAccountIdentityProof({
        signer: spySigner,
        accountIdentity: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
        mlsSignatureKey: KEY_00_1F,
        ciphersuite: 0x00ff,
        createdAt: VECTOR_CREATED_AT,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AccountIdentityProofError);
      reason = (err as AccountIdentityProofError).reason;
    }
    expect(reason).toBe("ciphersuite-mismatch");
    expect(signEvent).not.toHaveBeenCalled();
  });

  it("propagates the Phase 6 AuthorizationProofError unchanged when the signer signs under a different key", async () => {
    const wrongKeySigner = {
      signEvent: async (draft: UnsignedEvent) =>
        signWith(OTHER_SECRET_KEY, draft),
    };
    const reason = await expectAuthorizationProofReasonAsync(() =>
      produceAccountIdentityProof({
        signer: wrongKeySigner,
        accountIdentity: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
        mlsSignatureKey: KEY_00_1F,
        ciphersuite: 1,
        createdAt: VECTOR_CREATED_AT,
      }),
    );
    expect(reason).toBe("returned-pubkey-mismatch");
  });
});

describe("AccountIdentityProofError", () => {
  it("is an Error subclass carrying name, reason, and cause", () => {
    const inner = new Error("inner");
    const err = new AccountIdentityProofError("m", "invalid-proof", {
      cause: inner,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AccountIdentityProofError");
    expect(err.reason).toBe("invalid-proof");
    expect(err.cause).toBe(inner);
  });
});
