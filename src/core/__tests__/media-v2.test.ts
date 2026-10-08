/**
 * `encrypted-media-v2` message format: imeta parsing/encoding, media-type
 * profile, key derivation and AEAD, and fetch-candidate resolution, checked
 * against MDK's shared fixtures and vectors
 * (`refs/mdk/fixtures/encrypted-media/imeta-v2.json`,
 * `refs/mdk/crates/marmot-app/src/media/tests.rs`).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import imetaV2Fixture from "../../../refs/mdk/fixtures/encrypted-media/imeta-v2.json";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import {
  getGroupMediaPolicy,
  GroupMediaService,
  selectGroupMediaVersion,
} from "../../client/group/group-media-service.js";
import type { FetchLike } from "../../client/group/blossom.js";
import { GroupMediaStore } from "../../client/group/group-media-store.js";
import {
  getAppComponents,
  getEncryptedMediaPolicyV2,
} from "../components/dictionary.js";
import { encryptedMediaV2BlossomDefault } from "../components/encrypted-media-v2.js";
import { GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID } from "../components/ids.js";
import { createCredential } from "../credential.js";
import { createSimpleGroup } from "../group.js";
import { generateKeyPackage } from "../key-package.js";
import {
  blossomContentHashFromUrl,
  buildBlossomBlobUrl,
  buildBlossomUploadUrl,
  canonicalizeMimeTypeV2,
  decryptMediaFile,
  deriveMediaEncryptionKey,
  deriveMediaFileKeyFromSecret,
  encodeMediaImetaTag,
  ENCRYPTED_MEDIA_VERSION_V1,
  ENCRYPTED_MEDIA_VERSION_V2,
  encryptMediaFile,
  getMediaAttachmentOutcomes,
  isSafeBlossomFetchUrl,
  type MediaAttachment,
  MediaAttachmentRejection,
  parseMediaAttachment,
  resolveMediaFetchUrls,
} from "../media.js";

type FixtureCase = {
  name: string;
  valid: boolean;
  tag: string[];
  rejection_kind?: string;
  error_contains?: string;
  expected?: {
    version: string;
    locators: { kind: string; value: string }[];
    ciphertext_sha256: string;
    plaintext_sha256: string;
    nonce_hex: string;
    media_type: string;
    file_name: string;
    dim: string | null;
    thumbhash: string | null;
  };
};

const CASES = (imetaV2Fixture as { cases: FixtureCase[] }).cases;

/** MDK `valid_imeta_tag` with `v encrypted-media-v2`. */
function validV2Tag(): string[] {
  return [
    "imeta",
    "v encrypted-media-v2",
    `locator blossom-v1 https://media.example/${"ab".repeat(32)}.bin`,
    `ciphertext_sha256 ${"ab".repeat(32)}`,
    `plaintext_sha256 ${"cd".repeat(32)}`,
    `nonce ${"ef".repeat(12)}`,
    "m image/jpeg",
    "filename photo.jpg",
  ];
}

describe("MDK shared imeta-v2 fixture", () => {
  it("has the expected schema", () => {
    expect((imetaV2Fixture as { schema: string }).schema).toBe(
      "mdk-encrypted-media-imeta-fixture/v1",
    );
    expect(CASES.length).toBeGreaterThan(0);
  });

  for (const testCase of CASES) {
    it(`${testCase.name}: ${testCase.valid ? "accepts" : `rejects (${testCase.rejection_kind})`}`, () => {
      if (!testCase.valid) {
        let caught: unknown;
        try {
          parseMediaAttachment(testCase.tag);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(MediaAttachmentRejection);
        const rejection = caught as MediaAttachmentRejection;
        expect(rejection.kind).toBe(testCase.rejection_kind);
        expect(rejection.message).toContain(testCase.error_contains);
        return;
      }

      const expected = testCase.expected!;
      const parsed = parseMediaAttachment(testCase.tag);
      expect(parsed).toEqual({
        version: expected.version,
        locators: expected.locators,
        ciphertextSha256: expected.ciphertext_sha256,
        plaintextSha256: expected.plaintext_sha256,
        nonce: expected.nonce_hex,
        mediaType: expected.media_type,
        filename: expected.file_name,
        ...(expected.dim !== null ? { dim: expected.dim } : {}),
        ...(expected.thumbhash !== null
          ? { thumbhash: expected.thumbhash }
          : {}),
      });
      // Exact wire round-trip, including present-empty optional fields.
      expect(encodeMediaImetaTag(parsed)).toEqual(testCase.tag);
    });
  }
});

describe("encrypted-media-v2 imeta validation", () => {
  it("keeps v2 locator validity independent of destination policy", () => {
    const tag = validV2Tag();
    tag[2] = "locator blossom-v1 http://10.0.0.1/blob";
    expect(parseMediaAttachment(tag).locators[0].value).toBe(
      "http://10.0.0.1/blob",
    );
    tag[2] = "locator blossom-v1 ftp://media.example/blob";
    expect(() => parseMediaAttachment(tag)).toThrow(/http or https/);
  });

  it("keeps a well-formed out-of-policy locator kind (unfetchable, not invalid)", () => {
    const tag = validV2Tag();
    tag.splice(3, 0, "locator ipfs-v1 ipfs://bafy");
    expect(parseMediaAttachment(tag).locators).toHaveLength(2);
  });

  it("rejects blurhash, duplicate v, and value-less fields", () => {
    expect(() =>
      parseMediaAttachment([...validV2Tag(), "blurhash LEHV6nWB"]),
    ).toThrow(/blurhash/);
    const dupV = () =>
      parseMediaAttachment([...validV2Tag(), "v encrypted-media-v2"]);
    expect(dupV).toThrow(MediaAttachmentRejection);
    expect(() => parseMediaAttachment([...validV2Tag(), "dim"])).toThrow(
      /missing its value/,
    );
  });

  it("accepts uppercase hex like MDK's hex decoder", () => {
    const tag = validV2Tag();
    tag[3] = `ciphertext_sha256 ${"AB".repeat(32)}`;
    expect(parseMediaAttachment(tag).ciphertextSha256).toBe("AB".repeat(32));
  });

  it("makes rejection attachment-local", () => {
    const bad = validV2Tag().filter((f) => !f.startsWith("nonce "));
    const outcomes = getMediaAttachmentOutcomes([
      ["p", "x"],
      bad,
      validV2Tag(),
    ]);
    expect(outcomes.map((o) => [o.kind, o.attachmentIndex])).toEqual([
      ["rejected", 0],
      ["accepted", 1],
    ]);
  });

  it("still parses frozen v1 references", () => {
    const tag = validV2Tag();
    tag[1] = "v encrypted-media-v1";
    expect(parseMediaAttachment(tag).version).toBe(ENCRYPTED_MEDIA_VERSION_V1);
  });
});

describe("canonicalizeMimeTypeV2 (MDK encrypted_media_v2_media_type_profile_is_exact)", () => {
  it("applies the exact trim set and alias", () => {
    expect(
      canonicalizeMimeTypeV2("\t\n\u000c\r IMAGE/JPG ; charset=utf-8 "),
    ).toBe("image/jpeg");
    expect(canonicalizeMimeTypeV2("application/vnd.test+json")).toBe(
      "application/vnd.test+json",
    );
  });

  it.each([
    "\u000bimage/png",
    " image/png",
    "image/png/extra",
    "image",
    `${"a".repeat(64)}/${"b".repeat(64)}`,
    "image/pn g",
  ])("rejects %j", (value) => {
    expect(() => canonicalizeMimeTypeV2(value)).toThrow();
  });
});

describe("encrypted-media-v2 key derivation and AEAD", () => {
  // MDK encrypted_media_v2_kdf_and_aad_are_independent_from_v1.
  const secret = new Uint8Array(32).fill(7);
  const fields = {
    plaintextSha256: "22".repeat(32),
    mediaType: "image/jpeg",
    filename: " Photo.JPG ",
  };
  const MDK_V2_KEY =
    "5fcb5672b9cb2b3ac7915fd9c97697877837f7fb1312034486f400f601cd16b5";
  const MDK_V2_AAD =
    "656e637279707465642d6d656469612d763200222222222222222222222222222222222222222222222222222222222222222200696d6167652f6a706567002050686f746f2e4a504720";

  it("derives MDK's v2 file key, independent of v1", () => {
    const v2 = deriveMediaFileKeyFromSecret(secret, {
      ...fields,
      version: ENCRYPTED_MEDIA_VERSION_V2,
    });
    const v1 = deriveMediaFileKeyFromSecret(secret, {
      ...fields,
      version: ENCRYPTED_MEDIA_VERSION_V1,
    });
    expect(bytesToHex(v2)).toBe(MDK_V2_KEY);
    expect(bytesToHex(v1)).not.toBe(MDK_V2_KEY);
  });

  it("decrypts a blob sealed with MDK's v2 AAD bytes", () => {
    const plaintext = new TextEncoder().encode("hello from MDK");
    const plaintextSha256 = bytesToHex(sha256(plaintext));
    const key = deriveMediaFileKeyFromSecret(secret, {
      ...fields,
      plaintextSha256,
      version: ENCRYPTED_MEDIA_VERSION_V2,
    });
    // Rebuild MDK's AAD layout for this plaintext hash.
    const aad = hexToBytes(
      MDK_V2_AAD.replace("22".repeat(32), plaintextSha256),
    );
    const nonce = new Uint8Array(12).fill(3);
    const encrypted = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
    const attachment: MediaAttachment = {
      version: ENCRYPTED_MEDIA_VERSION_V2,
      locators: [],
      ciphertextSha256: bytesToHex(sha256(encrypted)),
      plaintextSha256,
      nonce: bytesToHex(nonce),
      mediaType: fields.mediaType,
      filename: fields.filename,
    };
    expect(decryptMediaFile(encrypted, key, attachment)).toEqual(plaintext);
    // The same bytes never open as v1.
    expect(() =>
      decryptMediaFile(encrypted, key, {
        ...attachment,
        version: ENCRYPTED_MEDIA_VERSION_V1,
      }),
    ).toThrow(/did not authenticate/);
  });

  it("encrypts v2 with canonical media type, exact filename and fresh nonces", () => {
    const file = new TextEncoder().encode("same file");
    const plaintextSha256 = bytesToHex(sha256(file));
    const input = {
      version: ENCRYPTED_MEDIA_VERSION_V2,
      plaintextSha256,
      mediaType: "image/jpeg",
      filename: "a b.jpg",
    } as const;
    const key = deriveMediaFileKeyFromSecret(secret, input);
    const one = encryptMediaFile(file, key, {
      ...input,
      mediaType: "IMAGE/JPG",
    });
    const two = encryptMediaFile(file, key, input);
    expect(one.attachment.version).toBe(ENCRYPTED_MEDIA_VERSION_V2);
    expect(one.attachment.mediaType).toBe("image/jpeg");
    expect(one.attachment.filename).toBe("a b.jpg");
    expect(one.attachment.nonce).not.toBe(two.attachment.nonce);
    expect(decryptMediaFile(one.encrypted, key, one.attachment)).toEqual(file);
  });

  it("refuses non-canonical media types and bad filenames for v2", () => {
    expect(() =>
      deriveMediaFileKeyFromSecret(secret, {
        ...fields,
        mediaType: "Image/JPEG",
        version: ENCRYPTED_MEDIA_VERSION_V2,
      }),
    ).toThrow(/not canonical/);
    expect(() =>
      deriveMediaFileKeyFromSecret(secret, {
        ...fields,
        filename: "a\0b",
        version: ENCRYPTED_MEDIA_VERSION_V2,
      }),
    ).toThrow(/file name/);
    expect(() =>
      deriveMediaFileKeyFromSecret(secret, {
        ...fields,
        filename: "x".repeat(256),
        version: ENCRYPTED_MEDIA_VERSION_V2,
      }),
    ).toThrow(/file name/);
  });
});

describe("encrypted-media-v2 fetch candidates", () => {
  const hash = "ab".repeat(32);
  const base: MediaAttachment = {
    version: ENCRYPTED_MEDIA_VERSION_V2,
    locators: [],
    ciphertextSha256: hash,
    plaintextSha256: "cd".repeat(32),
    nonce: "ef".repeat(12),
    mediaType: "image/jpeg",
    filename: "photo.jpg",
  };

  it("builds spec fallback and upload URLs", () => {
    expect(buildBlossomBlobUrl("https://b.example/", hash)).toBe(
      `https://b.example/${hash}`,
    );
    expect(buildBlossomBlobUrl("https://b.example/base//", hash)).toBe(
      `https://b.example/base/${hash}`,
    );
    expect(buildBlossomUploadUrl("https://b.example/")).toBe(
      "https://b.example/upload",
    );
    expect(blossomContentHashFromUrl(`https://x.example/${hash}.bin`)).toBe(
      hash,
    );
    expect(blossomContentHashFromUrl("https://x.example/blob")).toBeUndefined();
  });

  it("orders explicit locators before policy fallbacks, filtering unsafe and non-committing URLs", () => {
    const policy = encryptedMediaV2BlossomDefault([
      "https://fallback.example",
      "http://127.0.0.1:3000",
    ]);
    const attachment: MediaAttachment = {
      ...base,
      locators: [
        { kind: "blossom-v1", value: `https://cdn.example/${hash}.bin` },
        { kind: "blossom-v1", value: "https://cdn.example/other" },
        { kind: "blossom-v1", value: `http://10.0.0.1/${hash}` },
        { kind: "ipfs-v1", value: "ipfs://bafy" },
      ],
    };
    expect(resolveMediaFetchUrls(attachment, policy)).toEqual([
      `https://cdn.example/${hash}.bin`,
      `https://fallback.example/${hash}`,
    ]);
    expect(
      resolveMediaFetchUrls(attachment, policy, { allowLoopbackHttp: true }),
    ).toEqual([
      `https://cdn.example/${hash}.bin`,
      `https://fallback.example/${hash}`,
      `http://127.0.0.1:3000/${hash}`,
    ]);
  });

  it("has nothing to fetch when the policy does not allow blossom-v1", () => {
    const policy = {
      mediaFormat: "encrypted-media-v2",
      allowedLocatorKinds: ["ipfs-v1"],
      defaultBlobEndpoints: [
        { locatorKind: "ipfs-v1", baseUrl: "https://ipfs.example/" },
      ],
    };
    const attachment: MediaAttachment = {
      ...base,
      locators: [{ kind: "blossom-v1", value: `https://cdn.example/${hash}` }],
    };
    expect(resolveMediaFetchUrls(attachment, policy)).toEqual([]);
  });

  it("applies MDK's destination safety", () => {
    expect(isSafeBlossomFetchUrl("https://cdn.example/x")).toBe(true);
    expect(isSafeBlossomFetchUrl("https://127.0.0.1/x")).toBe(false);
    expect(isSafeBlossomFetchUrl("https://192.168.1.1/x")).toBe(false);
    expect(isSafeBlossomFetchUrl("http://cdn.example/x")).toBe(false);
    expect(isSafeBlossomFetchUrl("http://localhost:3000/x")).toBe(false);
    expect(
      isSafeBlossomFetchUrl("http://localhost:3000/x", {
        allowLoopbackHttp: true,
      }),
    ).toBe(true);
    expect(isSafeBlossomFetchUrl("https://u:p@cdn.example/x")).toBe(false);
  });
});

describe("group media v2", () => {
  async function makeGroup(
    options: Parameters<typeof createSimpleGroup>[3] = {},
  ) {
    const account = testAccount(7);
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const keyPackage = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      ciphersuiteImpl: ciphersuite,
      signer: account.signer,
    });
    const { clientState } = await createSimpleGroup(
      keyPackage,
      ciphersuite,
      "Media group",
      options,
    );
    return { clientState, ciphersuite, account };
  }

  it("creates groups that carry and require 0x800b by default (MDK parity)", async () => {
    const { clientState } = await makeGroup();
    const extensions = clientState.groupContext.extensions;
    expect(getAppComponents(extensions)).toContain(
      GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
    );
    expect(
      getEncryptedMediaPolicyV2(extensions)?.defaultBlobEndpoints.map(
        (e) => e.baseUrl,
      ),
    ).toEqual([
      "https://blossom.divine.video/",
      "https://blossom.ditto.pub/",
      "https://cdn.hzrd149.com/",
    ]);
    expect(selectGroupMediaVersion(clientState)).toBe(
      ENCRYPTED_MEDIA_VERSION_V2,
    );
  });

  it("lets a non-media group opt out", async () => {
    const { clientState } = await makeGroup({ encryptedMedia: false });
    const extensions = clientState.groupContext.extensions;
    expect(getAppComponents(extensions)).not.toContain(
      GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
    );
    expect(getGroupMediaPolicy(clientState)).toBeUndefined();
    // Current-profile groups still send v2 references.
    expect(selectGroupMediaVersion(clientState)).toBe(
      ENCRYPTED_MEDIA_VERSION_V2,
    );
  });

  it("uploads to the policy endpoint and downloads + decrypts the reference", async () => {
    const { clientState, ciphersuite, account } = await makeGroup({
      encryptedMedia: encryptedMediaV2BlossomDefault(["https://blobs.example"]),
    });

    // A tiny in-memory Blossom server.
    const blobs = new Map<string, Uint8Array>();
    const requests: string[] = [];
    const fetchMock: FetchLike = async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const ok = (body: Uint8Array | string) => ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          (typeof body === "string"
            ? new TextEncoder().encode(body)
            : body
          ).slice().buffer as ArrayBuffer,
        text: async () =>
          typeof body === "string" ? body : new TextDecoder().decode(body),
      });
      if (init?.method === "PUT") {
        expect(init.headers?.Authorization).toMatch(/^Nostr /);
        const hash = bytesToHex(sha256(init.body!));
        expect(init.headers?.["X-SHA-256"]).toBe(hash);
        blobs.set(hash, init.body!);
        return ok(
          JSON.stringify({
            sha256: hash,
            url: `https://blobs.example/${hash}`,
          }),
        );
      }
      const hash = url.split("/").pop()!;
      const blob = blobs.get(hash);
      return blob
        ? ok(blob)
        : {
            ok: false,
            status: 404,
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => "",
          };
    };

    const service = new GroupMediaService({
      media: new GroupMediaStore(),
      getState: () => clientState,
      getCiphersuite: () => ciphersuite,
      getSigner: () => account.signer,
      fetch: fetchMock,
    });
    const file = new TextEncoder().encode("picture bytes");
    const { attachment } = await service.uploadMedia(
      new Blob([file], { type: "image/png" }),
      { filename: "pic.png" },
    );
    expect(attachment.version).toBe(ENCRYPTED_MEDIA_VERSION_V2);
    expect(attachment.locators).toEqual([
      {
        kind: "blossom-v1",
        value: `https://blobs.example/${attachment.ciphertextSha256}`,
      },
    ]);
    expect(requests).toEqual(["PUT https://blobs.example/upload"]);

    // A receiver parses the wire tag and downloads it.
    const tag = encodeMediaImetaTag(attachment);
    expect(tag[1]).toBe("v encrypted-media-v2");
    const receiver = new GroupMediaService({
      media: undefined,
      getState: () => clientState,
      getCiphersuite: () => ciphersuite,
      fetch: fetchMock,
    });
    const stored = await receiver.downloadMedia(parseMediaAttachment(tag));
    expect(stored.data).toEqual(file);

    // And the key matches a direct derivation for this epoch.
    const key = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    expect(key).toHaveLength(32);
  });
});
