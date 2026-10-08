/**
 * Cross-implementation byte fixtures for marmot.transport.nostr.routing.v1.
 *
 * The JSON inputs are immutable upstream artifacts from the pinned MDK
 * submodule. Keep their fixture_name values as the Vitest case identifiers so
 * failures map directly to the reference corpus.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { BinaryWriter } from "../../binary.js";

import invalidDuplicateRelay from "../../../../refs/mdk/crates/cgka-conformance-simulator/vectors/byte-fixtures/nostr-routing-v1-invalid-duplicate-relay.v1.json";
import validState from "../../../../refs/mdk/crates/cgka-conformance-simulator/vectors/byte-fixtures/nostr-routing-v1-valid-state.v1.json";
import validUpdate from "../../../../refs/mdk/crates/cgka-conformance-simulator/vectors/byte-fixtures/nostr-routing-v1-valid-update.v1.json";
import {
  decodeNostrRoutingV1,
  encodeNostrRoutingV1,
} from "../nostr-routing.js";

type ValidRoutingFixture = typeof validState | typeof validUpdate;

function assertValidFixture(fixture: ValidRoutingFixture): void {
  const bytes = hexToBytes(fixture.bytes.hex);
  const decoded = decodeNostrRoutingV1(bytes);

  expect(bytesToHex(decoded.nostrGroupId)).toBe(
    fixture.expected.fields.nostr_group_id_hex,
  );
  expect(decoded.relays).toEqual(fixture.expected.fields.relays);
  expect(bytesToHex(encodeNostrRoutingV1(decoded))).toBe(fixture.bytes.hex);
}

describe("MDK nostr-routing byte fixtures", () => {
  it(validState.fixture_name, () => {
    assertValidFixture(validState);
  });

  it(validUpdate.fixture_name, () => {
    assertValidFixture(validUpdate);
  });

  it(invalidDuplicateRelay.fixture_name, () => {
    expect(() =>
      decodeNostrRoutingV1(hexToBytes(invalidDuplicateRelay.bytes.hex)),
    ).toThrow(/unique/);
  });
});

describe("nostr-routing relay count bound", () => {
  // nostr-routing-v1.md "Validation": the relay list contains at most 16
  // entries. MDK (`NOSTR_ROUTING_MAX_RELAYS`) rejects a 17-relay state on both
  // encode and decode, and drops a Welcome whose `relays` tag has 17 entries.
  const relays = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `wss://relay${String(i).padStart(2, "0")}.example`,
    );

  // Hand-built state bytes, bypassing the encoder, so the decoder is tested on
  // input a non-conforming peer could send.
  function rawState(urls: string[]): Uint8Array {
    const items = urls.map((u) =>
      new BinaryWriter().opaque(new TextEncoder().encode(u)).build(),
    );
    return new BinaryWriter()
      .bytes(new Uint8Array(32).fill(7))
      .vector(items)
      .build();
  }

  it("accepts exactly 16 relays", () => {
    const encoded = encodeNostrRoutingV1({
      nostrGroupId: new Uint8Array(32).fill(7),
      relays: relays(16),
    });
    expect(bytesToHex(encoded)).toBe(bytesToHex(rawState(relays(16))));
    expect(decodeNostrRoutingV1(encoded).relays).toEqual(relays(16));
  });

  it("refuses to encode 17 relays", () => {
    expect(() =>
      encodeNostrRoutingV1({
        nostrGroupId: new Uint8Array(32).fill(7),
        relays: relays(17),
      }),
    ).toThrow(/at most 16 relays/);
  });

  it("rejects 17-relay state bytes", () => {
    expect(() => decodeNostrRoutingV1(rawState(relays(17)))).toThrow(
      /at most 16 relays/,
    );
  });

  it("counts relays after deduplication when encoding", () => {
    const urls = [...relays(16), relays(16)[0]!];
    expect(
      decodeNostrRoutingV1(
        encodeNostrRoutingV1({
          nostrGroupId: new Uint8Array(32),
          relays: urls,
        }),
      ).relays,
    ).toHaveLength(16);
  });
});
