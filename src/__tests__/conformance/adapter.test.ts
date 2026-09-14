import manifestJson from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/manifest.v1.json";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defaultCryptoProvider,
  getCiphersuiteImpl,
  groupContextEncoder,
  encode,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { serializeClientState } from "../../core/client-state.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupRegistry } from "../../client/group-registry.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { testAccount } from "../helpers/test-accounts.js";
import {
  resolveManifestArtifact,
  validateConformanceManifest,
} from "./manifest.js";
import {
  projectCanonicalConformanceSnapshot,
  validateCanonicalConformanceSnapshot,
} from "./snapshot.js";
import { MarmotConformanceSubject } from "./subject.js";
import { parseMdkScenarioStep } from "./subject.js";
import { runConformanceScenario } from "./runner.js";

const VECTORS_ROOT = "refs/mdk/crates/cgka-conformance-simulator/vectors";

describe("conformance adapter", () => {
  it("executes declared Scenario IR operation handlers instead of false support", async () => {
    const executeScenarioOperation = vi.fn(async () => {});
    const subject = new MarmotConformanceSubject({
      scenarioId: "operation-handler/v1",
      groups: new Map(),
      network: new MockNetwork(),
      capabilities: new Set(["application_messaging"]),
      now: () => 0,
      advanceTime: () => {},
      restart: async () => {
        throw new Error("not used");
      },
      executeScenarioOperation,
    });
    const step = { type: "probe_bidirectional_decryptability" };
    const result = await subject.execute(parseMdkScenarioStep(step));
    expect(result.kind).toBe("supported");
    expect(executeScenarioOperation).toHaveBeenCalledWith(step, subject);
  });
  it("strictly validates the pinned manifest and confines artifact paths", () => {
    const manifest = validateConformanceManifest(manifestJson, VECTORS_ROOT);
    expect(manifest.entries[0]?.id).toBe("three-client-message-exchange/v1");
    expect(
      resolveManifestArtifact(VECTORS_ROOT, manifest.entries[0]!.artifact!),
    ).toContain(VECTORS_ROOT);
    expect(() =>
      resolveManifestArtifact(VECTORS_ROOT, "../secret.json"),
    ).toThrow("escapes");
    expect(() =>
      resolveManifestArtifact(VECTORS_ROOT, "/tmp/secret.json"),
    ).toThrow("relative");
    expect(() =>
      validateConformanceManifest(
        { ...manifestJson, surprise: true },
        VECTORS_ROOT,
      ),
    ).toThrow();
  });

  it("projects every canonical field from live MLS state", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(6);
    const keyPackage = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(
      keyPackage,
      impl,
      "projection",
      {
        adminPubkeys: [account.pubkey],
        relays: ["wss://relay.test"],
      },
    );
    const snapshot = await projectCanonicalConformanceSnapshot({
      state: clientState,
      ciphersuite: impl,
      lifecycle: "Stable",
      convergenceStatus: "Settled",
      inputDispositions: [{ input: "create", disposition: "accepted" }],
      applicationOutputs: [
        { identity: "app-1", kind: "message", value: "hello", observed: true },
      ],
    });
    expect(
      encode(groupContextEncoder, clientState.groupContext),
    ).not.toHaveLength(0);
    expect(snapshot.group_id).toBe(
      bytesToHex(clientState.groupContext.groupId),
    );
    expect(snapshot.group_context_sha256).toHaveLength(64);
    expect(snapshot.exporter_commitment_sha256).toHaveLength(64);
    expect(snapshot.leaves).toHaveLength(1);
    expect(
      snapshot.app_data_dictionary.map((entry) => entry.component_id),
    ).toEqual(
      [...snapshot.app_data_dictionary.map((entry) => entry.component_id)].sort(
        (a, b) => a - b,
      ),
    );
    expect(validateCanonicalConformanceSnapshot(snapshot)).toBe(snapshot);
    const { epoch: _epoch, ...missing } = snapshot;
    expect(() => validateCanonicalConformanceSnapshot(missing)).toThrow();
    expect(() =>
      validateCanonicalConformanceSnapshot({
        ...snapshot,
        local_queue_id: "nope",
      }),
    ).toThrow();
    expect(() =>
      validateCanonicalConformanceSnapshot({
        ...snapshot,
        group_context_sha256: "not-a-hash",
      }),
    ).toThrow("group_context_sha256");
    expect(() =>
      validateCanonicalConformanceSnapshot({
        ...snapshot,
        leaves: [
          snapshot.leaves[0],
          { ...snapshot.leaves[0], signature_public_key: "00" },
        ],
      }),
    ).toThrow("strictly ordered");
    expect(() =>
      validateCanonicalConformanceSnapshot({
        ...snapshot,
        required_capabilities: {
          ...snapshot.required_capabilities,
          extensionTypes: [2, 1],
        },
      }),
    ).toThrow("sorted unique");
    expect(() =>
      validateCanonicalConformanceSnapshot({
        ...snapshot,
        unresolved_publications: [{ outbound_bytes: "00" }],
      }),
    ).toThrow("unknown or missing fields");
  });

  it("drives production groups with deterministic delivery, time, restart, and explicit support", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(6);
    const pubkey = account.pubkey;
    const keyPackage = await generateKeyPackage({
      credential: createCredential(pubkey),
      signer: account.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(
      keyPackage,
      impl,
      "subject",
      {
        adminPubkeys: [pubkey],
        relays: ["wss://mock-relay.test"],
      },
    );
    const network = new MockNetwork();
    network.autoDeliver = false;
    const store = new InMemoryKeyValueStore();
    const ingestStateStore = new InMemoryKeyValueStore<Uint8Array>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
    const signer = { getPublicKey: async () => pubkey } as never;
    const makeGroup = (state = clientState) =>
      new MarmotGroup(state, {
        store,
        ingestStateStore,
        rewindStore,
        signer,
        ciphersuite: impl,
        network,
      });
    const groups = new Map([["alice", makeGroup()]]);
    await groups.get("alice")!.save(true);
    const durableBeforeCrash = await store.getItem(
      bytesToHex(clientState.groupContext.groupId),
    );
    const registry = new GroupRegistry({
      store,
      ingestStateStore,
      rewindStore,
      signer,
      network,
    });
    let now = 100;
    const subject = new MarmotConformanceSubject({
      scenarioId: "adapter-smoke/v1",
      groups,
      network,
      capabilities: new Set([
        "application_messaging",
        "transport_delivery",
        "virtual_time",
        "crash_reopen",
      ]),
      now: () => now,
      advanceTime: (milliseconds) => {
        now += milliseconds;
      },
      restart: async (_client, group) => {
        const groupId = group.id.slice();
        group.dispose();
        return registry.load(groupId);
      },
    });
    const result = await runConformanceScenario(
      {
        id: "adapter-smoke/v1",
        actions: [
          {
            type: "send_application",
            client: "alice",
            input: "hello",
            payload: "hello",
          },
          { type: "deliver_all" },
          { type: "advance_time", milliseconds: 50 },
          { type: "restart", client: "alice" },
          { type: "snapshot", client: "alice" },
        ],
      },
      subject,
    );
    expect(result.supported).toBe(true);
    expect(network.queuedEvents).toHaveLength(0);
    expect(network.events).toHaveLength(1);
    expect(now).toBe(150);
    expect(serializeClientState(groups.get("alice")!.state)).toEqual(
      durableBeforeCrash,
    );
    expect(result.results.at(-1)).toMatchObject({
      kind: "supported",
      action: "snapshot",
    });

    const unsupported = new MarmotConformanceSubject({
      ...subject.options,
      capabilities: new Set(["transport_delivery"]),
    });
    expect(
      await unsupported.execute({ type: "restart", client: "alice" }),
    ).toEqual({
      kind: "unsupported",
      scenarioId: "adapter-smoke/v1",
      capability: "crash_reopen",
      reason: "subject does not support crash_reopen",
    });
  });
});
