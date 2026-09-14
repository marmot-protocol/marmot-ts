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
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  appDataDictionaryExtensionType,
  defaultCredentialTypes,
  defaultCryptoProvider,
  defaultExtensionTypes,
  generateKeyPackageWithKey,
  getCiphersuiteImpl,
  makeAppDataDictionaryExtension,
  makeCustomExtension,
  nodeTypes,
  type ClientState,
  type Credential,
  type CustomExtension,
  type ExtensionRequiredCapabilities,
  type GroupContextExtension,
  type KeyPackage,
  type LeafNode,
} from "ts-mls";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthorizationProofError,
  authorizationProofEventId,
  decodeAuthorizationProof,
} from "../../authorization-proof.js";
import { BinaryWriter } from "../../binary.js";
import { createCredential } from "../../credential.js";
import { defaultCapabilities } from "../../default-capabilities.js";
import { createSimpleGroup } from "../../group.js";
import { createDefaultKeyPackageLifetime } from "../../../utils/timestamp.js";
import { encodeComponentsList } from "../app-components-list.js";
import {
  appComponentsEntry,
  buildAppDataDictionary,
  componentEntry,
  makeAppComponentsExtension,
} from "../dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT,
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "../ids.js";
import {
  AccountIdentityProofError,
  accountIdentityProofTemplate,
  assertCurrentGroupAccountIdentityProofProfile,
  assertNoAccountIdentityProofComponent,
  classifyGroupAccountIdentityProofProfile,
  hasAccountIdentityProofMaterial,
  mlsSignatureSchemeForCiphersuite,
  produceAccountIdentityProof,
  validateGroupMemberAccountIdentityProofs,
  validateKeyPackageAccountIdentityProof,
  validateLeafAccountIdentityProof,
} from "../account-identity-proof.js";

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

// ---------------------------------------------------------------------------
// Task 2: leaf, KeyPackage, and whole-tree validators; profile classifier;
// container location guards (PROOF-04, PROOF-05, PROOF-06, CUT-02)
// ---------------------------------------------------------------------------

const OTHER_PUBKEY_HEX =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** Builds a raw `app_data_dictionary` LeafNode/KeyPackage extension from entries. */
function leafDictionary(
  entries: ReturnType<typeof componentEntry>[],
): CustomExtension {
  return makeAppDataDictionaryExtension(buildAppDataDictionary(entries));
}

/**
 * Builds a raw `app_data_dictionary` extension directly from a `BinaryWriter` vector,
 * bypassing ts-mls's sorted+unique enforcement — used to construct malformed fixtures
 * (e.g. duplicate `0x8009` entries) that `buildAppDataDictionary` would refuse to build.
 */
function rawDictionaryExtension(
  entries: { componentId: number; data: Uint8Array }[],
): CustomExtension {
  const items = entries.map((e) =>
    new BinaryWriter().uint16(e.componentId).opaque(e.data).build(),
  );
  const bytes = new BinaryWriter().vector(items).build();
  return makeCustomExtension({
    extensionType: appDataDictionaryExtensionType,
    extensionData: bytes,
  });
}

/** Builds the deployed legacy `0xf2f1` custom LeafNode extension. */
function legacyExtension(bytes: Uint8Array): CustomExtension {
  return makeCustomExtension({ extensionType: 0xf2f1, extensionData: bytes });
}

/** The valid spec-vector `0x8009` data entry, wrapped as a leaf `app_data_dictionary`. */
const VECTOR_LEAF_DICTIONARY = leafDictionary([
  appComponentsEntry([
    0x0001,
    0x8001,
    0x8003,
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  ]),
  componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
  componentEntry(
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    hexToBytes(VECTOR_COMPONENT_HEX),
  ),
]);

/** Builds a `LeafNode`-shaped fixture (cast; only the fields this module reads are real). */
function makeLeaf(overrides: {
  credential?: Credential;
  signaturePublicKey?: Uint8Array;
  extensions?: CustomExtension[];
}): LeafNode {
  return {
    credential:
      overrides.credential ?? createCredential(VECTOR_SIGNER_PUBKEY_HEX),
    signaturePublicKey: overrides.signaturePublicKey ?? KEY_00_1F,
    extensions: overrides.extensions ?? [VECTOR_LEAF_DICTIONARY],
  } as unknown as LeafNode;
}

const VECTOR_LEAF = makeLeaf({});

describe("validateLeafAccountIdentityProof", () => {
  it("accepts VECTOR_LEAF for ciphersuite 1", () => {
    expect(() =>
      validateLeafAccountIdentityProof(VECTOR_LEAF, 1),
    ).not.toThrow();
  });

  it("passes for a real ts-mls KeyPackage, its leaf, and the resulting group state", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = PrivateKeyAccount.generateNew();
    const credential = createCredential(account.pubkey);
    const signatureKeyPair = await impl.signature.keygen();

    const proofData = await produceAccountIdentityProof({
      signer: account,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: signatureKeyPair.publicKey,
      ciphersuite: impl.id,
      createdAt: VECTOR_CREATED_AT,
    });

    const leafNodeExtensions: CustomExtension[] = [
      leafDictionary([
        appComponentsEntry([0x0001, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]),
        componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, proofData),
      ]),
    ];

    const { publicPackage, privatePackage } = await generateKeyPackageWithKey({
      credential,
      capabilities: defaultCapabilities(),
      lifetime: createDefaultKeyPackageLifetime(),
      signatureKeyPair,
      cipherSuite: impl,
      leafNodeExtensions,
    });

    expect(() =>
      validateKeyPackageAccountIdentityProof(publicPackage),
    ).not.toThrow();
    expect(() =>
      validateKeyPackageAccountIdentityProof(publicPackage, impl.id),
    ).not.toThrow();

    const { clientState } = await createSimpleGroup(
      { publicPackage, privatePackage },
      impl,
    );
    expect(() =>
      validateGroupMemberAccountIdentityProofs(clientState, impl.id),
    ).not.toThrow();
  });

  it("no app_data_dictionary extension -> missing-support", () => {
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(makeLeaf({ extensions: [] }), 1),
      ),
    ).toBe("missing-support");
  });

  it("data entry present but support list lacks 0x8009 -> missing-support", () => {
    const dict = leafDictionary([
      appComponentsEntry([0x0001, 0x8001, 0x8003]),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      componentEntry(
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        hexToBytes(VECTOR_COMPONENT_HEX),
      ),
    ]);
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1),
      ),
    ).toBe("missing-support");
  });

  it("support list names 0x8009 but there is no 0x8009 entry -> missing-data", () => {
    const dict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
    ]);
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1),
      ),
    ).toBe("missing-data");
  });

  it("raw-encoded dictionary with two 0x8009 entries -> duplicate-data", () => {
    const dict = rawDictionaryExtension([
      {
        componentId: 0x0001,
        data: encodeComponentsList([
          0x0001,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        ]),
      },
      {
        componentId: ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        data: hexToBytes(VECTOR_COMPONENT_HEX),
      },
      {
        componentId: ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        data: hexToBytes(VECTOR_COMPONENT_HEX),
      },
    ]);
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1),
      ),
    ).toBe("duplicate-data");
  });

  it("two separate valid app_data_dictionary extensions -> duplicate-data", () => {
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(
          makeLeaf({
            extensions: [VECTOR_LEAF_DICTIONARY, VECTOR_LEAF_DICTIONARY],
          }),
          1,
        ),
      ),
    ).toBe("duplicate-data");
  });

  it("dictionary bytes with the last byte dropped -> invalid-dictionary", () => {
    const truncated = makeCustomExtension({
      extensionType: appDataDictionaryExtensionType,
      extensionData: VECTOR_LEAF_DICTIONARY.extensionData.slice(0, -1),
    });
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(
          makeLeaf({ extensions: [truncated] }),
          1,
        ),
      ),
    ).toBe("invalid-dictionary");
  });

  it("leaf whose only proof material is a 0xf2f1 extension -> legacy-extension-present", () => {
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(
          makeLeaf({
            extensions: [legacyExtension(new Uint8Array([1, 2, 3]))],
          }),
          1,
        ),
      ),
    ).toBe("legacy-extension-present");
  });

  it("VECTOR_LEAF plus a 0xf2f1 extension -> legacy-extension-present", () => {
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(
          makeLeaf({
            extensions: [
              VECTOR_LEAF_DICTIONARY,
              legacyExtension(new Uint8Array([1])),
            ],
          }),
          1,
        ),
      ),
    ).toBe("legacy-extension-present");
  });

  it("SafeAAD entry encoding [0x8009] -> invalid-location", () => {
    const dict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
      componentEntry(
        SAFE_AAD_COMPONENT_ID,
        encodeComponentsList([ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]),
      ),
      componentEntry(
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        hexToBytes(VECTOR_COMPONENT_HEX),
      ),
    ]);
    expect(
      expectReason(() =>
        validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1),
      ),
    ).toBe("invalid-location");
  });

  it("credential identity of 32 zero bytes -> invalid-credential", () => {
    const leaf = makeLeaf({
      credential: {
        credentialType: defaultCredentialTypes.basic,
        identity: new Uint8Array(32),
      },
    });
    expect(expectReason(() => validateLeafAccountIdentityProof(leaf, 1))).toBe(
      "invalid-credential",
    );
  });

  it("a non-basic credential -> invalid-credential", () => {
    const leaf = makeLeaf({
      credential: {
        credentialType: defaultCredentialTypes.x509,
        certificates: [],
      } as unknown as Credential,
    });
    expect(expectReason(() => validateLeafAccountIdentityProof(leaf, 1))).toBe(
      "invalid-credential",
    );
  });

  it("credential identity for secret key 1 with the vector proof -> identity-mismatch", () => {
    const leaf = makeLeaf({ credential: createCredential(OTHER_PUBKEY_HEX) });
    expect(expectReason(() => validateLeafAccountIdentityProof(leaf, 1))).toBe(
      "identity-mismatch",
    );
  });

  it("ciphersuite 0x00ff -> ciphersuite-mismatch", () => {
    expect(
      expectReason(() => validateLeafAccountIdentityProof(VECTOR_LEAF, 0x00ff)),
    ).toBe("ciphersuite-mismatch");
  });

  it("ciphersuite 2 with the 32-byte key -> signature-key-mismatch", () => {
    expect(
      expectReason(() => validateLeafAccountIdentityProof(VECTOR_LEAF, 2)),
    ).toBe("signature-key-mismatch");
  });

  it("ciphersuite 3 (same scheme/key length, different tag) -> invalid-proof (cause invalid-signature)", () => {
    let thrown: AccountIdentityProofError | undefined;
    try {
      validateLeafAccountIdentityProof(VECTOR_LEAF, 3);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown).toBeInstanceOf(AccountIdentityProofError);
    expect(thrown?.reason).toBe("invalid-proof");
    expect(thrown?.cause).toBeInstanceOf(AuthorizationProofError);
    expect((thrown?.cause as AuthorizationProofError).reason).toBe(
      "invalid-signature",
    );
  });

  it("signaturePublicKey replaced by 32 bytes of 0xcd -> invalid-proof (cause invalid-signature)", () => {
    const leaf = makeLeaf({
      signaturePublicKey: new Uint8Array(32).fill(0xcd),
    });
    let thrown: AccountIdentityProofError | undefined;
    try {
      validateLeafAccountIdentityProof(leaf, 1);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown?.reason).toBe("invalid-proof");
    expect((thrown?.cause as AuthorizationProofError).reason).toBe(
      "invalid-signature",
    );
  });

  it("one bit flipped in the proof signature -> invalid-proof (cause invalid-signature)", () => {
    const tamperedBytes = hexToBytes(VECTOR_COMPONENT_HEX);
    tamperedBytes[tamperedBytes.length - 1]! ^= 0x01;
    const dict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, tamperedBytes),
    ]);
    let thrown: AccountIdentityProofError | undefined;
    try {
      validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown?.reason).toBe("invalid-proof");
    expect((thrown?.cause as AuthorizationProofError).reason).toBe(
      "invalid-signature",
    );
  });

  it("a 103-byte 0x8009 entry -> invalid-proof (cause invalid-length)", () => {
    const truncated = hexToBytes(VECTOR_COMPONENT_HEX).slice(0, 103);
    const dict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, truncated),
    ]);
    let thrown: AccountIdentityProofError | undefined;
    try {
      validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown?.reason).toBe("invalid-proof");
    expect((thrown?.cause as AuthorizationProofError).reason).toBe(
      "invalid-length",
    );
  });

  it("created_at wire bytes 0000000000000000 -> invalid-proof (cause created-at-out-of-range)", () => {
    const zeroCreatedAt = hexToBytes(
      VECTOR_SIGNER_PUBKEY_HEX + "0000000000000000" + VECTOR_SIGNATURE_HEX,
    );
    const dict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, zeroCreatedAt),
    ]);
    let thrown: AccountIdentityProofError | undefined;
    try {
      validateLeafAccountIdentityProof(makeLeaf({ extensions: [dict] }), 1);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown?.reason).toBe("invalid-proof");
    expect((thrown?.cause as AuthorizationProofError).reason).toBe(
      "created-at-out-of-range",
    );
  });
});

function keyPackageShape(overrides: {
  cipherSuite?: number;
  leafNode?: LeafNode;
  extensions?: CustomExtension[];
}): KeyPackage {
  return {
    cipherSuite: overrides.cipherSuite ?? 1,
    leafNode: overrides.leafNode ?? VECTOR_LEAF,
    extensions: overrides.extensions ?? [],
  } as unknown as KeyPackage;
}

describe("validateKeyPackageAccountIdentityProof", () => {
  it("passes with no second argument and with expectedCiphersuite 1", () => {
    expect(() =>
      validateKeyPackageAccountIdentityProof(keyPackageShape({})),
    ).not.toThrow();
    expect(() =>
      validateKeyPackageAccountIdentityProof(keyPackageShape({}), 1),
    ).not.toThrow();
  });

  it("expectedCiphersuite 2 -> ciphersuite-mismatch", () => {
    expect(
      expectReason(() =>
        validateKeyPackageAccountIdentityProof(keyPackageShape({}), 2),
      ),
    ).toBe("ciphersuite-mismatch");
  });

  it("KeyPackage-level extensions carrying a dictionary with a 0x8009 entry -> invalid-location", () => {
    const kpDict = makeAppDataDictionaryExtension(
      buildAppDataDictionary([
        componentEntry(
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          hexToBytes(VECTOR_COMPONENT_HEX),
        ),
      ]),
    );
    expect(
      expectReason(() =>
        validateKeyPackageAccountIdentityProof(
          keyPackageShape({ extensions: [kpDict] }),
        ),
      ),
    ).toBe("invalid-location");
  });

  it("a KeyPackage-level 0xf2f1 extension -> legacy-extension-present", () => {
    expect(
      expectReason(() =>
        validateKeyPackageAccountIdentityProof(
          keyPackageShape({
            extensions: [legacyExtension(new Uint8Array([1]))],
          }),
        ),
      ),
    ).toBe("legacy-extension-present");
  });

  it("cipherSuite 3 on the KeyPackage -> invalid-proof (uses the KeyPackage's own ciphersuite, D-16)", () => {
    expect(
      expectReason(() =>
        validateKeyPackageAccountIdentityProof(
          keyPackageShape({ cipherSuite: 3 }),
        ),
      ),
    ).toBe("invalid-proof");
  });
});

function fakeClientStateWithLeaves(leaves: LeafNode[]): ClientState {
  const ratchetTree = leaves.map((leaf) => ({
    nodeType: nodeTypes.leaf,
    leaf,
  }));
  return { ratchetTree } as unknown as ClientState;
}

describe("validateGroupMemberAccountIdentityProofs", () => {
  it("throws for the failing member's position, wraps the inner error as cause, and names no 64-hex pubkey", () => {
    const tamperedBytes = hexToBytes(VECTOR_COMPONENT_HEX);
    tamperedBytes[tamperedBytes.length - 1]! ^= 0x01;
    const badDict = leafDictionary([
      appComponentsEntry([
        0x0001,
        0x8001,
        0x8003,
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
      ]),
      componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([])),
      componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, tamperedBytes),
    ]);
    const badLeaf = makeLeaf({ extensions: [badDict] });
    const state = fakeClientStateWithLeaves([VECTOR_LEAF, badLeaf]);

    let thrown: AccountIdentityProofError | undefined;
    try {
      validateGroupMemberAccountIdentityProofs(state, 1);
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown).toBeInstanceOf(AccountIdentityProofError);
    expect(thrown?.reason).toBe("invalid-proof");
    expect(thrown?.cause).toBeInstanceOf(AccountIdentityProofError);
    expect(thrown?.message).toContain("1");
    expect(thrown?.message).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("does not throw when every member leaf validates", () => {
    const state = fakeClientStateWithLeaves([VECTOR_LEAF]);
    expect(() =>
      validateGroupMemberAccountIdentityProofs(state, 1),
    ).not.toThrow();
  });
});

function requiredCapabilitiesExtension(
  extensionTypes: number[],
): ExtensionRequiredCapabilities {
  return {
    extensionType: defaultExtensionTypes.required_capabilities,
    extensionData: { extensionTypes, proposalTypes: [], credentialTypes: [] },
  };
}

const CURRENT_GROUP_EXTENSIONS: GroupContextExtension[] = [
  makeAppComponentsExtension([
    appComponentsEntry([0x0001, 0x8003, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]),
  ]),
  requiredCapabilitiesExtension([appDataDictionaryExtensionType]),
];

const LEGACY_GROUP_EXTENSIONS: GroupContextExtension[] = [
  makeAppComponentsExtension([appComponentsEntry([0x0001, 0x8003])]),
  requiredCapabilitiesExtension([appDataDictionaryExtensionType, 0xf2f1]),
];

const MIXED_GROUP_EXTENSIONS: GroupContextExtension[] = [
  makeAppComponentsExtension([
    appComponentsEntry([0x0001, 0x8003, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]),
  ]),
  requiredCapabilitiesExtension([appDataDictionaryExtensionType, 0xf2f1]),
];

const NEITHER_GROUP_EXTENSIONS: GroupContextExtension[] = [
  makeAppComponentsExtension([appComponentsEntry([0x0001, 0x8003])]),
  requiredCapabilitiesExtension([appDataDictionaryExtensionType]),
];

describe("classifyGroupAccountIdentityProofProfile", () => {
  it("classifies current, legacy, mixed, and neither", () => {
    expect(
      classifyGroupAccountIdentityProofProfile(CURRENT_GROUP_EXTENSIONS),
    ).toBe("current");
    expect(
      classifyGroupAccountIdentityProofProfile(LEGACY_GROUP_EXTENSIONS),
    ).toBe("legacy");
    expect(
      classifyGroupAccountIdentityProofProfile(MIXED_GROUP_EXTENSIONS),
    ).toBe("mixed");
    expect(
      classifyGroupAccountIdentityProofProfile(NEITHER_GROUP_EXTENSIONS),
    ).toBe("neither");
  });

  it("no extensions at all -> neither", () => {
    expect(classifyGroupAccountIdentityProofProfile([])).toBe("neither");
  });

  it("a GroupContext dictionary carrying a 0x8009 data entry -> throws invalid-location", () => {
    const dictionaryWithProofData = makeAppDataDictionaryExtension(
      buildAppDataDictionary([
        componentEntry(
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          hexToBytes(VECTOR_COMPONENT_HEX),
        ),
      ]),
    );
    expect(
      expectReason(() =>
        classifyGroupAccountIdentityProofProfile([dictionaryWithProofData]),
      ),
    ).toBe("invalid-location");
  });
});

describe("assertCurrentGroupAccountIdentityProofProfile", () => {
  it("current passes", () => {
    expect(() =>
      assertCurrentGroupAccountIdentityProofProfile(CURRENT_GROUP_EXTENSIONS),
    ).not.toThrow();
  });

  it("legacy -> legacy-group", () => {
    expect(
      expectReason(() =>
        assertCurrentGroupAccountIdentityProofProfile(LEGACY_GROUP_EXTENSIONS),
      ),
    ).toBe("legacy-group");
  });

  it("mixed -> mixed-profile", () => {
    expect(
      expectReason(() =>
        assertCurrentGroupAccountIdentityProofProfile(MIXED_GROUP_EXTENSIONS),
      ),
    ).toBe("mixed-profile");
  });

  it("neither -> missing-requirement", () => {
    expect(
      expectReason(() =>
        assertCurrentGroupAccountIdentityProofProfile(NEITHER_GROUP_EXTENSIONS),
      ),
    ).toBe("missing-requirement");
  });
});

describe("hasAccountIdentityProofMaterial", () => {
  it("true for VECTOR_LEAF, a legacy-only leaf, a mixed leaf, and a truncated dictionary", () => {
    expect(hasAccountIdentityProofMaterial(VECTOR_LEAF)).toBe(true);
    expect(
      hasAccountIdentityProofMaterial(
        makeLeaf({ extensions: [legacyExtension(new Uint8Array([1]))] }),
      ),
    ).toBe(true);
    expect(
      hasAccountIdentityProofMaterial(
        makeLeaf({
          extensions: [
            VECTOR_LEAF_DICTIONARY,
            legacyExtension(new Uint8Array([1])),
          ],
        }),
      ),
    ).toBe(true);
    const truncated = makeCustomExtension({
      extensionType: appDataDictionaryExtensionType,
      extensionData: VECTOR_LEAF_DICTIONARY.extensionData.slice(0, -1),
    });
    expect(
      hasAccountIdentityProofMaterial(makeLeaf({ extensions: [truncated] })),
    ).toBe(true);
  });

  it("false for a dictionary without a 0x8009 entry and for an empty extension list", () => {
    const noProofDict = leafDictionary([
      appComponentsEntry([0x0001, 0x8001, 0x8003]),
    ]);
    expect(
      hasAccountIdentityProofMaterial(makeLeaf({ extensions: [noProofDict] })),
    ).toBe(false);
    expect(hasAccountIdentityProofMaterial(makeLeaf({ extensions: [] }))).toBe(
      false,
    );
  });
});

describe("assertNoAccountIdentityProofComponent (PROOF-06, D-08)", () => {
  it("throws invalid-location naming the location for a list containing a 0x8009 data entry", () => {
    const dictionaryWithProofData = makeAppDataDictionaryExtension(
      buildAppDataDictionary([
        componentEntry(
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          hexToBytes(VECTOR_COMPONENT_HEX),
        ),
      ]),
    );
    let thrown: AccountIdentityProofError | undefined;
    try {
      assertNoAccountIdentityProofComponent(
        [dictionaryWithProofData],
        "group-info",
      );
    } catch (err) {
      thrown = err as AccountIdentityProofError;
    }
    expect(thrown?.reason).toBe("invalid-location");
    expect(thrown?.message).toContain("group-info");
  });

  it("does not throw for a dictionary without 0x8009 or a list with no dictionary extension", () => {
    const noProofDict = makeAppDataDictionaryExtension(
      buildAppDataDictionary([appComponentsEntry([0x0001, 0x8003])]),
    );
    expect(() =>
      assertNoAccountIdentityProofComponent([noProofDict], "group-info"),
    ).not.toThrow();
    expect(() =>
      assertNoAccountIdentityProofComponent([], "group-info"),
    ).not.toThrow();
  });
});
