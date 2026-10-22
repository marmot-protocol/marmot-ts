import { describe, expect, it, vi } from "vitest";
import { createBlossomMediaTransport } from "../media-blob-transport.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

describe("bounded media blob transport", () => {
  it("does not contact a locally denied destination", async () => {
    const fetcher = vi.fn();
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    await expect(
      transport.fetch({
        url: "http://127.0.0.1/blob",
        signal: new AbortController().signal,
        maxBytes: 20,
      }),
    ).rejects.toThrow(/denied/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streaming responses and disables redirects and credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(11));
              controller.close();
            },
          }),
        ),
    );
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    await expect(
      transport.fetch({
        url: "https://example.com/blob",
        signal: new AbortController().signal,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/byte limit/);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
  });
  it("preserves base paths on authenticated uploads and exact descriptor URLs", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ url: "https://example.com/custom?blob=1" }),
        ),
    );
    const transport = createBlossomMediaTransport({
      signer: testAccount(6).signer,
      fetch: fetcher,
    });
    expect(
      await transport.upload({
        baseUrl: "https://example.com/files/",
        data: Uint8Array.of(1),
        ciphertextSha256: "ab".repeat(32),
        signal: new AbortController().signal,
        maxBytes: 20,
      }),
    ).toBe("https://example.com/custom?blob=1");
    expect(fetcher.mock.calls[0][0]).toBe("https://example.com/files/upload");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      headers: { authorization: expect.stringMatching(/^Nostr /) },
    });
  });
});
