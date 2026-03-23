import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { NostrEvent } from "nostr-tools";
import {
  createWelcomeRumor,
  getWelcome,
  getWelcomeEpochAuthenticator,
} from "../core/welcome";
import {
  WELCOME_EPOCH_AUTHENTICATOR_TAG,
  WELCOME_EVENT_KIND,
} from "../core/protocol";

describe("spec compliance (MIP-02)", () => {
  it("should reject decoding kind 444 events that are missing an encoding=base64 tag", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "00",
      tags: [],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/encoding=base64 tag/i);
  });

  it("should reject decoding kind 444 events with encoding=hex", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "00",
      tags: [["encoding", "hex"]],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/encoding=base64 tag/i);
  });

  it("should include and decode the optional epoch authenticator tag", () => {
    const epochAuthenticator = new Uint8Array([1, 2, 3, 4]);

    const event = createWelcomeRumor({
      welcome: {
        cipherSuite: 1,
        secrets: [],
        encryptedGroupInfo: new Uint8Array(),
      },
      author: "0".repeat(64),
      groupRelays: ["wss://relay.example"],
      epochAuthenticator,
    });

    expect(
      event.tags.find((tag) => tag[0] === WELCOME_EPOCH_AUTHENTICATOR_TAG),
    ).toEqual([
      WELCOME_EPOCH_AUTHENTICATOR_TAG,
      bytesToHex(epochAuthenticator),
    ]);
    expect(getWelcomeEpochAuthenticator(event)).toEqual(epochAuthenticator);
  });

  it("should reject malformed epoch authenticator tags", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "00",
      tags: [
        ["encoding", "base64"],
        [WELCOME_EPOCH_AUTHENTICATOR_TAG, "not-hex"],
      ],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcomeEpochAuthenticator(event)).toThrow(
      /Invalid ea tag/i,
    );
  });
});
