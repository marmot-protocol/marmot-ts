/**
 * Tests for the group-member enumeration helpers, in particular that a leaf
 * carrying a malformed account identity degrades gracefully.
 */
import {
  type ClientState,
  type Credential,
  defaultCredentialTypes,
  nodeTypes,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../credential.js";
import { getGroupMembers } from "../group-members.js";

const VALID_A = "a".repeat(64);
const VALID_D = "d".repeat(64);

/** A basic credential whose identity is NOT a valid 32-byte hex key. */
function malformedBasicCredential(byteLength: number): Credential {
  return {
    credentialType: defaultCredentialTypes.basic,
    identity: new Uint8Array(byteLength).fill(7),
  } as unknown as Credential;
}

function fakeClientState(credentials: Credential[]): ClientState {
  return {
    ratchetTree: credentials.map((credential) => ({
      nodeType: nodeTypes.leaf,
      leaf: { credential },
    })),
  } as unknown as ClientState;
}

describe("getGroupMembers", () => {
  it("returns the nostr pubkey of every basic-credential leaf", () => {
    const state = fakeClientState([
      createCredential(VALID_A),
      createCredential(VALID_D),
    ]);
    expect(getGroupMembers(state).sort()).toEqual([VALID_A, VALID_D].sort());
  });

  /**
   * WR-15 regression: `getGroupMembers` filtered on `credentialType` but not
   * on identity validity, so a basic credential carrying a non-32-byte
   * identity made `getCredentialPubkey` throw and took the whole enumeration
   * with it.
   *
   * That matters because `deriveStateNotifications` calls this per link of an
   * applied rewind — AFTER `#setState(resolution.winnerTip)` has already
   * advanced canonical state — so a throw escaping there abandons the rewind
   * before `GroupSession.ingest` can persist it.
   * `marmotAuthService.validateCredential` gates identities on the inbound
   * path, but a state hydrated from a Welcome or a `ratchet_tree` extension is
   * not covered by that gate.
   */
  it("skips a basic-credential leaf whose identity is not a valid 32-byte hex key (WR-15)", () => {
    const state = fakeClientState([
      createCredential(VALID_A),
      malformedBasicCredential(16), // too short
      malformedBasicCredential(33), // too long
      createCredential(VALID_D),
    ]);

    // Does not throw, and reports exactly the well-formed members.
    expect(() => getGroupMembers(state)).not.toThrow();
    expect(getGroupMembers(state).sort()).toEqual([VALID_A, VALID_D].sort());
  });

  it("returns an empty list rather than throwing when every leaf is malformed", () => {
    const state = fakeClientState([malformedBasicCredential(16)]);
    expect(getGroupMembers(state)).toEqual([]);
  });
});
