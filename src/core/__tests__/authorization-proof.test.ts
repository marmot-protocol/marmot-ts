/**
 * Tests for the shared, proof-class-agnostic `MarmotAuthorizationProof` envelope primitive:
 * the strict 104-byte codec, `created_at` range enforcement, and x-only signer-pubkey
 * validation (Task 1). NIP-01 reconstruction, BIP-340 verify, and produce are added in
 * Task 2.
 *
 * @see refs/marmot/foundation/authorization-proofs.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md ("Signing test vector")
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_PROOF_LENGTH,
  AUTHORIZATION_PROOF_MAX_CREATED_AT,
  AuthorizationProofError,
  type AuthorizationProofRejectReason,
  decodeAuthorizationProof,
  encodeAuthorizationProof,
} from "../authorization-proof.js";

// Spec signing test vector (refs/marmot/app-components/account-identity-proof-v2.md):
// BIP-340 secret key `3`, all-zero 32-byte auxiliary randomness.
const VECTOR_SIGNER_PUBKEY_HEX =
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const VECTOR_CREATED_AT = 1700000000;
const VECTOR_CREATED_AT_HEX = "000000006553f100";
const VECTOR_SIGNATURE_HEX =
  "c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d";
const VECTOR_COMPONENT_HEX =
  VECTOR_SIGNER_PUBKEY_HEX + VECTOR_CREATED_AT_HEX + VECTOR_SIGNATURE_HEX;

/** Runs `thunk`, asserts it throws {@link AuthorizationProofError}, and returns its reason. */
function expectReason(thunk: () => unknown): AuthorizationProofRejectReason {
  try {
    thunk();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthorizationProofError);
    expect((err as Error).name).toBe("AuthorizationProofError");
    return (err as AuthorizationProofError).reason;
  }
  throw new Error("expected thunk to throw AuthorizationProofError");
}

function componentHex(
  pubkeyHex: string,
  createdAtHex: string,
  sigHex: string,
): string {
  return pubkeyHex + createdAtHex + sigHex;
}

const ZERO_PUBKEY_HEX = "00".repeat(32);
const FF_PUBKEY_HEX = "ff".repeat(32);
const X5_PUBKEY_HEX = "00".repeat(31) + "05";

describe("authorization proof — constants", () => {
  it("AUTHORIZATION_PROOF_LENGTH is 104", () => {
    expect(AUTHORIZATION_PROOF_LENGTH).toBe(104);
  });

  it("AUTHORIZATION_PROOF_MAX_CREATED_AT equals Number.MAX_SAFE_INTEGER", () => {
    expect(AUTHORIZATION_PROOF_MAX_CREATED_AT).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("authorization proof — encode/decode spec vector", () => {
  it("encodes the vector fields to exactly the 104-byte hex", () => {
    const bytes = encodeAuthorizationProof({
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      createdAt: VECTOR_CREATED_AT,
      signature: hexToBytes(VECTOR_SIGNATURE_HEX),
    });
    expect(bytes.length).toBe(104);
    expect(bytesToHex(bytes)).toBe(VECTOR_COMPONENT_HEX);
  });

  it("decodes the vector hex back to the same three fields", () => {
    const proof = decodeAuthorizationProof(hexToBytes(VECTOR_COMPONENT_HEX));
    expect(bytesToHex(proof.signerPubkey)).toBe(VECTOR_SIGNER_PUBKEY_HEX);
    expect(proof.createdAt).toBe(VECTOR_CREATED_AT);
    expect(proof.createdAt).toStrictEqual(1700000000);
    expect(bytesToHex(proof.signature)).toBe(VECTOR_SIGNATURE_HEX);
  });

  it("re-encodes a decoded vector to identical bytes", () => {
    const proof = decodeAuthorizationProof(hexToBytes(VECTOR_COMPONENT_HEX));
    expect(bytesToHex(encodeAuthorizationProof(proof))).toBe(
      VECTOR_COMPONENT_HEX,
    );
  });
});

describe("authorization proof — decode length rejection", () => {
  it("rejects a 0-byte input with invalid-length", () => {
    expect(
      expectReason(() => decodeAuthorizationProof(new Uint8Array(0))),
    ).toBe("invalid-length");
  });

  it("rejects a 103-byte input (last byte dropped) with invalid-length", () => {
    const truncated = hexToBytes(VECTOR_COMPONENT_HEX.slice(0, -2));
    expect(expectReason(() => decodeAuthorizationProof(truncated))).toBe(
      "invalid-length",
    );
  });

  it("rejects a 105-byte input (0x00 appended) with invalid-length", () => {
    const padded = hexToBytes(VECTOR_COMPONENT_HEX + "00");
    expect(expectReason(() => decodeAuthorizationProof(padded))).toBe(
      "invalid-length",
    );
  });
});

describe("authorization proof — decode created_at range", () => {
  it.each([
    ["0000000000000000", "created_at = 0"],
    ["0020000000000000", "created_at = 2^53"],
    ["ffffffffffffffff", "created_at = max u64"],
  ])("rejects wire created_at %s (%s) with created-at-out-of-range", (hex) => {
    const bytes = hexToBytes(
      componentHex(VECTOR_SIGNER_PUBKEY_HEX, hex, VECTOR_SIGNATURE_HEX),
    );
    expect(expectReason(() => decodeAuthorizationProof(bytes))).toBe(
      "created-at-out-of-range",
    );
  });

  it("decodes wire created_at 0000000000000001 to the number 1", () => {
    const bytes = hexToBytes(
      componentHex(
        VECTOR_SIGNER_PUBKEY_HEX,
        "0000000000000001",
        VECTOR_SIGNATURE_HEX,
      ),
    );
    expect(decodeAuthorizationProof(bytes).createdAt).toBe(1);
  });

  it("decodes wire created_at 001fffffffffffff to 9007199254740991 (2^53-1)", () => {
    const bytes = hexToBytes(
      componentHex(
        VECTOR_SIGNER_PUBKEY_HEX,
        "001fffffffffffff",
        VECTOR_SIGNATURE_HEX,
      ),
    );
    expect(decodeAuthorizationProof(bytes).createdAt).toBe(9007199254740991);
  });
});

describe("authorization proof — decode signer_pubkey validity", () => {
  it.each([
    [ZERO_PUBKEY_HEX, "32 zero bytes"],
    [FF_PUBKEY_HEX, "32 bytes of 0xff"],
    [X5_PUBKEY_HEX, "x = 5"],
  ])("rejects signer_pubkey %s (%s) with invalid-signer-pubkey", (hex) => {
    const bytes = hexToBytes(
      componentHex(hex, VECTOR_CREATED_AT_HEX, VECTOR_SIGNATURE_HEX),
    );
    expect(expectReason(() => decodeAuthorizationProof(bytes))).toBe(
      "invalid-signer-pubkey",
    );
  });

  it("rejects signer_pubkey=zero AND created_at=0 with invalid-signer-pubkey (pubkey checked before created_at)", () => {
    const bytes = hexToBytes(
      componentHex(ZERO_PUBKEY_HEX, "0000000000000000", VECTOR_SIGNATURE_HEX),
    );
    expect(expectReason(() => decodeAuthorizationProof(bytes))).toBe(
      "invalid-signer-pubkey",
    );
  });

  it("decode never checks the signature (bad signature bytes still decode with a valid pubkey/created_at)", () => {
    const bytes = hexToBytes(
      componentHex(
        VECTOR_SIGNER_PUBKEY_HEX,
        VECTOR_CREATED_AT_HEX,
        "00".repeat(64),
      ),
    );
    const proof = decodeAuthorizationProof(bytes);
    expect(proof.createdAt).toBe(VECTOR_CREATED_AT);
  });
});

describe("authorization proof — encode rejections", () => {
  it.each([
    [0, "created-at-out-of-range"],
    [-1, "created-at-out-of-range"],
    [2 ** 53, "created-at-out-of-range"],
    [1.5, "created-at-non-integer"],
    [NaN, "created-at-non-integer"],
  ] as const)("rejects createdAt %s with %s", (createdAt, reason) => {
    expect(
      expectReason(() =>
        encodeAuthorizationProof({
          signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
          createdAt,
          signature: hexToBytes(VECTOR_SIGNATURE_HEX),
        }),
      ),
    ).toBe(reason);
  });

  it("rejects a 31-byte signerPubkey with invalid-signer-pubkey", () => {
    expect(
      expectReason(() =>
        encodeAuthorizationProof({
          signerPubkey: new Uint8Array(31),
          createdAt: VECTOR_CREATED_AT,
          signature: hexToBytes(VECTOR_SIGNATURE_HEX),
        }),
      ),
    ).toBe("invalid-signer-pubkey");
  });

  it("rejects a non-point signerPubkey with invalid-signer-pubkey", () => {
    expect(
      expectReason(() =>
        encodeAuthorizationProof({
          signerPubkey: hexToBytes(ZERO_PUBKEY_HEX),
          createdAt: VECTOR_CREATED_AT,
          signature: hexToBytes(VECTOR_SIGNATURE_HEX),
        }),
      ),
    ).toBe("invalid-signer-pubkey");
  });

  it("rejects a 63-byte signature with invalid-length", () => {
    expect(
      expectReason(() =>
        encodeAuthorizationProof({
          signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
          createdAt: VECTOR_CREATED_AT,
          signature: new Uint8Array(63),
        }),
      ),
    ).toBe("invalid-length");
  });
});
