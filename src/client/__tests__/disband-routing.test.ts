import { EventSigner } from "applesauce-core/factories";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { MarmotGroup } from "../group/marmot-group.js";

describe("disbanded inbound routing", () => {
  it("classifies every late envelope before peel", async () => {
    const pubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(pubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "terminal", {
      adminPubkeys: [pubkey],
      relays: ["wss://relay.test"],
    });
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: { getPublicKey: async () => pubkey } as EventSigner,
      ciphersuite: impl,
      network: new MockNetwork(["wss://relay.test"]),
    });
    await group.session.persistSelectedDisband({
      actorPubkey: pubkey,
      commitDigest: new Uint8Array(32).fill(9),
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });

    const late = [{ id: "late-1" }, { id: "late-2" }] as never[];
    const results = [];
    for await (const result of group.ingest(late)) results.push(result);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.kind)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(
      results.map((result) => result.kind === "skipped" && result.reason),
    ).toEqual(["group-disbanded", "group-disbanded"]);
  });
});
