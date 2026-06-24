import {
  createApplicationMessage,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { contentDedupId } from "../message-dedup.js";

describe("contentDedupId", () => {
  it("is stable for the same MLS message and distinct for different ones", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential("a".repeat(64)),
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: ["a".repeat(64)],
      relays: [],
    });

    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const first = await createApplicationMessage({
      context: ctx,
      state: clientState,
      message: new TextEncoder().encode("hello"),
    });
    const second = await createApplicationMessage({
      context: ctx,
      state: first.newState,
      message: new TextEncoder().encode("hello"),
    });

    const id = contentDedupId(first.message);
    expect(id).toMatch(/^[0-9a-f]{64}$/); // lowercase-hex SHA-256, no prefix
    expect(contentDedupId(first.message)).toBe(id); // deterministic
    // Same plaintext, different ratchet generation ⇒ distinct content id.
    expect(contentDedupId(second.message)).not.toBe(id);
  });
});
