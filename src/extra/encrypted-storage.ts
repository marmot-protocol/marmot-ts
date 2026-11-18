/** @module @category Storage */
import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { MarmotStorage, StorageOp } from "../utils/storage.js";

/** Reserved keys holding the password salt and verification value. */
const RESERVED_PREFIX = "__encryption/";
const SALT_KEY = `${RESERVED_PREFIX}salt`;
const CHECK_KEY = `${RESERVED_PREFIX}check`;
const CHECK_VALUE = utf8ToBytes("marmot encrypted storage");
const NONCE_LENGTH = 12;

/** Options for {@link EncryptedStorage.fromPassword}. */
export type EncryptedStoragePasswordOptions = {
  /** PBKDF2-SHA256 iterations (default 600,000). */
  iterations?: number;
};

/**
 * Wraps a {@link MarmotStorage} so every value is encrypted with
 * AES-256-GCM. Each value gets a random nonce and is bound to its key (as
 * associated data), so values cannot be swapped between keys undetected.
 *
 * Keys themselves are stored in plaintext; they reveal group ids, key package
 * refs and event ids, but no secrets. Prefer platform key storage (OS
 * keychain, non-extractable WebCrypto keys) for the encryption key.
 */
export class EncryptedStorage implements MarmotStorage {
  readonly #inner: MarmotStorage;
  readonly #key: Uint8Array;

  /** @param key - 32-byte AES-256 key. */
  constructor(inner: MarmotStorage, key: Uint8Array) {
    if (key.length !== 32)
      throw new Error("EncryptedStorage requires a 32-byte key");
    this.#inner = inner;
    this.#key = key.slice();
  }

  /**
   * Derives the key from a password. The salt is created on first use and
   * stored in `inner`; a wrong password rejects instead of returning garbage.
   */
  static async fromPassword(
    inner: MarmotStorage,
    password: string,
    options: EncryptedStoragePasswordOptions = {},
  ): Promise<EncryptedStorage> {
    let salt = await inner.get(SALT_KEY);
    const fresh = !salt;
    if (!salt) salt = randomBytes(16);
    const key = await pbkdf2Async(sha256, password, salt, {
      c: options.iterations ?? 600_000,
      dkLen: 32,
    });
    const storage = new EncryptedStorage(inner, key);
    if (fresh) {
      await inner.batch([
        { type: "set", key: SALT_KEY, value: salt },
        {
          type: "set",
          key: CHECK_KEY,
          value: storage.#encrypt(CHECK_KEY, CHECK_VALUE),
        },
      ]);
      return storage;
    }
    const check = await inner.get(CHECK_KEY);
    if (!check) throw new Error("Encrypted storage is missing its check value");
    try {
      storage.#decrypt(CHECK_KEY, check);
    } catch {
      throw new Error("Wrong password for encrypted storage");
    }
    return storage;
  }

  #encrypt(key: string, value: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_LENGTH);
    const sealed = gcm(this.#key, nonce, utf8ToBytes(key)).encrypt(value);
    const out = new Uint8Array(NONCE_LENGTH + sealed.length);
    out.set(nonce);
    out.set(sealed, NONCE_LENGTH);
    return out;
  }

  #decrypt(key: string, stored: Uint8Array): Uint8Array {
    if (stored.length < NONCE_LENGTH)
      throw new Error("Encrypted value is truncated");
    return gcm(
      this.#key,
      stored.subarray(0, NONCE_LENGTH),
      utf8ToBytes(key),
    ).decrypt(stored.subarray(NONCE_LENGTH));
  }

  #assertKey(key: string): void {
    if (key.startsWith(RESERVED_PREFIX))
      throw new Error(`Key prefix ${RESERVED_PREFIX} is reserved`);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const stored = await this.#inner.get(key);
    return stored && this.#decrypt(key, stored);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#assertKey(key);
    await this.#inner.set(key, this.#encrypt(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.#inner.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.#inner.list(prefix)).filter(
      (key) => !key.startsWith(RESERVED_PREFIX),
    );
  }

  async batch(ops: readonly StorageOp[]): Promise<void> {
    await this.#inner.batch(
      ops.map((op) => {
        if (op.type === "delete") return op;
        this.#assertKey(op.key);
        return { ...op, value: this.#encrypt(op.key, op.value) };
      }),
    );
  }
}
