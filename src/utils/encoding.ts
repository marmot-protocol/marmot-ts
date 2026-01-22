import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { NostrEvent } from "applesauce-core/helpers/event";

/**
 * Encoding format for binary content in Nostr events.
 * - 'base64': Base64 encoding (~33% smaller, required for new implementations)
 * - 'hex': Hexadecimal encoding (deprecated, supported for backward compatibility)
 */
export type EncodingFormat = "base64" | "hex";

/**
 * Encodes binary data to a string using the specified format.
 *
 * @param bytes - The binary data to encode
 * @param format - The encoding format ('base64' or 'hex')
 * @returns The encoded string
 */
export function encodeContent(
  bytes: Uint8Array,
  format: EncodingFormat,
): string {
  if (format === "base64") {
    // Convert Uint8Array to base64
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } else {
    // hex format
    return bytesToHex(bytes);
  }
}

/**
 * Decodes a string to binary data using the specified or auto-detected format.
 *
 * @param content - The encoded string
 * @param format - Optional encoding format. If not specified, will auto-detect.
 * @returns The decoded binary data
 * @throws Error if the content cannot be decoded
 */
export function decodeContent(
  content: string,
  format?: EncodingFormat,
): Uint8Array {
  const actualFormat = format ?? detectEncoding(content);

  if (actualFormat === "base64") {
    try {
      const binaryString = atob(content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    } catch (error) {
      throw new Error(
        `Failed to decode base64 content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      return hexToBytes(content);
    } catch (error) {
      throw new Error(
        `Failed to decode hex content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Detects the encoding format of a content string.
 *
 * @param content - The encoded string to analyze
 * @returns The detected encoding format
 */
export function detectEncoding(content: string): EncodingFormat {
  // Remove whitespace for analysis
  const cleaned = content.trim();

  // Check if it's valid hex (only contains 0-9, a-f, A-F)
  const isHex = /^[0-9a-fA-F]+$/.test(cleaned);

  // If it's valid hex and has even length, it's likely hex
  // (hex encoding always produces even-length strings)
  if (isHex && cleaned.length % 2 === 0) {
    return "hex";
  }

  // If it contains characters outside hex range (like +, /) or has base64 padding,
  // it's definitely base64
  if (/[+/=]/.test(cleaned) || !isHex) {
    return "base64";
  }

  // If it's valid hex but odd length, it's malformed hex, try base64
  if (isHex && cleaned.length % 2 !== 0) {
    return "base64";
  }

  // Default to base64 for ambiguous cases
  return "base64";
}

/**
 * Extracts the encoding tag from a Nostr event.
 *
 * @param event - The Nostr event to check
 * @returns The encoding format specified in the event, or undefined if not present
 */
export function getEncodingTag(
  event: NostrEvent | Rumor,
): EncodingFormat | undefined {
  const encodingTag = event.tags.find((tag) => tag[0] === "encoding");
  if (!encodingTag || encodingTag.length < 2) {
    return undefined;
  }

  const value = encodingTag[1];
  if (value === "base64" || value === "hex") {
    return value;
  }

  return undefined;
}
