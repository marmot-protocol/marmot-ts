import { describe, it, expect } from "vitest";
import { isValidRelayUrl, normalizeRelayUrl } from "../relay-url.js";

describe("isValidRelayUrl", () => {
  it("should validate valid WebSocket URLs", () => {
    expect(isValidRelayUrl("wss://valid.relay.com")).toBe(true);
    expect(isValidRelayUrl("wss://another.valid.com")).toBe(true);
  });

  it("should reject invalid URLs", () => {
    expect(isValidRelayUrl("invalid-url")).toBe(false);
  });

  it("should accept both wss:// and ws:// protocols", () => {
    expect(isValidRelayUrl("wss://secure.relay.com")).toBe(true);
    expect(isValidRelayUrl("ws://insecure.relay.com")).toBe(true);
  });

  it("should reject non-WebSocket protocols", () => {
    expect(isValidRelayUrl("https://not-a-websocket.com")).toBe(false);
    expect(isValidRelayUrl("http://also-not-a-websocket.com")).toBe(false);
    expect(isValidRelayUrl("ftp://definitely-not.com")).toBe(false);
  });

  it("should reject completely invalid URLs", () => {
    expect(isValidRelayUrl("not a url")).toBe(false);
    expect(isValidRelayUrl("://missing-protocol")).toBe(false);
    expect(isValidRelayUrl("wss://")).toBe(false);
  });

  it("should handle URLs with paths and query parameters", () => {
    expect(isValidRelayUrl("wss://relay.com/path")).toBe(true);
    expect(isValidRelayUrl("wss://relay.com:8080/path?query=value")).toBe(true);
  });
});

describe("normalizeRelayUrl", () => {
  it("should normalize relay URLs consistently", () => {
    const url = "wss://relay.com/path";
    expect(normalizeRelayUrl(url)).toBe("wss://relay.com/path");
  });

  it("should preserve protocols", () => {
    expect(normalizeRelayUrl("wss://secure.relay.com")).toBe(
      "wss://secure.relay.com/",
    );
    expect(normalizeRelayUrl("ws://insecure.relay.com")).toBe(
      "ws://insecure.relay.com/",
    );
  });

  it("should preserve ports, paths, and query parameters", () => {
    expect(normalizeRelayUrl("wss://relay.com:8080/path?query=value")).toBe(
      "wss://relay.com:8080/path?query=value",
    );
  });

  it("should handle trailing slashes consistently", () => {
    // URL constructor adds trailing slash if no path
    expect(normalizeRelayUrl("wss://relay.com")).toBe("wss://relay.com/");
  });
});
