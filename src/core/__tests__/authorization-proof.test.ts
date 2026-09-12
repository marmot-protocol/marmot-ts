/**
 * Tests for the shared, proof-class-agnostic `MarmotAuthorizationProof` envelope primitive:
 * the strict 104-byte codec, `created_at` range enforcement, and x-only signer-pubkey
 * validation (Task 1), plus NIP-01 reconstruction, BIP-340 verify, and strict
 * external-signer produce (Task 2).
 *
 * @see refs/marmot/foundation/authorization-proofs.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md ("Signing test vector")
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  getEventHash,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core/factories";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTHORIZATION_PROOF_LENGTH,
  AUTHORIZATION_PROOF_MAX_CREATED_AT,
  AuthorizationProofError,
  type AuthorizationProofRejectReason,
  type AuthorizationProofTemplate,
  authorizationProofEventId,
  buildAuthorizationProofEvent,
  decodeAuthorizationProof,
  encodeAuthorizationProof,
  produceAuthorizationProof,
  verifyAuthorizationProof,
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
const X1_PUBKEY_HEX = "00".repeat(31) + "01";

const VECTOR_EVENT_ID =
  "b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b";

const VECTOR_TEMPLATE: AuthorizationProofTemplate = {
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
};

const SECRET_KEY = new Uint8Array(32);
SECRET_KEY[31] = 3; // spec vector secret key
const ZERO_AUX = new Uint8Array(32); // spec vector aux randomness
const OTHER_SECRET_KEY = new Uint8Array(32);
OTHER_SECRET_KEY[31] = 7;

/** Signs `draft` with `secretKey` (optionally under a substituted `pubkey`), computing a
 * self-consistent id and BIP-340 signature over the exact bytes produced. */
function signWith(
  secretKey: Uint8Array,
  draft: UnsignedEvent,
  pubkeyOverride?: string,
) {
  const pubkey = pubkeyOverride ?? bytesToHex(schnorr.getPublicKey(secretKey));
  const unsigned: UnsignedEvent = { ...draft, pubkey };
  const id = getEventHash(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey, ZERO_AUX));
  return { ...unsigned, id, sig };
}

const vectorSigner: Pick<EventSigner, "signEvent"> = {
  signEvent: async (draft) => signWith(SECRET_KEY, draft as UnsignedEvent),
};

/** Async counterpart of {@link expectReason}. */
async function expectReasonAsync(
  thunk: () => Promise<unknown>,
): Promise<AuthorizationProofRejectReason> {
  try {
    await thunk();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthorizationProofError);
    expect((err as Error).name).toBe("AuthorizationProofError");
    return (err as AuthorizationProofError).reason;
  }
  throw new Error("expected thunk to reject with AuthorizationProofError");
}

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

describe("authorization proof — NIP-01 reconstruction and event id", () => {
  it("authorizationProofEventId reproduces the exact spec vector event id", () => {
    expect(
      authorizationProofEventId(
        VECTOR_TEMPLATE,
        hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
        VECTOR_CREATED_AT,
      ),
    ).toBe(VECTOR_EVENT_ID);
  });

  it("buildAuthorizationProofEvent returns the exact reconstructed unsigned event", () => {
    const event = buildAuthorizationProofEvent(
      VECTOR_TEMPLATE,
      hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      VECTOR_CREATED_AT,
    );
    expect(event.pubkey).toBe(VECTOR_SIGNER_PUBKEY_HEX);
    expect(event.created_at).toBe(VECTOR_CREATED_AT);
    expect(event.kind).toBe(450);
    expect(event.tags).toEqual(VECTOR_TEMPLATE.tags);
    expect(event.tags).not.toBe(VECTOR_TEMPLATE.tags);
    expect(event.content).toBe(VECTOR_TEMPLATE.content);
  });
});

describe("authorization proof — produce (spec vector)", () => {
  it("reproduces the exact signature and 104-byte component hex through the generic primitive", async () => {
    const proof = await produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer: vectorSigner,
      createdAt: VECTOR_CREATED_AT,
    });
    expect(bytesToHex(proof.signature)).toBe(VECTOR_SIGNATURE_HEX);
    expect(bytesToHex(encodeAuthorizationProof(proof))).toBe(
      VECTOR_COMPONENT_HEX,
    );
  });
});

describe("authorization proof — verify", () => {
  it("verifies the decoded spec-vector proof bytes", () => {
    const proof = verifyAuthorizationProof(
      VECTOR_TEMPLATE,
      hexToBytes(VECTOR_COMPONENT_HEX),
    );
    expect(proof.createdAt).toBe(VECTOR_CREATED_AT);
  });

  it("also verifies the already-decoded proof object", () => {
    const decoded = decodeAuthorizationProof(hexToBytes(VECTOR_COMPONENT_HEX));
    const proof = verifyAuthorizationProof(VECTOR_TEMPLATE, decoded);
    expect(proof.createdAt).toBe(VECTOR_CREATED_AT);
  });

  it("verifies a proof with createdAt 1 (no receiver-side expiry)", async () => {
    const proof = await produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer: vectorSigner,
      createdAt: 1,
    });
    expect(verifyAuthorizationProof(VECTOR_TEMPLATE, proof).createdAt).toBe(1);
  });

  it("rejects content changed by one character with invalid-signature", () => {
    const altered: AuthorizationProofTemplate = {
      ...VECTOR_TEMPLATE,
      content: VECTOR_TEMPLATE.content + "!",
    };
    expect(
      expectReason(() =>
        verifyAuthorizationProof(altered, hexToBytes(VECTOR_COMPONENT_HEX)),
      ),
    ).toBe("invalid-signature");
  });

  it("rejects two tags swapped with invalid-signature", () => {
    const tags = [...VECTOR_TEMPLATE.tags];
    [tags[0], tags[1]] = [tags[1], tags[0]];
    const altered: AuthorizationProofTemplate = { ...VECTOR_TEMPLATE, tags };
    expect(
      expectReason(() =>
        verifyAuthorizationProof(altered, hexToBytes(VECTOR_COMPONENT_HEX)),
      ),
    ).toBe("invalid-signature");
  });

  it("rejects one extra tag appended with invalid-signature", () => {
    const altered: AuthorizationProofTemplate = {
      ...VECTOR_TEMPLATE,
      tags: [...VECTOR_TEMPLATE.tags, ["extra", "tag"]],
    };
    expect(
      expectReason(() =>
        verifyAuthorizationProof(altered, hexToBytes(VECTOR_COMPONENT_HEX)),
      ),
    ).toBe("invalid-signature");
  });

  it("rejects kind 451 with invalid-signature", () => {
    const altered: AuthorizationProofTemplate = {
      ...VECTOR_TEMPLATE,
      kind: 451,
    };
    expect(
      expectReason(() =>
        verifyAuthorizationProof(altered, hexToBytes(VECTOR_COMPONENT_HEX)),
      ),
    ).toBe("invalid-signature");
  });

  it("rejects proof createdAt 1700000001 with invalid-signature", () => {
    const bytes = hexToBytes(
      componentHex(
        VECTOR_SIGNER_PUBKEY_HEX,
        "000000006553f101",
        VECTOR_SIGNATURE_HEX,
      ),
    );
    expect(
      expectReason(() => verifyAuthorizationProof(VECTOR_TEMPLATE, bytes)),
    ).toBe("invalid-signature");
  });

  it("rejects one bit flipped in the signature with invalid-signature", () => {
    const sigBytes = hexToBytes(VECTOR_SIGNATURE_HEX);
    sigBytes[0] ^= 0x01;
    const altered = componentHex(
      VECTOR_SIGNER_PUBKEY_HEX,
      VECTOR_CREATED_AT_HEX,
      bytesToHex(sigBytes),
    );
    expect(
      expectReason(() =>
        verifyAuthorizationProof(VECTOR_TEMPLATE, hexToBytes(altered)),
      ),
    ).toBe("invalid-signature");
  });

  it("rejects the signature checked under a valid-but-wrong x-only pubkey (x = 1)", () => {
    const altered = componentHex(
      X1_PUBKEY_HEX,
      VECTOR_CREATED_AT_HEX,
      VECTOR_SIGNATURE_HEX,
    );
    expect(
      expectReason(() =>
        verifyAuthorizationProof(VECTOR_TEMPLATE, hexToBytes(altered)),
      ),
    ).toBe("invalid-signature");
  });

  it.each([
    [
      {
        ...VECTOR_TEMPLATE,
        kind: 1.5,
      } as unknown as AuthorizationProofTemplate,
      "kind 1.5",
    ],
    [
      {
        ...VECTOR_TEMPLATE,
        tags: [["d", 1]],
      } as unknown as AuthorizationProofTemplate,
      "tags [[d,1]]",
    ],
    [
      {
        ...VECTOR_TEMPLATE,
        tags: "not-an-array",
      } as unknown as AuthorizationProofTemplate,
      "tags not an array",
    ],
    [
      {
        ...VECTOR_TEMPLATE,
        content: 5,
      } as unknown as AuthorizationProofTemplate,
      "content 5",
    ],
  ])("rejects malformed template (%s) with malformed-template", (template) => {
    expect(
      expectReason(() =>
        verifyAuthorizationProof(template, hexToBytes(VECTOR_COMPONENT_HEX)),
      ),
    ).toBe("malformed-template");
  });

  it("rejects 103 raw bytes with invalid-length", () => {
    const truncated = hexToBytes(VECTOR_COMPONENT_HEX.slice(0, -2));
    expect(
      expectReason(() => verifyAuthorizationProof(VECTOR_TEMPLATE, truncated)),
    ).toBe("invalid-length");
  });

  it("rejects an object proof whose signature is 63 bytes with invalid-length", () => {
    expect(
      expectReason(() =>
        verifyAuthorizationProof(VECTOR_TEMPLATE, {
          signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
          createdAt: VECTOR_CREATED_AT,
          signature: new Uint8Array(63),
        }),
      ),
    ).toBe("invalid-length");
  });
});

describe("authorization proof — produce createdAt handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults createdAt to Math.floor(Date.now() / 1000) when omitted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000123456);
    const proof = await produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer: vectorSigner,
    });
    expect(proof.createdAt).toBe(1700000123);
  });

  it.each([
    [0, "created-at-out-of-range"],
    [-1, "created-at-out-of-range"],
    [2 ** 53, "created-at-out-of-range"],
    [1.5, "created-at-non-integer"],
    [NaN, "created-at-non-integer"],
  ] as const)(
    "rejects createdAt %s with %s before calling the signer",
    async (createdAt, reason) => {
      const signEvent = vi.fn();
      const got = await expectReasonAsync(() =>
        produceAuthorizationProof({
          template: VECTOR_TEMPLATE,
          signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
          signer: { signEvent },
          createdAt,
        }),
      );
      expect(got).toBe(reason);
      expect(signEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-point signerPubkey with invalid-signer-pubkey before calling the signer", async () => {
    const signEvent = vi.fn();
    const got = await expectReasonAsync(() =>
      produceAuthorizationProof({
        template: VECTOR_TEMPLATE,
        signerPubkey: hexToBytes(ZERO_PUBKEY_HEX),
        signer: { signEvent },
        createdAt: VECTOR_CREATED_AT,
      }),
    );
    expect(got).toBe("invalid-signer-pubkey");
    expect(signEvent).not.toHaveBeenCalled();
  });

  it("rejects a malformed template (kind 1.5) with malformed-template before calling the signer", async () => {
    const signEvent = vi.fn();
    const got = await expectReasonAsync(() =>
      produceAuthorizationProof({
        template: {
          ...VECTOR_TEMPLATE,
          kind: 1.5,
        } as unknown as AuthorizationProofTemplate,
        signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
        signer: { signEvent },
        createdAt: VECTOR_CREATED_AT,
      }),
    );
    expect(got).toBe("malformed-template");
    expect(signEvent).not.toHaveBeenCalled();
  });
});

describe("authorization proof — produce external-signer substitution regressions", () => {
  async function produceWith(
    signEvent: (draft: UnsignedEvent) => Promise<unknown> | unknown,
  ) {
    return produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer: {
        signEvent: signEvent as unknown as Pick<
          EventSigner,
          "signEvent"
        >["signEvent"],
      },
      createdAt: VECTOR_CREATED_AT,
    });
  }

  it("rejects a different key's pubkey with returned-pubkey-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => signWith(OTHER_SECRET_KEY, draft)),
    );
    expect(reason).toBe("returned-pubkey-mismatch");
  });

  it("rejects the same pubkey in uppercase hex with returned-pubkey-mismatch", async () => {
    // nostr-tools' own getEventHash rejects a non-lowercase-hex pubkey before it can
    // produce a self-consistent id/sig for this substitution, so this one case supplies
    // placeholder id/sig: produce's pubkey check (the first field compared) throws before
    // either is ever read.
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => ({
        ...draft,
        pubkey: draft.pubkey.toUpperCase(),
        id: "0".repeat(64),
        sig: "0".repeat(128),
      })),
    );
    expect(reason).toBe("returned-pubkey-mismatch");
  });

  it("rejects created_at + 1 with returned-created-at-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) =>
        signWith(SECRET_KEY, { ...draft, created_at: draft.created_at + 1 }),
      ),
    );
    expect(reason).toBe("returned-created-at-mismatch");
  });

  it("rejects kind 451 with returned-kind-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => signWith(SECRET_KEY, { ...draft, kind: 451 })),
    );
    expect(reason).toBe("returned-kind-mismatch");
  });

  it("rejects an extra tag with returned-tags-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) =>
        signWith(SECRET_KEY, {
          ...draft,
          tags: [...draft.tags, ["extra", "tag"]],
        }),
      ),
    );
    expect(reason).toBe("returned-tags-mismatch");
  });

  it("rejects reordered tags with returned-tags-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        const tags = [...draft.tags];
        [tags[0], tags[1]] = [tags[1], tags[0]];
        return signWith(SECRET_KEY, { ...draft, tags });
      }),
    );
    expect(reason).toBe("returned-tags-mismatch");
  });

  it("rejects altered content with returned-content-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) =>
        signWith(SECRET_KEY, { ...draft, content: draft.content + "!" }),
      ),
    );
    expect(reason).toBe("returned-content-mismatch");
  });

  it("rejects an id replaced by a different 64-hex string with returned-id-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        const signed = signWith(SECRET_KEY, draft);
        return { ...signed, id: "a".repeat(64) };
      }),
    );
    expect(reason).toBe("returned-id-mismatch");
  });

  it("rejects a signature over a different message with returned-signature-invalid", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        const signed = signWith(SECRET_KEY, draft);
        const otherSig = bytesToHex(
          schnorr.sign(hexToBytes("11".repeat(32)), SECRET_KEY, ZERO_AUX),
        );
        return { ...signed, sig: otherSig };
      }),
    );
    expect(reason).toBe("returned-signature-invalid");
  });

  it("rejects uppercase signature hex with returned-signature-invalid", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        const signed = signWith(SECRET_KEY, draft);
        return { ...signed, sig: signed.sig.toUpperCase() };
      }),
    );
    expect(reason).toBe("returned-signature-invalid");
  });

  it("rejects a 126-hex-char signature with returned-signature-invalid", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        const signed = signWith(SECRET_KEY, draft);
        return { ...signed, sig: signed.sig.slice(0, 126) };
      }),
    );
    expect(reason).toBe("returned-signature-invalid");
  });

  it("rejects a signer returning null with returned-event-malformed", async () => {
    const reason = await expectReasonAsync(() => produceWith(() => null));
    expect(reason).toBe("returned-event-malformed");
  });

  it("rejects a signer that pushes an extra tag onto the received draft in place with returned-tags-mismatch", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) => {
        draft.tags.push(["extra", "mutated"]);
        return signWith(SECRET_KEY, draft);
      }),
    );
    expect(reason).toBe("returned-tags-mismatch");
  });

  it("rejects a signer substituting both pubkey and content with returned-pubkey-mismatch (comparison order)", async () => {
    const reason = await expectReasonAsync(() =>
      produceWith((draft) =>
        signWith(OTHER_SECRET_KEY, { ...draft, content: "different content" }),
      ),
    );
    expect(reason).toBe("returned-pubkey-mismatch");
  });
});

describe("authorization proof — signer contract shapes", () => {
  it("accepts a synchronous signEvent (returns an event, not a Promise)", async () => {
    const signer: Pick<EventSigner, "signEvent"> = {
      signEvent: (draft) => signWith(SECRET_KEY, draft as UnsignedEvent),
    };
    const proof = await produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer,
      createdAt: VECTOR_CREATED_AT,
    });
    expect(bytesToHex(proof.signature)).toBe(VECTOR_SIGNATURE_HEX);
  });

  it("accepts a full EventSigner-typed object without calling getPublicKey", async () => {
    const getPublicKey = vi.fn();
    const signer: EventSigner = {
      getPublicKey,
      signEvent: async (draft) => signWith(SECRET_KEY, draft as UnsignedEvent),
    };
    const proof = await produceAuthorizationProof({
      template: VECTOR_TEMPLATE,
      signerPubkey: hexToBytes(VECTOR_SIGNER_PUBKEY_HEX),
      signer,
      createdAt: VECTOR_CREATED_AT,
    });
    expect(bytesToHex(proof.signature)).toBe(VECTOR_SIGNATURE_HEX);
    expect(getPublicKey).not.toHaveBeenCalled();
  });
});
