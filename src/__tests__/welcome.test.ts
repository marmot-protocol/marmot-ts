import { describe, expect, it } from "vitest";

import type { NostrEvent } from "nostr-tools";
import { getWelcome } from "../core/welcome";
import { WELCOME_EVENT_KIND } from "../core/protocol";

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
});
