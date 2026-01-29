import { NostrEvent } from "applesauce-core/helpers";
import { describe, expect, it } from "vitest";

import {
  getKeyPackageRelayList,
  isValidKeyPackageRelayListEvent,
} from "../core/key-package-relay-list.js";

const mockPubkey =
  "02a1633cafe37eeebe2b39b4ec5f3d74c35e61fa7e7e6b7b8c5f7c4f3b2a1b2c3d";
const mockSig = "304502210...";
const mockId = "abc123...";

describe("getKeyPackageRelayList", () => {
  it("should extract and normalize relay URLs from a valid kind 10051 event", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay", "wss://inbox.nostr.wine"],
        ["relay", "wss://myrelay.nostr1.com"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([
      "wss://inbox.nostr.wine/",
      "wss://myrelay.nostr1.com/",
    ]);
  });

  it("should return empty array when no relay tags are present", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([]);
  });

  it("should filter out malformed relay tags and normalize valid ones", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay", "wss://inbox.nostr.wine"],
        ["relay"], // Missing URL
        ["relay", ""], // Empty URL
        ["relay", "wss://myrelay.nostr1.com"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([
      "wss://inbox.nostr.wine/",
      "wss://myrelay.nostr1.com/",
    ]);
  });

  it("should extract relay tags regardless of event kind", () => {
    const event: NostrEvent = {
      kind: 443, // Wrong kind, but function still processes tags
      tags: [["relay", "wss://inbox.nostr.wine"]],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    // Function doesn't validate kind, so it extracts and normalizes the relay
    expect(relays).toEqual(["wss://inbox.nostr.wine/"]);
  });

  it("should ignore non-relay tags and normalize relay URLs", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay", "wss://inbox.nostr.wine"],
        ["other", "some-value"],
        ["relay", "wss://myrelay.nostr1.com"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([
      "wss://inbox.nostr.wine/",
      "wss://myrelay.nostr1.com/",
    ]);
  });

  it("should filter out invalid relay URLs", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay", "wss://valid.relay.com"],
        ["relay", "not-a-valid-url"],
        ["relay", "https://wrong-protocol.com"],
        ["relay", "wss://another.valid.com"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([
      "wss://valid.relay.com/",
      "wss://another.valid.com/",
    ]);
  });

  it("should preserve paths and query parameters when normalizing", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay", "wss://relay.com/path"],
        ["relay", "wss://relay.com:8080/path?query=value"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    const relays = getKeyPackageRelayList(event);

    expect(relays).toEqual([
      "wss://relay.com/path",
      "wss://relay.com:8080/path?query=value",
    ]);
  });
});

describe("isValidKeyPackageRelayListEvent", () => {
  it("should return true for a valid kind 10051 event with relay tags", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [["relay", "wss://inbox.nostr.wine"]],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    expect(isValidKeyPackageRelayListEvent(event)).toBe(true);
  });

  it("should return false for wrong event kind", () => {
    const event: NostrEvent = {
      kind: 443,
      tags: [["relay", "wss://inbox.nostr.wine"]],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    expect(isValidKeyPackageRelayListEvent(event)).toBe(false);
  });

  it("should return false for event with no relay tags", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    expect(isValidKeyPackageRelayListEvent(event)).toBe(false);
  });

  it("should return false for event with only malformed relay tags", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [["relay"], ["relay", ""]],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    expect(isValidKeyPackageRelayListEvent(event)).toBe(false);
  });

  it("should return true even if only one valid relay tag exists", () => {
    const event: NostrEvent = {
      kind: 10051,
      tags: [
        ["relay"],
        ["relay", "wss://inbox.nostr.wine"],
        ["other", "value"],
      ],
      content: "",
      created_at: 1693876543,
      pubkey: mockPubkey,
      id: mockId,
      sig: mockSig,
    };

    expect(isValidKeyPackageRelayListEvent(event)).toBe(true);
  });
});
