/**
 * `marmot.group.encrypted-media.v2` (`0x800b`) codec parity with MDK
 * (`refs/mdk/crates/traits/src/app_components/tests.rs`
 * `encrypted_media_v2_*`) and the spec
 * (`refs/marmot/app-components/group-encrypted-media-v2.md`).
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  appDataUpdateProposalType,
  type GroupContextExtension,
  type Proposal,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { BinaryWriter, encodeUtf8 } from "../../binary.js";
import { validatePreApplyProposals } from "../../../engine/admin-policy.js";
import {
  encodeEncryptedMediaPolicyV1,
  encryptedMediaBlossomDefault,
  decodeEncryptedMediaPolicyV1,
} from "../encrypted-media.js";
import {
  DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS,
  decodeEncryptedMediaPolicyV2,
  encodeEncryptedMediaPolicyV2,
  encryptedMediaV2BlossomDefault,
  ENCRYPTED_MEDIA_FORMAT_V2,
  validateAndNormalizeBlobEndpointUrlV2,
} from "../encrypted-media-v2.js";
import {
  encryptedMediaV2Entry,
  getEncryptedMediaPolicyV2,
  makeAppComponentsExtension,
} from "../dictionary.js";
import {
  GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "../ids.js";

/** MDK `encrypted_media_v2_policy_has_independent_golden_bytes`. */
const MDK_GOLDEN_V2 =
  "12656e637279707465642d6d656469612d7632" + // "encrypted-media-v2"
  "0b0a626c6f73736f6d2d7631" + // ["blossom-v1"]
  "270a626c6f73736f6d2d76311b68747470733a2f2f626c6f73736f6d2e7072696d616c2e6e65742f"; // [{blossom-v1, https://blossom.primal.net/}]

/** Hand-builds policy bytes without producer normalization. */
function rawPolicy(
  format: string,
  kinds: string[],
  endpoints: Array<[string, string]>,
): Uint8Array {
  const allowed = new BinaryWriter();
  for (const kind of kinds) allowed.opaque(encodeUtf8(kind));
  const eps = new BinaryWriter();
  for (const [kind, url] of endpoints) {
    eps.opaque(encodeUtf8(kind));
    eps.opaque(encodeUtf8(url));
  }
  return new BinaryWriter()
    .opaque(encodeUtf8(format))
    .opaque(allowed.build())
    .opaque(eps.build())
    .build();
}

describe("encrypted-media.v2 (0x800b) codec", () => {
  it("matches MDK's golden bytes and round-trips", () => {
    const policy = encryptedMediaV2BlossomDefault([
      "https://blossom.primal.net",
    ]);
    expect(bytesToHex(encodeEncryptedMediaPolicyV2(policy))).toBe(
      MDK_GOLDEN_V2,
    );
    expect(decodeEncryptedMediaPolicyV2(hexToBytes(MDK_GOLDEN_V2))).toEqual(
      policy,
    );
  });

  it("never reinterprets v1 bytes as v2 or v2 bytes as v1", () => {
    expect(() =>
      decodeEncryptedMediaPolicyV1(hexToBytes(MDK_GOLDEN_V2)),
    ).toThrow(/format/);
    const v1 = encodeEncryptedMediaPolicyV1(
      encryptedMediaBlossomDefault(["https://blossom.primal.net"]),
    );
    expect(() => decodeEncryptedMediaPolicyV2(v1)).toThrow(/format/);
  });

  it("treats endpoint destination as local policy, not validity (MDK parity)", () => {
    for (const raw of [
      "http://10.0.0.1/media",
      "https://127.0.0.1/",
      "http://localhost:3000/",
    ]) {
      expect(validateAndNormalizeBlobEndpointUrlV2(raw)).toBe(raw);
    }
    for (const raw of [
      "ftp://media.example/",
      "https://user@media.example/",
      "https://media.example/?token=x",
      "https://media.example/?",
      "https://media.example/#fragment",
      "https://media.example/#",
    ]) {
      expect(() => validateAndNormalizeBlobEndpointUrlV2(raw)).toThrow();
    }
  });

  it("rejects duplicate and non-canonical stored state instead of repairing it", () => {
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(
          ENCRYPTED_MEDIA_FORMAT_V2,
          ["blossom-v1", "blossom-v1"],
          [["blossom-v1", "https://blossom.primal.net/"]],
        ),
      ),
    ).toThrow("encrypted media policy has a duplicate allowed locator kind");
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(
          ENCRYPTED_MEDIA_FORMAT_V2,
          ["blossom-v1"],
          [["blossom-v1", "https://blossom.primal.net"]],
        ),
      ),
    ).toThrow("encrypted media endpoint base URL is not normalized");
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(
          ENCRYPTED_MEDIA_FORMAT_V2,
          ["blossom-v1"],
          [
            ["blossom-v1", "https://a.example/"],
            ["blossom-v1", "https://a.example/"],
          ],
        ),
      ),
    ).toThrow("duplicate default blob endpoint");
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(
          ENCRYPTED_MEDIA_FORMAT_V2,
          ["Blossom-v1"],
          [["Blossom-v1", "https://a.example/"]],
        ),
      ),
    ).toThrow(/lowercase/);
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(
          ENCRYPTED_MEDIA_FORMAT_V2,
          ["blossom-v1"],
          [["ipfs-v1", "https://a.example/"]],
        ),
      ),
    ).toThrow("not allowed");
    expect(() =>
      decodeEncryptedMediaPolicyV2(
        rawPolicy(ENCRYPTED_MEDIA_FORMAT_V2, ["blossom-v1"], []),
      ),
    ).toThrow(/at least one default blob endpoint/);
    // Trailing bytes after the three vectors.
    const trailing = new Uint8Array([...hexToBytes(MDK_GOLDEN_V2), 0x00]);
    expect(() => decodeEncryptedMediaPolicyV2(trailing)).toThrow();
  });

  it("preserves producer order and keeps unsorted lists distinct", () => {
    const a = encryptedMediaV2BlossomDefault([
      "https://b.example",
      "https://a.example",
    ]);
    const b = encryptedMediaV2BlossomDefault([
      "https://a.example",
      "https://b.example",
    ]);
    expect(a.defaultBlobEndpoints.map((e) => e.baseUrl)).toEqual([
      "https://b.example/",
      "https://a.example/",
    ]);
    expect(bytesToHex(encodeEncryptedMediaPolicyV2(a))).not.toBe(
      bytesToHex(encodeEncryptedMediaPolicyV2(b)),
    );
    expect(
      decodeEncryptedMediaPolicyV2(encodeEncryptedMediaPolicyV2(a)),
    ).toEqual(a);
  });

  it("enforces the 16-entry bounds", () => {
    const many = Array.from({ length: 17 }, (_, i) => `https://e${i}.example`);
    expect(() => encryptedMediaV2BlossomDefault(many)).toThrow(/more than 16/);
  });

  it("builds the MDK default endpoint policy", () => {
    const policy = encryptedMediaV2BlossomDefault([
      ...DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS,
    ]);
    expect(policy.defaultBlobEndpoints.map((e) => e.baseUrl)).toEqual([
      "https://blossom.divine.video/",
      "https://blossom.ditto.pub/",
      "https://cdn.hzrd149.com/",
    ]);
  });
});

describe("encrypted-media.v2 (0x800b) registration", () => {
  it("is advertised in leaf capabilities alongside the frozen v1 id", () => {
    expect(GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID).toBe(0x800b);
    expect(SUPPORTED_APP_COMPONENT_IDS).toContain(0x800b);
    expect(SUPPORTED_APP_COMPONENT_IDS).toContain(0x8008);
  });

  it("reads back from a GroupContext dictionary", () => {
    const policy = encryptedMediaV2BlossomDefault(["https://a.example"]);
    const extensions = [
      makeAppComponentsExtension([encryptedMediaV2Entry(policy)]),
    ] as GroupContextExtension[];
    expect(getEncryptedMediaPolicyV2(extensions)).toEqual(policy);
  });

  it("validates AppDataUpdate payloads for 0x800b", () => {
    const update = (bytes: Uint8Array): Proposal => ({
      proposalType: appDataUpdateProposalType,
      appDataUpdate: {
        componentId: GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
        operation: "update",
        update: bytes,
      },
    });
    expect(
      validatePreApplyProposals(
        [
          update(
            encodeEncryptedMediaPolicyV2(
              encryptedMediaV2BlossomDefault(["https://a.example"]),
            ),
          ),
        ],
        1,
      ),
    ).toBeUndefined();
    // v1 bytes under the v2 id do not decode.
    expect(
      validatePreApplyProposals(
        [
          update(
            encodeEncryptedMediaPolicyV1(
              encryptedMediaBlossomDefault(["https://a.example"]),
            ),
          ),
        ],
        1,
      ),
    ).toMatchObject({ reason: "component-integrity" });
  });
});
