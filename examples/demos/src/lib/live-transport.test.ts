import { describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { RelayPool } from "applesauce-relay";
import { Subject, of } from "rxjs";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { LiveTransport } from "./live-transport.js";

describe("live transport", () => {
  it("preserves relay acknowledgements, stores incoming events, and tears down", async () => {
    const store = new EventStore();
    const pool = new RelayPool();
    const event = await PrivateKeyAccount.generateNew().signer.signEvent({
      kind: 1,
      created_at: 1,
      content: "live test",
      tags: [],
    });
    const responses = [
      { from: "wss://accepted.example", ok: true },
      { from: "wss://rejected.example", ok: false, message: "blocked" },
    ];
    vi.spyOn(pool, "publish").mockResolvedValue(responses);
    vi.spyOn(pool, "request").mockReturnValue(of(event));
    const stream = new Subject<NostrEvent>();
    vi.spyOn(pool, "subscription").mockReturnValue(stream);
    const close = vi.spyOn(pool, "close");
    const transport = new LiveTransport(store, pool);
    const network = transport.network("you");
    try {
      expect(await network.publish(transport.relays, event)).toEqual(
        Object.fromEntries(
          responses.map((response) => [response.from, response]),
        ),
      );
      expect(await network.request(transport.relays, { kinds: [1] })).toEqual([
        event,
      ]);
      expect(store.hasEvent(event.id)).toBe(true);
      const next = vi.fn();
      network
        .subscription(transport.relays, { kinds: [1] })
        .subscribe({ next });
      stream.next(event);
      expect(next).toHaveBeenCalledWith(event);
      transport.close();
      stream.next(event);
      expect(next).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      await expect(network.request(transport.relays, {})).rejects.toThrow(
        "Transport closed",
      );
    } finally {
      transport.close();
      store.dispose();
    }
  });
});
