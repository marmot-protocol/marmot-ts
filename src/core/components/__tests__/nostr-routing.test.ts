/**
 * Cross-implementation byte fixtures for marmot.transport.nostr.routing.v1.
 *
 * The JSON inputs are immutable upstream artifacts from the pinned MDK
 * submodule. Keep their fixture_name values as the Vitest case identifiers so
 * failures map directly to the reference corpus.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

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
