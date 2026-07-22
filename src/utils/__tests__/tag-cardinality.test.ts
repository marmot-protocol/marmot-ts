import { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it } from "vitest";

import {
  getListTag,
  getSingletonTagValue,
  TAG_CARDINALITY,
} from "../tag-cardinality.js";

function makeEvent(tags: string[][]): NostrEvent {
  return {
    id: "0".repeat(64),
    pubkey: "0".repeat(64),
    created_at: 0,
    kind: 1,
    tags,
    content: "",
    sig: "0".repeat(128),
  };
}

describe("getSingletonTagValue", () => {
  it("returns the value for a single tag with exactly one value", () => {
    expect(getSingletonTagValue(makeEvent([["h", "abc"]]), "h")).toBe("abc");
  });

  it("returns undefined when the tag is absent", () => {
    expect(getSingletonTagValue(makeEvent([]), "h")).toBeUndefined();
  });

  it("returns undefined when the tag is repeated", () => {
    expect(
      getSingletonTagValue(
        makeEvent([
          ["h", "abc"],
          ["h", "def"],
        ]),
        "h",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the tag has no value", () => {
    expect(getSingletonTagValue(makeEvent([["h"]]), "h")).toBeUndefined();
  });

  it("returns undefined when the tag has an extra value", () => {
    expect(
      getSingletonTagValue(makeEvent([["h", "a", "b"]]), "h"),
    ).toBeUndefined();
  });

  it("returns undefined when the tag's value is empty", () => {
    expect(getSingletonTagValue(makeEvent([["h", ""]]), "h")).toBeUndefined();
  });
});

describe("getListTag", () => {
  it("returns all values for a single non-empty non-duplicate tag", () => {
    expect(getListTag(makeEvent([["relays", "r1", "r2"]]), "relays")).toEqual([
      "r1",
      "r2",
    ]);
  });

  it("returns undefined when the tag is absent", () => {
    expect(getListTag(makeEvent([]), "relays")).toBeUndefined();
  });

  it("returns undefined when the tag is repeated", () => {
    expect(
      getListTag(
        makeEvent([
          ["relays", "r1"],
          ["relays", "r2"],
        ]),
        "relays",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the tag is empty", () => {
    expect(getListTag(makeEvent([["relays"]]), "relays")).toBeUndefined();
  });

  it("returns undefined when the tag contains duplicate values", () => {
    expect(
      getListTag(makeEvent([["relays", "r1", "r1"]]), "relays"),
    ).toBeUndefined();
  });
});

describe("TAG_CARDINALITY", () => {
  it("matches the #236 cardinality table (D-11)", () => {
    expect(TAG_CARDINALITY[445]["h"]).toBe("singleton");
    expect(TAG_CARDINALITY[1059]["p"]).toBe("singleton");
    expect(TAG_CARDINALITY[444]["e"]).toBe("singleton");
    expect(TAG_CARDINALITY[444]["relays"]).toBe("list");
    expect(TAG_CARDINALITY[30443]["d"]).toBe("singleton");
    expect(TAG_CARDINALITY[30443]["i"]).toBe("singleton");
    expect(TAG_CARDINALITY[30443]["mls_protocol_version"]).toBe("singleton");
    expect(TAG_CARDINALITY[30443]["mls_ciphersuite"]).toBe("list");
    expect(TAG_CARDINALITY[30443]["mls_extensions"]).toBe("list");
    expect(TAG_CARDINALITY[30443]["mls_proposals"]).toBe("list");
    expect(TAG_CARDINALITY[30443]["app_components"]).toBe("list");
  });
});
