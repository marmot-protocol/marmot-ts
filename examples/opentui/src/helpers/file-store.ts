import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A persistent key-value backend (shaped like marmot-ts `GenericKeyValueStore`)
 * that writes a single JSON file.
 *
 * Marmot group state is a raw `Uint8Array` and key-package material holds nested
 * `Uint8Array`s, neither of which round-trips through plain JSON. We tag both
 * `Uint8Array` (base64) and `bigint` on write and restore them on read. Good
 * enough for a single-process demo; it is not concurrency-safe and rewrites the
 * whole file on every mutation.
 */
export class FileKeyValueStore<T> {
  readonly #path: string;
  readonly #map: Map<string, T>;

  constructor(path: string) {
    this.#path = path;
    this.#map = new Map();
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      if (raw.trim()) {
        const obj = JSON.parse(raw, reviver) as Record<string, T>;
        for (const [key, value] of Object.entries(obj))
          this.#map.set(key, value);
      }
    }
  }

  #flush(): void {
    const obj: Record<string, T> = {};
    for (const [key, value] of this.#map) obj[key] = value;
    writeFileSync(this.#path, JSON.stringify(obj, replacer));
  }

  async getItem(key: string): Promise<T | null> {
    return this.#map.has(key) ? (this.#map.get(key) as T) : null;
  }

  async setItem(key: string, value: T): Promise<T> {
    this.#map.set(key, value);
    this.#flush();
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.#map.delete(key);
    this.#flush();
  }

  async clear(): Promise<void> {
    this.#map.clear();
    this.#flush();
  }

  async keys(): Promise<string[]> {
    return [...this.#map.keys()];
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __u8a__: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const tagged = value as { __u8a__?: unknown; __bigint__?: unknown };
    if (typeof tagged.__u8a__ === "string") {
      return new Uint8Array(Buffer.from(tagged.__u8a__, "base64"));
    }
    if (typeof tagged.__bigint__ === "string") {
      return BigInt(tagged.__bigint__);
    }
  }
  return value;
}
