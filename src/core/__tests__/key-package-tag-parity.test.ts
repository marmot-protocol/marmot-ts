import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode, mlsMessageDecoder, wireformats } from "ts-mls";
import { describe, expect, it } from "vitest";

import lifetimeFixture from "../../__tests__/fixtures/key-package-lifetime-rust.json" with { type: "json" };
import tagFixture from "../../__tests__/fixtures/key-package-tags-rust.json" with { type: "json" };
import {
  getListTag,
  getSingletonTagValue,
  TAG_CARDINALITY,
} from "../../utils/tag-cardinality.js";
import {
  checkKeyPackageProposalsTag,
  createKeyPackageEvent,
} from "../key-package-event.js";
import { getAppComponents } from "../components/dictionary.js";
import type { GroupContextExtension } from "ts-mls";
import { KEY_PACKAGE_APP_COMPONENTS_TAG } from "../protocol.js";

/** Preserve the pinned historical tag oracle but select the actual signed leaf's components. */
function withCurrentImageAndProofTags(tags: string[][]): string[][] {
  const ids = getAppComponents(
    decodeRustKeyPackage().leafNode
      .extensions as unknown as GroupContextExtension[],
  )!;
  return tags.map((tag) =>
    tag[0] === KEY_PACKAGE_APP_COMPONENTS_TAG
      ? [
          tag[0],
          ...ids
            .filter((id) => id >= 0x8000)
            .map((id) => `0x${id.toString(16).padStart(4, "0")}`),
        ]
      : tag,
  );
}

type TagFixture = {
  mdk_sha: string;
  tags: string[][];
  tags_sha256: string;
};

const SLOT_ID = "a1".repeat(32);

function decodeRustKeyPackage() {
  const message = decode(
    mlsMessageDecoder,
    hexToBytes(lifetimeFixture.lifetime.key_package_tls_hex),
  );
  if (!message || message.wireformat !== wireformats.mls_key_package)
    throw new Error("Rust fixture did not decode as an MLS KeyPackage");
  return message.keyPackage;
}

async function expectProductionTags(expectedTags: string[][]): Promise<void> {
  const event = await createKeyPackageEvent({
    keyPackage: decodeRustKeyPackage(),
    identifier: SLOT_ID,
  });
  expect(event.tags).toEqual(expectedTags);
}

describe("MDK kind-30443 tag parity", () => {
  const rust = tagFixture as TagFixture;

  it("matches the Rust-produced tag order and the supplied signed leaf capabilities (refs/marmot/transports/nostr.md)", async () => {
    expect(rust.mdk_sha).toBe("798a3e07ede494d98c2ecf590c6e838a8c1dfcfe");
    expect(
      bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(rust.tags)))),
    ).toBe(rust.tags_sha256);

    // Preserve the immutable Rust oracle and project only the approved
    // current proof and implemented image support additions (PITFALLS 14).
    await expectProductionTags(withCurrentImageAndProofTags(rust.tags));
  });

  it("the Rust fixture's mls_proposals tag is an exact match for its KeyPackage", () => {
    expect(
      checkKeyPackageProposalsTag({ tags: rust.tags }, decodeRustKeyPackage()),
    ).toEqual({ kind: "match", mode: "exact" });
  });

  it("negative control rejects a mutated Rust oracle through production parity", async () => {
    const mutated = withCurrentImageAndProofTags(
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
