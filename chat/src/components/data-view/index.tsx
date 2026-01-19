import { bytesToHex } from "@noble/hashes/utils.js";
import { type ReactNode } from "react";

// ============================================================================
// Generic Data Renderer (handles BigInt, Uint8Array, Map, etc.)
// ============================================================================

export interface DataViewOptions {
  /**
   * Array of field paths to ignore (e.g., ["clientConfig", "nested.field"])
   */
  ignorePaths?: string[];
  /**
   * Maximum length for hex strings before truncation
   */
  maxHexLength?: number;
  /**
   * Maximum length for regular strings before truncation
   */
  maxStringLength?: number;
}

function shouldIgnorePath(
  currentPath: string,
  ignorePaths: string[] = [],
): boolean {
  return ignorePaths.some((ignorePath) => {
    // Exact match or starts with the ignore path (for nested fields)
    return (
      currentPath === ignorePath || currentPath.startsWith(`${ignorePath}.`)
    );
  });
}

function renderValue(
  value: any,
  depth = 0,
  key?: string,
  currentPath = "",
  options: DataViewOptions = {},
): ReactNode {
  const {
    ignorePaths = [],
    maxHexLength = 64,
    maxStringLength = 100,
  } = options;

  // Build the current path
  const fullPath = currentPath ? `${currentPath}.${key}` : key || "";

  // Check if this path should be ignored
  if (key && shouldIgnorePath(fullPath, ignorePaths)) {
    return <span className="text-muted-foreground/40 italic">[hidden]</span>;
  }

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  // Handle BigInt
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  // Handle Uint8Array
  if (value instanceof Uint8Array) {
    const hex = bytesToHex(value);
    // Show truncated version for long arrays
    if (hex.length > maxHexLength) {
      const halfMax = Math.floor(maxHexLength / 2);
      return (
        <code className="select-all text-xs">
          {hex.slice(0, halfMax)}...{hex.slice(-halfMax)}
        </code>
      );
    }
    return <code className="select-all text-xs">{hex}</code>;
  }

  // Handle Map
  if (value instanceof Map) {
    if (value.size === 0) return "Map(0) {}";
    return (
      <div className="ml-4">
        <span className="text-muted-foreground/60">Map({value.size})</span>
        {Array.from(value.entries()).map(([k, v], index) => (
          <div key={index}>
            <span className="text-muted-foreground/60">[{String(k)}]:</span>{" "}
            {renderValue(v, depth + 1, String(k), fullPath, options)}
          </div>
        ))}
      </div>
    );
  }

  // Handle Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      <div className="ml-4">
        {value.map((item, index) => (
          <div key={index}>
            <span className="text-muted-foreground/60">[{index}]:</span>{" "}
            {renderValue(item, depth + 1, String(index), fullPath, options)}
          </div>
        ))}
      </div>
    );
  }

  // Handle Objects
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return (
      <div className={depth > 0 ? "ml-4 space-y-1" : "space-y-1"}>
        {entries.map(([k, val]) => (
          <div key={k}>
            <span className="text-primary font-semibold">{k}:</span>{" "}
            {renderValue(val, depth + 1, k, fullPath, options)}
          </div>
        ))}
      </div>
    );
  }

  // Handle primitives
  if (typeof value === "string") {
    // Truncate very long strings
    if (value.length > maxStringLength) {
      const halfMax = Math.floor(maxStringLength / 2);
      return `"${value.slice(0, halfMax)}...${value.slice(-halfMax)}"`;
    }
    return `"${value}"`;
  }

  if (typeof value === "number") {
    // Return number as 0x hex string for larger numbers
    if (value > 255) {
      return `0x${value.toString(16).padStart(4, "0")}`;
    }
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

/**
 * A generic component that displays any data structure with proper formatting
 * for BigInt, Uint8Array, Map, and other complex types.
 */
export default function DataView(props: {
  data: any;
  options?: DataViewOptions;
}) {
  return (
    <div className="font-mono text-xs rounded break-all">
      {renderValue(props.data, 0, undefined, "", props.options)}
    </div>
  );
}
