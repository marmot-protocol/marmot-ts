import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  deserializeApplicationData,
  serializeApplicationRumor,
  verifyApplicationRumorAuthorship,
} from "../application-rumor.js";

// Every "rejects" row below is a payload MDK drops (`MarmotAppEvent::decode`:
// serde with `deny_unknown_fields`, `u64` created_at/kind, exact id match).
// Accepting them here gave marmot-ts members a different transcript from
// White Noise members in the same group. Rows were also confirmed live: a
// marmot-ts member sent each one to an MDK (wn) member, which logged
// "dropping application message with invalid Marmot app event" for all.

const PUBKEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CREATED_AT = 1700000000;

const enc = (s: string) => new TextEncoder().encode(s);

/** NIP-01 id over the given preimage JSON text (no normalization). */
function idOf(preimage: string): string {
  return bytesToHex(sha256(enc(preimage)));
}

/** A valid payload, with its canonical id, as JSON text. */
function validPayload(content = "hi"): string {
  const id = idOf(JSON.stringify([0, PUBKEY, CREATED_AT, 9, [], content]));
  return JSON.stringify({
    id,
    pubkey: PUBKEY,
    created_at: CREATED_AT,
    kind: 9,
    tags: [],
    content,
  });
}

describe("deserializeApplicationData strictness (MDK parity)", () => {
  it("accepts a canonical payload in any member order and with whitespace", () => {
    const parsed = JSON.parse(validPayload());
    const reordered = `{ "content" : "hi", "tags": [ ], "kind": 9,\n "created_at": ${CREATED_AT}, "pubkey": "${PUBKEY}", "id": "${parsed.id}" }`;
    expect(deserializeApplicationData(enc(reordered)).id).toBe(parsed.id);
  });

  it("accepts the spec's kind 1210 vector", () => {
    const content = `{"v":1,"system_type":"group_disbanded","text":"Group disbanded","data":{"actor":"${PUBKEY}"}}`;
    const payload = JSON.stringify({
      id: "126e47076e4d0a75ed260b279c33ed433acd764fc80e2de2e0315a64116d1f52",
      pubkey: PUBKEY,
      created_at: CREATED_AT,
      kind: 1210,
      tags: [["system", "group_disbanded"]],
      content,
    });
    expect(deserializeApplicationData(enc(payload)).kind).toBe(1210);
  });

  it("accepts an MDK-produced id over control characters and non-ASCII", () => {
    // Sent by `wn messages send` (MDK HEAD ec6c2bc2); id as MDK computed it.
    const payload = JSON.stringify({
      id: "696796dcc6f074e63e9441a803b7293e50bcbe40640194bf42b9b00075559f19",
      pubkey:
        "4631637f31d9bcb674bd6a418ac2c50c429ecd925a7a998c0b1ac2f6f46df705",
      created_at: 1791157536,
      kind: 9,
      tags: [],
      content:
        'wn hello ünïcødé 🐿 "q" \\ tab\there\nnewline \u0001ctl \u007f del',
    });
    expect(() => deserializeApplicationData(enc(payload))).not.toThrow();
  });

  it("rejects an uppercase id", () => {
    const payload = JSON.parse(validPayload());
    payload.id = payload.id.toUpperCase();
    expect(() =>
      deserializeApplicationData(enc(JSON.stringify(payload))),
    ).toThrow(/id must be 64 lowercase hex/);
  });

  it("rejects an uppercase pubkey", () => {
    const pubkey = PUBKEY.toUpperCase();
    const id = idOf(JSON.stringify([0, pubkey, CREATED_AT, 9, [], "x"]));
    const payload = JSON.stringify({
      id,
      pubkey,
      created_at: CREATED_AT,
      kind: 9,
      tags: [],
      content: "x",
    });
    expect(() => deserializeApplicationData(enc(payload))).toThrow(
      /pubkey must be 64 lowercase hex/,
    );
  });

  it("rejects a duplicate member", () => {
    const payload = validPayload("same").replace(/}$/, ',"content":"same"}');
    expect(() => deserializeApplicationData(enc(payload))).toThrow(
      /duplicate member "content"/,
    );
  });

  it.each([
    ["a fraction", `${CREATED_AT}.5`, CREATED_AT + 0.5],
    ["a trailing .0", `${CREATED_AT}.0`, CREATED_AT],
    ["an exponent", "1.7e9", 1.7e9],
    ["a negative value", "-1", -1],
  ])("rejects created_at written as %s", (_label, token, value) => {
    // The id is computed over the value JS would hash, so only the token
    // shape is wrong.
    const id = idOf(JSON.stringify([0, PUBKEY, value, 9, [], "x"]));
    const payload = `{"id":"${id}","pubkey":"${PUBKEY}","created_at":${token},"kind":9,"tags":[],"content":"x"}`;
    expect(() => deserializeApplicationData(enc(payload))).toThrow(
      /created_at must be a non-negative integer/,
    );
  });

  it("rejects a non-integer kind", () => {
    const id = idOf(JSON.stringify([0, PUBKEY, CREATED_AT, 9, [], "x"]));
    const payload = `{"id":"${id}","pubkey":"${PUBKEY}","created_at":${CREATED_AT},"kind":9.0,"tags":[],"content":"x"}`;
    expect(() => deserializeApplicationData(enc(payload))).toThrow(
      /kind must be a non-negative integer/,
    );
  });

  it("rejects an unpaired surrogate in content or tags", () => {
    const lone = "\ud800";
    const contentPayload = validPayload(`x${lone}`);
    expect(() => deserializeApplicationData(enc(contentPayload))).toThrow(
      /unpaired surrogate/,
    );

    const tags = [["t", lone]];
    const id = idOf(JSON.stringify([0, PUBKEY, CREATED_AT, 9, tags, "x"]));
    const tagPayload = JSON.stringify({
      id,
      pubkey: PUBKEY,
      created_at: CREATED_AT,
      kind: 9,
      tags,
      content: "x",
    });
    expect(() => deserializeApplicationData(enc(tagPayload))).toThrow(
      /tags must be arrays of strings/,
    );
  });

  it("rejects bytes that are not valid UTF-8", () => {
    const bytes = enc(validPayload("ab"));
    const i = bytes.indexOf("a".charCodeAt(0), 100);
    bytes[i] = 0xff;
    expect(() => deserializeApplicationData(bytes)).toThrow(/not valid UTF-8/);
  });

  it("rejects a leading byte-order mark", () => {
    const body = enc(validPayload());
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(() => deserializeApplicationData(bytes)).toThrow();
  });

  it("binds authorship by exact lowercase pubkey", () => {
    const payload = enc(validPayload());
    expect(verifyApplicationRumorAuthorship(payload, PUBKEY).pubkey).toBe(
      PUBKEY,
    );
    expect(() =>
      verifyApplicationRumorAuthorship(payload, "11".repeat(32)),
    ).toThrow(/does not match authenticated MLS sender/);
  });
});

describe("serializeApplicationRumor", () => {
  it("writes exactly the six members in canonical order", () => {
    const rumor = JSON.parse(validPayload());
    const signed = { ...rumor, sig: "00".repeat(64), extra: true };
    const text = new TextDecoder().decode(serializeApplicationRumor(signed));
    expect(Object.keys(JSON.parse(text))).toEqual([
      "id",
      "pubkey",
      "created_at",
      "kind",
      "tags",
      "content",
    ]);
    expect(text).not.toContain("sig");
  });

  it("refuses a rumor whose id is not canonical", () => {
    const rumor = JSON.parse(validPayload());
    rumor.id = "0".repeat(64);
    expect(() => serializeApplicationRumor(rumor)).toThrow(
      /does not match canonical event id/,
    );
  });
});
