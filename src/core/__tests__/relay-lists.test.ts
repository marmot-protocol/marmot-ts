import { NostrEvent } from "applesauce-core/helpers";
import { describe, expect, it } from "vitest";

import {
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  getInboxRelays,
  getNip65Relays,
  isValidInboxRelayListEvent,
  isValidNip65RelayListEvent,
} from "../relay-lists.js";
import { INBOX_RELAY_LIST_KIND, NIP65_RELAY_LIST_KIND } from "../protocol.js";

const mockPubkey =
  "02a1633cafe37eeebe2b39b4ec5f3d74c35e61fa7e7e6b7b8c5f7c4f3b2a1b2c3d";
const mockSig = "304502210...";
const mockId = "abc123...";

function event(kind: number, tags: string[][]): NostrEvent {
  return {
    kind,
    tags,
    content: "",
    created_at: 1693876543,
    pubkey: mockPubkey,
    id: mockId,
    sig: mockSig,
  };
}

describe("getNip65Relays", () => {
  it("reads and normalizes relay URLs from r tags on a kind 10002 event", () => {
    const relays = getNip65Relays(
      event(NIP65_RELAY_LIST_KIND, [
        ["r", "wss://inbox.nostr.wine"],
        ["r", "wss://myrelay.nostr1.com"],
      ]),
    );
    expect(relays).toEqual([
      "wss://inbox.nostr.wine/",
      "wss://myrelay.nostr1.com/",
    ]);
  });

  it("ignores non-r tags and malformed/invalid relay URLs", () => {
    const relays = getNip65Relays(
      event(NIP65_RELAY_LIST_KIND, [
        ["r", "wss://valid.relay.com"],
        ["r"],
        ["r", ""],
        ["r", "not-a-valid-url"],
        ["r", "https://wrong-protocol.com"],
        ["relay", "wss://wrong-tag.com"],
        ["r", "wss://another.valid.com"],
      ]),
    );
    expect(relays).toEqual([
      "wss://valid.relay.com/",
      "wss://another.valid.com/",
    ]);
  });

  it("honors read/write markers when a usage filter is given", () => {
    const e = event(NIP65_RELAY_LIST_KIND, [
      ["r", "wss://both.relay.com"], // markerless -> counts as both
      ["r", "wss://read.relay.com", "read"],
      ["r", "wss://write.relay.com", "write"],
    ]);
    expect(getNip65Relays(e, "write")).toEqual([
      "wss://both.relay.com/",
      "wss://write.relay.com/",
    ]);
    expect(getNip65Relays(e, "read")).toEqual([
      "wss://both.relay.com/",
      "wss://read.relay.com/",
    ]);
    // No filter returns every advertised relay.
    expect(getNip65Relays(e)).toHaveLength(3);
  });
});

describe("isValidNip65RelayListEvent", () => {
  it("is true for a kind 10002 event with at least one valid relay", () => {
    expect(
      isValidNip65RelayListEvent(
        event(NIP65_RELAY_LIST_KIND, [["r", "wss://inbox.nostr.wine"]]),
      ),
    ).toBe(true);
  });

  it("is false for the wrong kind or with no valid relays", () => {
    expect(
      isValidNip65RelayListEvent(event(443, [["r", "wss://inbox.nostr.wine"]])),
    ).toBe(false);
    expect(
      isValidNip65RelayListEvent(event(NIP65_RELAY_LIST_KIND, [["r"]])),
    ).toBe(false);
  });
});

describe("createNip65RelayListEvent", () => {
  it("builds a kind 10002 event with markerless r tags", () => {
    const e = createNip65RelayListEvent({
      pubkey: mockPubkey,
      relays: ["wss://relay.one", "not-a-url", "wss://relay.two"],
    });
    expect(e.kind).toBe(NIP65_RELAY_LIST_KIND);
    expect(e.tags).toEqual([
      ["r", "wss://relay.one/"],
      ["r", "wss://relay.two/"],
    ]);
  });

  it("applies a usage marker to every relay when given", () => {
    const e = createNip65RelayListEvent({
      pubkey: mockPubkey,
      relays: ["wss://relay.one"],
      usage: "write",
    });
    expect(e.tags).toEqual([["r", "wss://relay.one/", "write"]]);
  });
});

describe("inbox relay list (kind 10050)", () => {
  it("reads relay tags from a kind 10050 event", () => {
    expect(
      getInboxRelays(
        event(INBOX_RELAY_LIST_KIND, [
          ["relay", "wss://inbox.one"],
          ["relay", "wss://inbox.two"],
          ["r", "wss://wrong-tag.com"],
        ]),
      ),
    ).toEqual(["wss://inbox.one/", "wss://inbox.two/"]);
  });

  it("validates a kind 10050 event", () => {
    expect(
      isValidInboxRelayListEvent(
        event(INBOX_RELAY_LIST_KIND, [["relay", "wss://inbox.one"]]),
      ),
    ).toBe(true);
    expect(
      isValidInboxRelayListEvent(
        event(NIP65_RELAY_LIST_KIND, [["relay", "wss://inbox.one"]]),
      ),
    ).toBe(false);
  });

  it("builds a kind 10050 event with relay tags", () => {
    const e = createInboxRelayListEvent({
      pubkey: mockPubkey,
      relays: ["wss://inbox.one"],
    });
    expect(e.kind).toBe(INBOX_RELAY_LIST_KIND);
    expect(e.tags).toEqual([["relay", "wss://inbox.one/"]]);
  });
});
