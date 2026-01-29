import { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it } from "vitest";
import {
  decodeContent,
  detectEncoding,
  encodeContent,
  getEncodingTag,
} from "../utils/encoding.js";

describe("encoding utilities", () => {
  // Test data
  const testBytes = new Uint8Array([
    0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64,
  ]); // "Hello World"
  const testHex = "48656c6c6f20576f726c64";
  const testBase64 = "SGVsbG8gV29ybGQ=";

  describe("encodeContent", () => {
    it("should encode to hex format", () => {
      const result = encodeContent(testBytes, "hex");
      expect(result).toBe(testHex);
    });

    it("should encode to base64 format", () => {
      const result = encodeContent(testBytes, "base64");
      expect(result).toBe(testBase64);
    });

    it("should handle empty bytes", () => {
      const emptyBytes = new Uint8Array([]);
      expect(encodeContent(emptyBytes, "hex")).toBe("");
      expect(encodeContent(emptyBytes, "base64")).toBe("");
    });

    it("should handle single byte", () => {
      const singleByte = new Uint8Array([0xff]);
      expect(encodeContent(singleByte, "hex")).toBe("ff");
      expect(encodeContent(singleByte, "base64")).toBe("/w==");
    });

    it("should handle large binary data", () => {
      const largeBytes = new Uint8Array(1000);
      for (let i = 0; i < largeBytes.length; i++) {
        largeBytes[i] = i % 256;
      }
      const hexResult = encodeContent(largeBytes, "hex");
      const base64Result = encodeContent(largeBytes, "base64");

      expect(hexResult.length).toBe(2000); // 2 chars per byte
      expect(base64Result.length).toBeLessThan(hexResult.length); // base64 is smaller
    });
  });

  describe("decodeContent", () => {
    it("should decode hex format explicitly", () => {
      const result = decodeContent(testHex, "hex");
      expect(result).toEqual(testBytes);
    });

    it("should decode base64 format explicitly", () => {
      const result = decodeContent(testBase64, "base64");
      expect(result).toEqual(testBytes);
    });

    it("should auto-detect and decode hex format", () => {
      const result = decodeContent(testHex);
      expect(result).toEqual(testBytes);
    });

    it("should auto-detect and decode base64 format", () => {
      const result = decodeContent(testBase64);
      expect(result).toEqual(testBytes);
    });

    it("should handle empty strings", () => {
      expect(decodeContent("", "hex")).toEqual(new Uint8Array([]));
      expect(decodeContent("", "base64")).toEqual(new Uint8Array([]));
    });

    it("should throw error for invalid hex", () => {
      expect(() => decodeContent("not-valid-hex", "hex")).toThrow();
    });

    it("should throw error for invalid base64", () => {
      expect(() => decodeContent("!!!invalid!!!", "base64")).toThrow();
    });

    it("should round-trip hex encoding", () => {
      const encoded = encodeContent(testBytes, "hex");
      const decoded = decodeContent(encoded, "hex");
      expect(decoded).toEqual(testBytes);
    });

    it("should round-trip base64 encoding", () => {
      const encoded = encodeContent(testBytes, "base64");
      const decoded = decodeContent(encoded, "base64");
      expect(decoded).toEqual(testBytes);
    });
  });

  describe("detectEncoding", () => {
    it("should detect hex encoding", () => {
      expect(detectEncoding(testHex)).toBe("hex");
    });

    it("should detect base64 encoding with padding", () => {
      expect(detectEncoding(testBase64)).toBe("base64");
    });

    it("should detect base64 encoding with + character", () => {
      const base64WithPlus = "SGVsbG8rV29ybGQ=";
      expect(detectEncoding(base64WithPlus)).toBe("base64");
    });

    it("should detect base64 encoding with / character", () => {
      const base64WithSlash = "SGVsbG8/V29ybGQ=";
      expect(detectEncoding(base64WithSlash)).toBe("base64");
    });

    it("should detect hex for even-length hex strings", () => {
      expect(detectEncoding("abcdef1234567890")).toBe("hex");
    });

    it("should detect base64 for odd-length strings", () => {
      expect(detectEncoding("abc")).toBe("base64");
    });

    it("should handle uppercase hex", () => {
      expect(detectEncoding("ABCDEF1234567890")).toBe("hex");
    });

    it("should handle mixed case hex", () => {
      expect(detectEncoding("AbCdEf1234567890")).toBe("hex");
    });

    it("should default to base64 for ambiguous cases", () => {
      // A string that could be either hex or base64
      const ambiguous = "ABCD"; // Valid hex and valid base64
      // Should prefer base64 for ambiguous cases
      expect(detectEncoding(ambiguous)).toBe("hex"); // Even length, all hex chars
    });

    it("should handle whitespace by trimming", () => {
      expect(detectEncoding(`  ${testHex}  `)).toBe("hex");
      expect(detectEncoding(`  ${testBase64}  `)).toBe("base64");
    });
  });

  describe("getEncodingTag", () => {
    it("should extract base64 encoding tag", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["encoding", "base64"]],
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBe("base64");
    });

    it("should extract hex encoding tag", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["encoding", "hex"]],
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBe("hex");
    });

    it("should return undefined when no encoding tag present", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["other", "tag"]],
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBeUndefined();
    });

    it("should return undefined for invalid encoding values", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["encoding", "invalid"]],
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBeUndefined();
    });

    it("should return undefined for malformed encoding tag", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["encoding"]], // Missing value
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBeUndefined();
    });

    it("should handle multiple tags and find encoding tag", () => {
      const event: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [
          ["e", "someid"],
          ["encoding", "base64"],
          ["relay", "wss://relay.example.com"],
        ],
        content: "",
        sig: "test",
      };
      expect(getEncodingTag(event)).toBe("base64");
    });
  });

  describe("size comparison", () => {
    it("should demonstrate base64 is smaller than hex", () => {
      // Create a realistic-sized binary payload (e.g., 500 bytes)
      const largeBytes = new Uint8Array(500);
      for (let i = 0; i < largeBytes.length; i++) {
        largeBytes[i] = Math.floor(Math.random() * 256);
      }

      const hexEncoded = encodeContent(largeBytes, "hex");
      const base64Encoded = encodeContent(largeBytes, "base64");

      // Hex should be 2x the size (2 chars per byte)
      expect(hexEncoded.length).toBe(1000);

      // Base64 should be ~33% smaller than hex (4/3 of original size vs 2x)
      expect(base64Encoded.length).toBeLessThan(hexEncoded.length);

      // Verify the size reduction is approximately 33%
      const reduction =
        (hexEncoded.length - base64Encoded.length) / hexEncoded.length;
      expect(reduction).toBeGreaterThan(0.3); // At least 30% reduction
      expect(reduction).toBeLessThan(0.4); // At most 40% reduction
    });
  });

  describe("backward compatibility", () => {
    it("should decode legacy hex-encoded content without encoding tag", () => {
      const legacyEvent: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [], // No encoding tag
        content: testHex,
        sig: "test",
      };

      // Should default to hex when no encoding tag present
      const encodingFormat = getEncodingTag(legacyEvent) ?? "hex";
      expect(encodingFormat).toBe("hex");

      const decoded = decodeContent(legacyEvent.content, encodingFormat);
      expect(decoded).toEqual(testBytes);
    });

    it("should decode new base64-encoded content with encoding tag", () => {
      const newEvent: NostrEvent = {
        id: "test",
        pubkey: "test",
        created_at: 0,
        kind: 443,
        tags: [["encoding", "base64"]],
        content: testBase64,
        sig: "test",
      };

      const encodingFormat = getEncodingTag(newEvent) ?? "hex";
      expect(encodingFormat).toBe("base64");

      const decoded = decodeContent(newEvent.content, encodingFormat);
      expect(decoded).toEqual(testBytes);
    });
  });
});
