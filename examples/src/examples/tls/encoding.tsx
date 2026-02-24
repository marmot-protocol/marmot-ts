import { useState, useMemo } from "react";
import ErrorBoundary from "../../components/error-boundary";

// ============================================================================
// TLS Presentation Language Types (RFC 8446 Section 3)
// ============================================================================

interface ParseResult {
  success: boolean;
  data?: ParsedStructure[];
  error?: string;
}

interface ParsedStructure {
  type: string;
  name: string;
  value: any;
  bytes: Uint8Array;
  offset: number;
  length: number;
  description?: string;
  children?: ParsedStructure[];
}

interface StructField {
  type: string;
  name: string;
  isVector: boolean;
  vectorMin?: number;
  vectorMax?: number;
  fixedLength?: number;
}

interface StructDefinition {
  name: string;
  fields: StructField[];
}

// ============================================================================
// Binary String Parser
// ============================================================================

/**
 * Convert various binary string formats to Uint8Array
 * Supports: hex (with/without spaces/0x), binary (01010101), base64
 */
function parseBinaryString(input: string): Uint8Array | null {
  const cleaned = input.trim();

  // Try hex format (most common for TLS)
  // Matches: "0x48656c6c6f", "48 65 6c 6c 6f", "48656c6c6f"
  const hexMatch = cleaned.match(/^(?:0x)?([0-9a-fA-F\s]+)$/);
  if (hexMatch) {
    const hexStr = hexMatch[1].replace(/\s/g, "");
    if (hexStr.length % 2 === 0) {
      const bytes = new Uint8Array(hexStr.length / 2);
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes[i / 2] = parseInt(hexStr.substr(i, 2), 16);
      }
      return bytes;
    }
  }

  // Try binary format
  // Matches: "01001000 01100101 01101100 01101100 01101111"
  const binaryMatch = cleaned.match(/^([01\s]+)$/);
  if (binaryMatch) {
    const binaryStr = binaryMatch[1].replace(/\s/g, "");
    if (binaryStr.length % 8 === 0) {
      const bytes = new Uint8Array(binaryStr.length / 8);
      for (let i = 0; i < binaryStr.length; i += 8) {
        bytes[i / 8] = parseInt(binaryStr.substr(i, 8), 2);
      }
      return bytes;
    }
  }

  // Try base64
  try {
    const base64Cleaned = cleaned.replace(/\s/g, "");
    const binaryString = atob(base64Cleaned);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    // Not valid base64
  }

  return null;
}

// ============================================================================
// Structure Definition Parser
// ============================================================================

/**
 * Parse a TLS structure definition (RFC 8446 style)
 * Example:
 *   struct {
 *     uint16 version;
 *     opaque data[32];
 *     opaque name<0..255>;
 *   } MyStruct;
 */
function parseStructDefinition(input: string): StructDefinition | null {
  try {
    // Extract struct name
    const structMatch = input.match(/struct\s*\{[\s\S]*?\}\s*(\w+)\s*;/);
    const structName = structMatch?.[1] || "UnnamedStruct";

    // Extract fields
    const fields: StructField[] = [];

    // Match field patterns:
    // - uint8/uint16/uint24/uint32 fieldName;
    // - opaque fieldName[N];
    // - opaque fieldName<min..max>;
    const fieldRegex =
      /(\w+)\s+(\w+)(?:\[(\d+)\]|<(\d+)\.\.(?:(\d+)|2\^(\d+)-1)>)?\s*;/g;

    let match;
    while ((match = fieldRegex.exec(input)) !== null) {
      const [, type, name, fixedLen, vectorMin, vectorMax, vectorMaxExp] =
        match;

      if (fixedLen) {
        // Fixed-length array: opaque data[32]
        fields.push({
          type,
          name,
          isVector: false,
          fixedLength: parseInt(fixedLen),
        });
      } else if (vectorMin !== undefined) {
        // Variable-length vector: opaque data<0..255>
        let max = vectorMax ? parseInt(vectorMax) : 0;
        if (vectorMaxExp) {
          // Handle 2^16-1 notation
          max = Math.pow(2, parseInt(vectorMaxExp)) - 1;
        }
        fields.push({
          type,
          name,
          isVector: true,
          vectorMin: parseInt(vectorMin),
          vectorMax: max,
        });
      } else {
        // Simple type: uint16 version
        fields.push({
          type,
          name,
          isVector: false,
        });
      }
    }

    return {
      name: structName,
      fields,
    };
  } catch (e) {
    console.error("Failed to parse struct definition:", e);
    return null;
  }
}

// ============================================================================
// TLS Structure Parser
// ============================================================================

class TLSParser {
  private data: Uint8Array;
  private offset: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  hasMore(): boolean {
    return this.offset < this.data.length;
  }

  remaining(): number {
    return this.data.length - this.offset;
  }

  peek(length: number = 1): Uint8Array {
    return this.data.slice(this.offset, this.offset + length);
  }

  read(length: number): Uint8Array {
    const bytes = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readUint8(): number {
    return this.read(1)[0];
  }

  readUint16(): number {
    const bytes = this.read(2);
    return (bytes[0] << 8) | bytes[1];
  }

  readUint24(): number {
    const bytes = this.read(3);
    return (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  }

  readUint32(): number {
    const bytes = this.read(4);
    return (
      ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
    );
  }

  readVector8(): Uint8Array {
    const length = this.readUint8();
    return this.read(length);
  }

  readVector16(): Uint8Array {
    const length = this.readUint16();
    return this.read(length);
  }

  readVector24(): Uint8Array {
    const length = this.readUint24();
    return this.read(length);
  }

  getOffset(): number {
    return this.offset;
  }

  setOffset(offset: number): void {
    this.offset = offset;
  }
}

// ============================================================================
// Parse Data According to Structure Definition
// ============================================================================

function parseWithStructDefinition(
  data: Uint8Array,
  structDef: StructDefinition,
): ParsedStructure[] {
  const parser = new TLSParser(data);
  const structures: ParsedStructure[] = [];

  for (const field of structDef.fields) {
    const startOffset = parser.getOffset();

    try {
      if (field.fixedLength !== undefined) {
        // Fixed-length array
        const value = parser.read(field.fixedLength);
        structures.push({
          type: `${field.type}[${field.fixedLength}]`,
          name: field.name,
          value: value,
          bytes: data.slice(startOffset, parser.getOffset()),
          offset: startOffset,
          length: field.fixedLength,
          description: `Fixed-length array of ${field.fixedLength} bytes`,
        });
      } else if (field.isVector) {
        // Variable-length vector
        const lengthBytes =
          field.vectorMax! <= 255 ? 1 : field.vectorMax! <= 65535 ? 2 : 3;
        const lengthOffset = parser.getOffset();

        let length: number;
        if (lengthBytes === 1) {
          length = parser.readUint8();
        } else if (lengthBytes === 2) {
          length = parser.readUint16();
        } else {
          length = parser.readUint24();
        }

        const dataOffset = parser.getOffset();
        const value = parser.read(length);

        structures.push({
          type: `${field.type}<${field.vectorMin}..${field.vectorMax}>`,
          name: field.name,
          value: value,
          bytes: data.slice(startOffset, parser.getOffset()),
          offset: startOffset,
          length: lengthBytes + length,
          description: `Vector with ${lengthBytes}-byte length prefix (length: ${length})`,
          children: [
            {
              type: `uint${lengthBytes * 8}`,
              name: "length",
              value: length,
              bytes: data.slice(lengthOffset, dataOffset),
              offset: lengthOffset,
              length: lengthBytes,
            },
            {
              type: field.type,
              name: "data",
              value: value,
              bytes: value,
              offset: dataOffset,
              length: length,
            },
          ],
        });
      } else {
        // Simple type
        let value: number;
        let length: number;

        switch (field.type) {
          case "uint8":
            value = parser.readUint8();
            length = 1;
            break;
          case "uint16":
            value = parser.readUint16();
            length = 2;
            break;
          case "uint24":
            value = parser.readUint24();
            length = 3;
            break;
          case "uint32":
            value = parser.readUint32();
            length = 4;
            break;
          default:
            throw new Error(`Unknown type: ${field.type}`);
        }

        structures.push({
          type: field.type,
          name: field.name,
          value: value,
          bytes: data.slice(startOffset, parser.getOffset()),
          offset: startOffset,
          length: length,
          description: `Value: ${value} (0x${value.toString(16).padStart(length * 2, "0")})`,
        });
      }
    } catch (e: any) {
      structures.push({
        type: "error",
        name: field.name,
        value: null,
        bytes: new Uint8Array(),
        offset: startOffset,
        length: 0,
        description: `Error parsing field: ${e.message}`,
      });
      break;
    }
  }

  return structures;
}

// ============================================================================
// Auto-detect and Parse TLS Structures
// ============================================================================

function autoDetectStructure(data: Uint8Array): ParsedStructure[] {
  const parser = new TLSParser(data);
  const structures: ParsedStructure[] = [];

  // Try to detect common TLS patterns
  while (parser.hasMore()) {
    const startOffset = parser.getOffset();

    // Try parsing as a generic TLS structure
    try {
      // Check if it looks like a vector (length-prefixed data)
      if (parser.remaining() >= 1) {
        const firstByte = parser.peek(1)[0];

        // Try uint8 vector
        if (firstByte <= parser.remaining() - 1) {
          const lengthOffset = parser.getOffset();
          const length = parser.readUint8();
          const dataOffset = parser.getOffset();

          if (length <= parser.remaining()) {
            const value = parser.read(length);
            structures.push({
              type: "vector<uint8>",
              name: `Vector (1-byte length)`,
              value: value,
              bytes: data.slice(lengthOffset, parser.getOffset()),
              offset: lengthOffset,
              length: 1 + length,
              description: `Length: ${length} bytes`,
              children: [
                {
                  type: "uint8",
                  name: "Length",
                  value: length,
                  bytes: data.slice(lengthOffset, lengthOffset + 1),
                  offset: lengthOffset,
                  length: 1,
                },
                {
                  type: "opaque",
                  name: "Data",
                  value: value,
                  bytes: value,
                  offset: dataOffset,
                  length: length,
                },
              ],
            });
            continue;
          } else {
            // Rewind if this didn't work
            parser.setOffset(startOffset);
          }
        }

        // Try uint16 vector
        if (parser.remaining() >= 2) {
          const lengthOffset = parser.getOffset();
          const length = parser.readUint16();
          const dataOffset = parser.getOffset();

          if (length <= parser.remaining()) {
            const value = parser.read(length);
            structures.push({
              type: "vector<uint16>",
              name: `Vector (2-byte length)`,
              value: value,
              bytes: data.slice(lengthOffset, parser.getOffset()),
              offset: lengthOffset,
              length: 2 + length,
              description: `Length: ${length} bytes`,
              children: [
                {
                  type: "uint16",
                  name: "Length",
                  value: length,
                  bytes: data.slice(lengthOffset, lengthOffset + 2),
                  offset: lengthOffset,
                  length: 2,
                },
                {
                  type: "opaque",
                  name: "Data",
                  value: value,
                  bytes: value,
                  offset: dataOffset,
                  length: length,
                },
              ],
            });
            continue;
          } else {
            // Rewind if this didn't work
            parser.setOffset(startOffset);
          }
        }

        // Fallback: read as single byte
        const byte = parser.readUint8();
        structures.push({
          type: "uint8",
          name: "Byte",
          value: byte,
          bytes: data.slice(startOffset, parser.getOffset()),
          offset: startOffset,
          length: 1,
          description: `Value: ${byte} (0x${byte.toString(16).padStart(2, "0")})`,
        });
      }
    } catch (e) {
      // If parsing fails, just read remaining as opaque
      const remaining = parser.remaining();
      const value = parser.read(remaining);
      structures.push({
        type: "opaque",
        name: "Remaining Data",
        value: value,
        bytes: value,
        offset: startOffset,
        length: remaining,
        description: `${remaining} bytes`,
      });
    }
  }

  return structures;
}

// ============================================================================
// Visualization Components
// ============================================================================

function ByteView({
  bytes,
  highlight,
}: {
  bytes: Uint8Array;
  highlight?: number[];
}) {
  return (
    <div className="font-mono text-xs space-y-2">
      {Array.from({ length: Math.ceil(bytes.length / 16) }).map((_, rowIdx) => {
        const start = rowIdx * 16;
        const end = Math.min(start + 16, bytes.length);
        const rowBytes = bytes.slice(start, end);

        return (
          <div key={rowIdx} className="flex gap-4">
            {/* Offset */}
            <div className="text-base-content/40 w-16">
              {start.toString(16).padStart(4, "0")}:
            </div>

            {/* Hex bytes */}
            <div className="flex gap-1 flex-1">
              {Array.from(rowBytes).map((byte, idx) => {
                const globalIdx = start + idx;
                const isHighlighted = highlight?.includes(globalIdx);
                return (
                  <span
                    key={idx}
                    className={`${
                      isHighlighted
                        ? "bg-primary text-primary-content font-bold"
                        : "text-base-content"
                    } px-0.5`}
                  >
                    {byte.toString(16).padStart(2, "0")}
                  </span>
                );
              })}
              {/* Padding for incomplete rows */}
              {Array.from({ length: 16 - rowBytes.length }).map((_, idx) => (
                <span key={`pad-${idx}`} className="text-transparent">
                  00
                </span>
              ))}
            </div>

            {/* ASCII representation */}
            <div className="text-base-content/60">
              {Array.from(rowBytes)
                .map((byte) =>
                  byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
                )
                .join("")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StructureTree({ structures }: { structures: ParsedStructure[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (key: string) => {
    const newExpanded = new Set(expanded);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpanded(newExpanded);
  };

  const renderStructure = (
    struct: ParsedStructure,
    depth: number = 0,
    key: string = "0",
  ) => {
    const hasChildren = struct.children && struct.children.length > 0;
    const isExpanded = expanded.has(key);

    return (
      <div key={key} className="border-l-2 border-base-300 pl-4 py-1">
        <div className="flex items-start gap-2">
          {/* Expand/collapse button */}
          {hasChildren && (
            <button
              onClick={() => toggleExpand(key)}
              className="btn btn-xs btn-ghost btn-square"
            >
              {isExpanded ? "▼" : "▶"}
            </button>
          )}

          {/* Structure info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="badge badge-sm badge-primary">
                {struct.type}
              </span>
              <span className="font-semibold">{struct.name}</span>
              <span className="text-xs text-base-content/60">
                @{struct.offset} ({struct.length} bytes)
              </span>
            </div>

            {/* Description */}
            {struct.description && (
              <div className="text-sm text-base-content/70 mt-1">
                {struct.description}
              </div>
            )}

            {/* Value preview */}
            <div className="text-xs font-mono mt-1 text-base-content/60">
              {typeof struct.value === "number"
                ? `${struct.value} (0x${struct.value.toString(16)})`
                : struct.value instanceof Uint8Array
                  ? Array.from(struct.value.slice(0, 32))
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join(" ") + (struct.value.length > 32 ? "..." : "")
                  : String(struct.value)}
            </div>

            {/* Hex dump */}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-base-content/60 hover:text-base-content">
                Show bytes
              </summary>
              <div className="mt-2 p-2 bg-base-200 rounded">
                <ByteView bytes={struct.bytes} />
              </div>
            </details>
          </div>
        </div>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div className="ml-4 mt-2">
            {struct.children!.map((child, idx) =>
              renderStructure(child, depth + 1, `${key}-${idx}`),
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {structures.map((struct, idx) => renderStructure(struct, 0, String(idx)))}
    </div>
  );
}

// ============================================================================
// Manual Parser Components
// ============================================================================

function ManualParser({ data }: { data: Uint8Array }) {
  const [parserType, setParserType] = useState<string>("uint8");
  const [offset, setOffset] = useState<number>(0);
  const [results, setResults] = useState<ParsedStructure[]>([]);

  const parser = useMemo(() => new TLSParser(data), [data]);

  const parseNext = () => {
    try {
      parser.setOffset(offset);
      const startOffset = offset;

      let result: ParsedStructure;

      switch (parserType) {
        case "uint8": {
          const value = parser.readUint8();
          result = {
            type: "uint8",
            name: "uint8",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 1,
            description: `Value: ${value} (0x${value.toString(16).padStart(2, "0")})`,
          };
          break;
        }

        case "uint16": {
          const value = parser.readUint16();
          result = {
            type: "uint16",
            name: "uint16",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 2,
            description: `Value: ${value} (0x${value.toString(16).padStart(4, "0")})`,
          };
          break;
        }

        case "uint24": {
          const value = parser.readUint24();
          result = {
            type: "uint24",
            name: "uint24",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 3,
            description: `Value: ${value} (0x${value.toString(16).padStart(6, "0")})`,
          };
          break;
        }

        case "uint32": {
          const value = parser.readUint32();
          result = {
            type: "uint32",
            name: "uint32",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 4,
            description: `Value: ${value} (0x${value.toString(16).padStart(8, "0")})`,
          };
          break;
        }

        case "vector8": {
          const lengthOffset = parser.getOffset();
          const length = parser.readUint8();
          const dataOffset = parser.getOffset();
          const value = parser.read(length);
          result = {
            type: "vector<uint8>",
            name: "vector (1-byte length)",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 1 + length,
            description: `Length: ${length} bytes`,
            children: [
              {
                type: "uint8",
                name: "Length",
                value: length,
                bytes: data.slice(lengthOffset, dataOffset),
                offset: lengthOffset,
                length: 1,
              },
              {
                type: "opaque",
                name: "Data",
                value,
                bytes: value,
                offset: dataOffset,
                length: length,
              },
            ],
          };
          break;
        }

        case "vector16": {
          const lengthOffset = parser.getOffset();
          const length = parser.readUint16();
          const dataOffset = parser.getOffset();
          const value = parser.read(length);
          result = {
            type: "vector<uint16>",
            name: "vector (2-byte length)",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 2 + length,
            description: `Length: ${length} bytes`,
            children: [
              {
                type: "uint16",
                name: "Length",
                value: length,
                bytes: data.slice(lengthOffset, dataOffset),
                offset: lengthOffset,
                length: 2,
              },
              {
                type: "opaque",
                name: "Data",
                value,
                bytes: value,
                offset: dataOffset,
                length: length,
              },
            ],
          };
          break;
        }

        case "vector24": {
          const lengthOffset = parser.getOffset();
          const length = parser.readUint24();
          const dataOffset = parser.getOffset();
          const value = parser.read(length);
          result = {
            type: "vector<uint24>",
            name: "vector (3-byte length)",
            value,
            bytes: data.slice(startOffset, parser.getOffset()),
            offset: startOffset,
            length: 3 + length,
            description: `Length: ${length} bytes`,
            children: [
              {
                type: "uint24",
                name: "Length",
                value: length,
                bytes: data.slice(lengthOffset, dataOffset),
                offset: lengthOffset,
                length: 3,
              },
              {
                type: "opaque",
                name: "Data",
                value,
                bytes: value,
                offset: dataOffset,
                length: length,
              },
            ],
          };
          break;
        }

        default:
          throw new Error(`Unknown parser type: ${parserType}`);
      }

      setResults([...results, result]);
      setOffset(parser.getOffset());
    } catch (e: any) {
      alert(`Parse error: ${e.message}`);
    }
  };

  const reset = () => {
    setOffset(0);
    setResults([]);
    parser.setOffset(0);
  };

  return (
    <div className="space-y-4">
      <div className="alert alert-info">
        <div className="text-sm">
          <div className="font-bold mb-1">Manual Parser Mode</div>
          <p>
            Step through the binary data manually by selecting a type and
            clicking "Parse Next". This helps you understand how TLS structures
            are built from basic types.
          </p>
        </div>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <select
          className="select select-bordered select-sm"
          value={parserType}
          onChange={(e) => setParserType(e.target.value)}
        >
          <option value="uint8">uint8 (1 byte)</option>
          <option value="uint16">uint16 (2 bytes)</option>
          <option value="uint24">uint24 (3 bytes)</option>
          <option value="uint32">uint32 (4 bytes)</option>
          <option value="vector8">vector&lt;uint8&gt;</option>
          <option value="vector16">vector&lt;uint16&gt;</option>
          <option value="vector24">vector&lt;uint24&gt;</option>
        </select>

        <button
          className="btn btn-sm btn-primary"
          onClick={parseNext}
          disabled={offset >= data.length}
        >
          Parse Next
        </button>

        <button className="btn btn-sm btn-ghost" onClick={reset}>
          Reset
        </button>

        <div className="text-sm text-base-content/60">
          Offset: {offset} / {data.length} ({data.length - offset} bytes
          remaining)
        </div>
      </div>

      {results.length > 0 && (
        <div className="border border-base-300 rounded-lg p-4">
          <h3 className="font-semibold mb-2">Parsed Structures</h3>
          <StructureTree structures={results} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// RFC Reference Component
// ============================================================================

function RFCReference() {
  return (
    <div className="collapse collapse-arrow bg-base-200">
      <input type="checkbox" />
      <div className="collapse-title font-medium">
        📖 RFC 8446 Section 3 - Presentation Language Reference
      </div>
      <div className="collapse-content text-sm space-y-4">
        <div>
          <h4 className="font-semibold mb-2">Basic Types</h4>
          <ul className="list-disc list-inside space-y-1 text-base-content/80">
            <li>
              <code className="bg-base-300 px-1 rounded">uint8</code> - 1 byte
              unsigned integer
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">uint16</code> - 2 byte
              unsigned integer (big-endian)
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">uint24</code> - 3 byte
              unsigned integer (big-endian)
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">uint32</code> - 4 byte
              unsigned integer (big-endian)
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">opaque</code> - raw
              byte sequence
            </li>
          </ul>
        </div>

        <div>
          <h4 className="font-semibold mb-2">Vectors (Variable-Length)</h4>
          <p className="text-base-content/80 mb-2">
            Vectors are length-prefixed arrays. The length field size determines
            the maximum size:
          </p>
          <ul className="list-disc list-inside space-y-1 text-base-content/80">
            <li>
              <code className="bg-base-300 px-1 rounded">
                opaque data&lt;0..255&gt;
              </code>{" "}
              - 1 byte length prefix (uint8)
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">
                opaque data&lt;0..2^16-1&gt;
              </code>{" "}
              - 2 byte length prefix (uint16)
            </li>
            <li>
              <code className="bg-base-300 px-1 rounded">
                opaque data&lt;0..2^24-1&gt;
              </code>{" "}
              - 3 byte length prefix (uint24)
            </li>
          </ul>
        </div>

        <div>
          <h4 className="font-semibold mb-2">Example Structure</h4>
          <pre className="bg-base-300 p-3 rounded overflow-x-auto">
            {`struct {
    uint16 version;
    opaque random[32];
    opaque legacy_session_id<0..32>;
    CipherSuite cipher_suites<2..2^16-2>;
} ClientHello;`}
          </pre>
        </div>

        <div>
          <h4 className="font-semibold mb-2">Resources</h4>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <a
                href="https://www.rfc-editor.org/rfc/rfc8446.html#section-3"
                target="_blank"
                rel="noopener noreferrer"
                className="link link-primary"
              >
                RFC 8446 Section 3 - Presentation Language
              </a>
            </li>
            <li>
              <a
                href="https://www.rfc-editor.org/rfc/rfc8446.html#section-4"
                target="_blank"
                rel="noopener noreferrer"
                className="link link-primary"
              >
                RFC 8446 Section 4 - Handshake Protocol
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Example Data
// ============================================================================

const EXAMPLES = {
  simple_uint16: {
    name: "Simple uint16",
    description: "A single 16-bit unsigned integer (value: 443)",
    hex: "01bb",
  },
  vector_uint8: {
    name: "Vector with uint8 length",
    description: "A vector containing 5 bytes: 'Hello'",
    hex: "0548656c6c6f",
  },
  vector_uint16: {
    name: "Vector with uint16 length",
    description: "A vector with 2-byte length prefix containing 'TLS 1.3'",
    hex: "0007544c5320312e33",
  },
  nested_vectors: {
    name: "Nested vectors",
    description: "A vector containing two smaller vectors",
    hex: "0e03414243044445464705474849",
  },
  mixed_types: {
    name: "Mixed types",
    description: "uint8 (3), uint16 (443), vector (Hello)",
    hex: "0301bb0548656c6c6f",
  },
};

// ============================================================================
// Structure Definition Examples
// ============================================================================

const STRUCT_EXAMPLES = {
  marmot_group_data: {
    name: "Marmot Group Data",
    description: "Nostr group metadata structure from marmot-ts",
    definition: `struct {
    uint16 version;                    // Version number (current: 2)
    opaque nostr_group_id[32];
    opaque name<0..2^16-1>;
    opaque description<0..2^16-1>;
    opaque admin_pubkeys<0..2^16-1>;
    opaque relays<0..2^16-1>;
    opaque image_hash[32];
    opaque image_key[32];
    opaque image_nonce[12];
} NostrGroupData;`,
    sampleData:
      "0002" + // version: 2
      "0000000000000000000000000000000000000000000000000000000000000001" + // nostr_group_id (32 bytes)
      "000d4d7920546573742047726f7570" + // name: "My Test Group" (13 bytes)
      "00184120746573742067726f757020666f722074657374696e67" + // description: "A test group for testing" (24 bytes)
      "0000" + // admin_pubkeys (empty)
      "0000" + // relays (empty)
      "0000000000000000000000000000000000000000000000000000000000000002" + // image_hash (32 bytes)
      "0000000000000000000000000000000000000000000000000000000000000003" + // image_key (32 bytes)
      "000000000000000000000004", // image_nonce (12 bytes)
  },
  key_package: {
    name: "MLS KeyPackage (simplified)",
    description: "Simplified MLS KeyPackage structure",
    definition: `struct {
    uint16 protocol_version;
    uint16 cipher_suite;
    opaque hpke_init_key<1..2^16-1>;
    opaque credential<1..2^16-1>;
    opaque extensions<0..2^16-1>;
    opaque signature<0..2^16-1>;
} KeyPackage;`,
    sampleData:
      "0001" + // protocol_version: MLS 1.0
      "0001" + // cipher_suite: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
      "00200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" + // hpke_init_key (32 bytes)
      "00080001000548656c6c6f" + // credential: basic credential with "Hello"
      "0000" + // extensions (empty)
      "00402122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60", // signature (64 bytes)
  },
  simple_message: {
    name: "Simple Message",
    description: "A basic message structure with type and payload",
    definition: `struct {
    uint8 message_type;
    uint16 message_id;
    opaque payload<0..2^16-1>;
} SimpleMessage;`,
    sampleData:
      "01" + // message_type: 1
      "002a" + // message_id: 42
      "000b48656c6c6f20576f726c64", // payload: "Hello World" (11 bytes)
  },
};

// ============================================================================
// Main Component
// ============================================================================

export default function TLSEncodingExplorer() {
  const [input, setInput] = useState<string>("");
  const [mode, setMode] = useState<"auto" | "manual" | "struct">("auto");
  const [structDefInput, setStructDefInput] = useState<string>("");

  const structDef = useMemo<StructDefinition | null>(() => {
    if (!structDefInput.trim()) return null;
    return parseStructDefinition(structDefInput);
  }, [structDefInput]);

  const parseResult = useMemo<ParseResult>(() => {
    if (!input.trim()) {
      return { success: false };
    }

    const bytes = parseBinaryString(input);
    if (!bytes) {
      return {
        success: false,
        error: "Invalid binary format. Please use hex, binary, or base64.",
      };
    }

    try {
      let structures: ParsedStructure[];

      if (mode === "struct" && structDef) {
        structures = parseWithStructDefinition(bytes, structDef);
      } else {
        structures = autoDetectStructure(bytes);
      }

      return {
        success: true,
        data: structures,
      };
    } catch (e: any) {
      return {
        success: false,
        error: e.message,
      };
    }
  }, [input, mode, structDef]);

  const bytes = useMemo(() => {
    return input.trim() ? parseBinaryString(input) : null;
  }, [input]);

  const loadExample = (exampleKey: keyof typeof EXAMPLES) => {
    const example = EXAMPLES[exampleKey];
    setInput(example.hex);
  };

  const loadStructExample = (exampleKey: keyof typeof STRUCT_EXAMPLES) => {
    const example = STRUCT_EXAMPLES[exampleKey];
    setStructDefInput(example.definition);
    setMode("struct");

    // Load the sample data for this structure
    if (example.sampleData) {
      setInput(example.sampleData);
    }
  };

  return (
    <div className="container mx-auto p-4 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">TLS Encoding Explorer</h1>
        <p className="text-base-content/70">
          Learn how TLS 1.3 binary structures work according to{" "}
          <a
            href="https://www.rfc-editor.org/rfc/rfc8446.html#section-3"
            target="_blank"
            rel="noopener noreferrer"
            className="link link-primary"
          >
            RFC 8446 Section 3
          </a>
        </p>
      </div>

      {/* RFC Reference */}
      <RFCReference />

      {/* Input Tabs */}
      <div className="card card-border">
        <div className="card-body">
          <h2 className="text-lg font-semibold">Binary Input</h2>
          <p className="text-sm text-base-content/70 mb-4">
            Enter binary data in hex (with/without 0x prefix or spaces), binary
            (01010101), or base64 format
          </p>
          <div>
            <textarea
              className="textarea textarea-bordered font-mono text-sm h-32 w-full"
              placeholder="Example: 0548656c6c6f or 05 48 65 6c 6c 6f"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="flex justify-between items-center text-xs text-base-content/60 mt-2 mb-4">
              <span>{bytes ? `${bytes.length} bytes` : "No valid input"}</span>
              <button className="btn btn-xs" onClick={() => setInput("")}>
                Clear
              </button>
            </div>
          </div>

          {/* Binary Data Examples */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Data Example:</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(EXAMPLES).map(([key, example]) => (
                <button
                  key={key}
                  className="btn btn-sm btn-outline"
                  onClick={() => loadExample(key as keyof typeof EXAMPLES)}
                >
                  {example.name}
                </button>
              ))}
            </div>
          </div>

          <h2 className="text-lg font-semibold mt-4">
            Structure Definition (Optional)
          </h2>
          <p className="text-sm text-base-content/70 mb-4">
            Define a TLS structure to parse the binary data according to its
            schema
          </p>
          <div>
            <textarea
              className="textarea textarea-bordered font-mono text-sm h-48 w-full"
              placeholder={`struct {
    uint16 version;
    opaque data[32];
    opaque name<0..255>;
} MyStruct;`}
              value={structDefInput}
              onChange={(e) => setStructDefInput(e.target.value)}
            />
            <div className="flex justify-between items-center text-xs mt-2 mb-4">
              {structDef ? (
                <span className="text-success">
                  ✓ Valid structure: {structDef.name} ({structDef.fields.length}{" "}
                  fields)
                </span>
              ) : structDefInput.trim() ? (
                <span className="text-error">
                  ✗ Invalid structure definition
                </span>
              ) : (
                <span className="text-base-content/60">
                  No structure defined (will use auto-detect)
                </span>
              )}
              <button
                className="btn btn-xs"
                onClick={() => setStructDefInput("")}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Structure Definition Examples */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Structure Examples:</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(STRUCT_EXAMPLES).map(([key, example]) => (
                <button
                  key={key}
                  className="btn btn-sm btn-outline"
                  onClick={() =>
                    loadStructExample(key as keyof typeof STRUCT_EXAMPLES)
                  }
                >
                  {example.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Results */}
      {bytes && (
        <div role="tablist" className="tabs tabs-lift">
          <input
            type="radio"
            name="mode_tabs"
            className="tab"
            aria-label="Auto-Detect"
            checked={mode === "auto"}
            onChange={() => setMode("auto")}
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ErrorBoundary>
              {/* Raw Hex View */}
              <div className="mb-6">
                <h2 className="text-lg font-semibold mb-4">Raw Bytes</h2>
                <ByteView bytes={bytes} />
              </div>

              {/* Parsed Structure */}
              {parseResult.success && parseResult.data ? (
                <div className="mt-6">
                  <h2 className="text-lg font-semibold mb-2">
                    Parsed Structure
                  </h2>
                  <p className="text-sm text-base-content/70 mb-4">
                    Auto-detected TLS structures
                  </p>
                  <StructureTree structures={parseResult.data} />
                </div>
              ) : parseResult.error ? (
                <div className="alert alert-error mt-6">
                  <div>
                    <div className="font-bold">Parse Error</div>
                    <div className="text-sm">{parseResult.error}</div>
                  </div>
                </div>
              ) : null}
            </ErrorBoundary>
          </div>

          <input
            type="radio"
            name="mode_tabs"
            className="tab"
            aria-label={`Structure-Guided${structDef ? ` (${structDef.name})` : ""}`}
            checked={mode === "struct"}
            onChange={() => structDef && setMode("struct")}
            disabled={!structDef}
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ErrorBoundary>
              {structDef ? (
                <>
                  {/* Raw Hex View */}
                  <div className="mb-6">
                    <h2 className="text-lg font-semibold mb-4">Raw Bytes</h2>
                    <ByteView bytes={bytes} />
                  </div>

                  {/* Parsed Structure */}
                  {parseResult.success && parseResult.data ? (
                    <div className="mt-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h2 className="text-lg font-semibold">
                            Parsed Structure
                          </h2>
                          <p className="text-sm text-base-content/70">
                            Parsed according to {structDef.name} definition
                          </p>
                        </div>
                        <div className="badge badge-primary">
                          {structDef.name}
                        </div>
                      </div>
                      <StructureTree structures={parseResult.data} />
                    </div>
                  ) : parseResult.error ? (
                    <div className="alert alert-error mt-6">
                      <div>
                        <div className="font-bold">Parse Error</div>
                        <div className="text-sm">{parseResult.error}</div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="alert alert-warning">
                  <div className="text-sm">
                    Please define a structure in the "Structure Definition" tab
                    above to use this mode.
                  </div>
                </div>
              )}
            </ErrorBoundary>
          </div>

          <input
            type="radio"
            name="mode_tabs"
            className="tab"
            aria-label="Manual Parser"
            checked={mode === "manual"}
            onChange={() => setMode("manual")}
          />
          <div className="tab-content bg-base-100 border-base-300 p-6">
            <ManualParser data={bytes} />
          </div>
        </div>
      )}

      {/* Empty State */}
      {!bytes && (
        <div className="card bg-base-200">
          <div className="card-body items-center text-center">
            <h3 className="text-xl font-semibold mb-2">
              Enter binary data above to get started
            </h3>
            <p className="text-base-content/70">
              Try clicking one of the example buttons or paste your own TLS
              binary data
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
