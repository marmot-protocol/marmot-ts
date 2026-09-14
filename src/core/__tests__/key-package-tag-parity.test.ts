import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode, mlsMessageDecoder, wireformats } from "ts-mls";
import { describe, expect, it } from "vitest";

import lifetimeFixture from "../../__tests__/fixtures/key-package-lifetime-rust.json";
import tagFixture from "../../__tests__/fixtures/key-package-tags-rust.json";
import {
  getListTag,
  getSingletonTagValue,
  TAG_CARDINALITY,
} from "../../utils/tag-cardinality.js";
import { createKeyPackageEvent } from "../key-package-event.js";
import { KEY_PACKAGE_APP_COMPONENTS_TAG } from "../protocol.js";

/**
 * The pinned MDK tag fixture (`mdk_sha` `dbf45c83`) predates the spec rule
 * that the `app_components` tag MUST include `0x8009`
 * (`refs/marmot/transports/nostr.md`). Production now advertises it (via
 * `SUPPORTED_APP_COMPONENT_IDS`), inserted immediately before `0x800c`.
 * This helper projects the raw Rust fixture forward to what production is
 * expected to emit, without touching the pinned fixture bytes/hash.
 */
function withAccountIdentityProofTag(tags: string[][]): string[][] {
  return tags.map((tag) => {
    if (tag[0] !== KEY_PACKAGE_APP_COMPONENTS_TAG) return tag;
    const idx = tag.indexOf("0x800c");
    if (idx === -1) return tag;
    const withProof = [...tag];
    withProof.splice(idx, 0, "0x8009");
    return withProof;
  });
}

type TagFixture = {
  mdk_sha: string;
  tags: string[][];
  tags_sha256: string;
};

const SLOT_ID = "a1".repeat(32);

async function expectProductionTags(expectedTags: string[][]): Promise<void> {
  const message = decode(
    mlsMessageDecoder,
    hexToBytes(lifetimeFixture.lifetime.key_package_tls_hex),
  );
  if (!message || message.wireformat !== wireformats.mls_key_package)
    throw new Error("Rust fixture did not decode as an MLS KeyPackage");

  const event = await createKeyPackageEvent({
    keyPackage: message.keyPackage,
    identifier: SLOT_ID,
  });
  expect(event.tags).toEqual(expectedTags);
}

describe("MDK kind-30443 tag parity", () => {
  const rust = tagFixture as TagFixture;

  it("matches the Rust-produced canonical tag array and order, plus 0x8009 (refs/marmot/transports/nostr.md)", async () => {
    expect(rust.mdk_sha).toBe("dbf45c83a8e157302edd13010944ad2c6a9cf9a5");
    expect(
      bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(rust.tags)))),
    ).toBe(rust.tags_sha256);

    // The pinned fixture predates the 0x8009 tag rule; production tags equal
    // the fixture tags with "0x8009" inserted into app_components immediately
    // before "0x800c" (PITFALLS 14).
    await expectProductionTags(withAccountIdentityProofTag(rust.tags));
  });

  it("negative control rejects a mutated Rust oracle through production parity", async () => {
    const mutated = withAccountIdentityProofTag(
      rust.tags.map((tag) => [...tag]),
    );
    mutated[0][1] = "ff".repeat(32);
    await expect(expectProductionTags(mutated)).rejects.toThrow();
  });
});

describe("specification-derived required-tag rejection matrix", () => {
  for (const [kind, rules] of Object.entries(TAG_CARDINALITY)) {
    for (const [name, cardinality] of Object.entries(rules)) {
      const valid =
        cardinality === "singleton" ? [name, "value"] : [name, "one", "two"];
      const read = (tags: string[][]) =>
        cardinality === "singleton"
          ? getSingletonTagValue({ tags }, name)
          : getListTag({ tags }, name);

      describe(`kind ${kind} ${name} ${cardinality}`, () => {
        it.each([
          ["missing", []],
          ["repeated", [valid, [...valid]]],
          ["empty", [[name]]],
        ])("rejects %s form", (_shape, tags) => {
          expect(read(tags as string[][])).toBeUndefined();
        });

        if (cardinality === "singleton") {
          it("rejects an empty value", () => {
            expect(read([[name, ""]])).toBeUndefined();
          });

          it("rejects an extra value", () => {
            expect(read([[name, "one", "two"]])).toBeUndefined();
          });
        } else {
          it("rejects an empty list value", () => {
            expect(read([[name, "one", ""]])).toBeUndefined();
          });

          it("rejects duplicate list values", () => {
            expect(read([[name, "one", "one"]])).toBeUndefined();
          });
        }
      });
    }
  }
});
