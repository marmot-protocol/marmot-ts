import { describe, expect, it } from "vitest";

import {
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { encodeKeyPackage } from "ts-mls/keyPackage.js";

import { createCredential } from "../core/credential.js";
import { generateKeyPackage } from "../core/key-package.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { MemoryBackend } from "./ingest-commit-race.test.js";

describe("KeyPackageStore (bytes-first)", () => {
  it("stores KeyPackage as TLS bytes and can roundtrip getPublicKey", async () => {
    const pubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const store = new KeyPackageStore(new MemoryBackend() as any);
    const key = await store.add({
      keyPackageTls: encodeKeyPackage(kp.publicPackage),
      privatePackage: kp.privatePackage,
    });

    expect(typeof key).toBe("string");

    const loadedPublic = await store.getPublicKey(kp.publicPackage);
    expect(loadedPublic).not.toBeNull();
    expect(loadedPublic!.cipherSuite).toBe(kp.publicPackage.cipherSuite);
  });
});
