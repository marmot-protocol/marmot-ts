import { expect, it } from "vitest";
import {
  defaultCryptoProvider,
  getCiphersuiteImpl,
  generateKeyPackageWithKey,
  getAppDataDictionary,
  type GroupContextExtension,
} from "ts-mls";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { createCredential } from "../../core/credential.js";
import {
  makeLeafAppComponentsExtension,
  SUPPORTED_APP_COMPONENT_IDS,
  getAppComponents,
} from "../../core/components/index.js";
import {
  KeyPackageManager,
  type StoredKeyPackage,
} from "../key-package-manager.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

it("replaces the signed pre-media capability publication while retaining pending-Welcome secrets and installation identity", async () => {
  const account = testAccount(6);
  const suite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const signatureKeyPair = await suite.signature.keygen();
  const current = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    signatureKeyPair,
    ciphersuiteImpl: suite,
  });
  const leaf = current.publicPackage.leafNode;
  const proof = getAppDataDictionary(
    leaf.extensions as unknown as GroupContextExtension[],
  )!.find((e) => e.componentId === 0x8009)!.data;
  const old = await generateKeyPackageWithKey({
    credential: leaf.credential,
    cipherSuite: suite,
    signatureKeyPair,
    capabilities: leaf.capabilities,
    lifetime: leaf.lifetime,
    extensions: current.publicPackage.extensions,
    leafNodeExtensions: [
      makeLeafAppComponentsExtension(
        proof,
        SUPPORTED_APP_COMPONENT_IDS.filter((id) => id !== 0x800b),
      ),
    ],
  });
  const manager = new KeyPackageManager({
    store: new InMemoryKeyValueStore<StoredKeyPackage>(),
    signer: account.signer,
    network: new MockNetwork(),
    clientId: "ab".repeat(32),
    getSignatureKeyPair: async () => signatureKeyPair,
  });
  const oldRef = await manager.add({ ...old, identifier: "ab".repeat(32) });
  const upgraded = await manager.ensurePublished({
    relays: ["wss://relay.test"],
  });
  expect(
    getAppComponents(
      upgraded.publicPackage.leafNode
        .extensions as unknown as GroupContextExtension[],
    ),
  ).toContain(0x800b);
  expect(await manager.getPrivateKey(oldRef)).toEqual(old.privatePackage);
  expect(upgraded.publicPackage.leafNode.signaturePublicKey).toEqual(
    leaf.signaturePublicKey,
  );
  expect(upgraded.identifier).toBe("ab".repeat(32));
  expect(
    (await manager.ensurePublished({ relays: ["wss://relay.test"] }))
      .keyPackageRef,
  ).toEqual(upgraded.keyPackageRef);
});
