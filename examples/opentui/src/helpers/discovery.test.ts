import { describe, expect, test } from "bun:test";

import { EventStore } from "applesauce-core/event-store";
import { DnsIdentityLoader } from "applesauce-loaders/loaders";

import { Directory } from "./discovery.js";

const PUBKEY = "ab".repeat(32);

function directoryWithResponse(response: Response): Directory {
  const loader = new DnsIdentityLoader();
  loader.fetch = async () => response;
  return new Directory(new EventStore(), loader);
}

describe("Directory.resolveNip05", () => {
  test("resolves an identifier with relay hints", async () => {
    const directory = directoryWithResponse(
      Response.json({
        names: { alice: PUBKEY },
        relays: { [PUBKEY]: ["wss://relay.example.com"] },
      }),
    );

    await expect(directory.resolveNip05("Alice@Example.COM")).resolves.toEqual({
      pubkey: PUBKEY,
      relays: ["wss://relay.example.com"],
    });
  });

  test("reports an identifier missing from the DNS document", async () => {
    const directory = directoryWithResponse(Response.json({ names: {} }));

    await expect(directory.resolveNip05("alice@example.com")).rejects.toThrow(
      "NIP-05 identifier not found: alice@example.com",
    );
  });

  test("reports DNS request failures", async () => {
    const directory = directoryWithResponse(
      new Response(null, { status: 500 }),
    );

    await expect(directory.resolveNip05("alice@example.com")).rejects.toThrow(
      "failed to resolve NIP-05 identifier alice@example.com",
    );
  });

  test("rejects malformed identifiers without a request", async () => {
    const loader = new DnsIdentityLoader();
    let requested = false;
    loader.fetch = async () => {
      requested = true;
      return Response.json({ names: {} });
    };
    const directory = new Directory(new EventStore(), loader);

    await expect(directory.resolveNip05("not an identifier")).rejects.toThrow(
      "invalid NIP-05 identifier",
    );
    expect(requested).toBe(false);
  });
});
