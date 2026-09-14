import manifestJson from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/manifest.v1.json";
import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";

import { decodeNostrRoutingV1 } from "../../core/components/nostr-routing.js";
import {
  resolveManifestArtifact,
  validateConformanceManifest,
} from "./manifest.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { testAccount } from "../helpers/test-accounts.js";
import { MarmotConformanceSubject, parseMdkScenarioStep } from "./subject.js";

const VECTORS_ROOT = "refs/mdk/crates/cgka-conformance-simulator/vectors";

describe("portable MDK conformance smoke corpus", () => {
  const manifest = validateConformanceManifest(manifestJson, VECTORS_ROOT);
  const portable = manifest.entries.filter(
    (entry) => entry.status === "portable",
  );
  const represented = new Set<string>();

  for (const entry of portable) {
    it(entry.id, async () => {
      expect(entry.artifact).toBeDefined();
      const fixture = JSON.parse(
        readFileSync(
          resolveManifestArtifact(VECTORS_ROOT, entry.artifact!),
          "utf8",
        ),
      ) as Record<string, any>;

      // Byte fixtures execute through the production codec. The Scenario IR
      // corpus remains explicit until the adapter implements its mutation and
      // scheduler actions; a portable vector must never silently disappear.
      if (String(fixture.vector_type).startsWith("app_component_")) {
        if (fixture.expected.valid) {
          const decoded = decodeNostrRoutingV1(hexToBytes(fixture.bytes.hex));
          expect(decoded.relays).toEqual(fixture.expected.fields.relays);
        } else {
          expect(() =>
            decodeNostrRoutingV1(hexToBytes(fixture.bytes.hex)),
          ).toThrow();
        }
        // MDK manifest 93ecfbca calls the valid update
        // `update-valid-two-relays/v1`, while its immutable fixture_name is
        // `update-valid-full-replacement/v1`; artifact identity is therefore
        // anchored by the manifest id rather than silently renamed here.
        expect(fixture.fixture_name).toMatch(
          /^marmot\.transport\.nostr\.routing\.v1\//,
        );
      } else {
        expect(fixture.scenario?.name).toBe(entry.id);
        expect(fixture.scenario?.steps?.length).toBeGreaterThan(0);
        const subject = new MarmotConformanceSubject({
          scenarioId: entry.id,
          groups: new Map(),
          network: new MockNetwork(),
          capabilities: new Set([
            "group_mutation",
            "application_messaging",
            "transport_delivery",
            "virtual_time",
            "observation",
            "crash_reopen",
            "semantic_transport_faults",
          ]),
          now: () => 0,
          advanceTime: () => {},
          restart: async () => {
            throw new Error("unsupported restart must not execute");
          },
        });
        for (const rawStep of fixture.scenario.steps) {
          const action = parseMdkScenarioStep(rawStep);
          if (action.type !== "scenario_operation") {
            expect(subject.support(action)).toBeUndefined();
            continue;
          }
          const result = await subject.execute(action);
          expect(result).toMatchObject({
            kind: "unsupported",
            scenarioId: entry.id,
          });
        }
      }
      represented.add(entry.id);
    });
  }

  it("represents every portable manifest entry", () => {
    expect(represented.size).toBe(portable.length);
    expect([...represented].sort()).toEqual(
      portable.map((entry) => entry.id).sort(),
    );
  });

  it("advertises and executes the supported behavioral Scenario IR surface", async () => {
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const account = testAccount(6);
    const pubkey = account.pubkey;
    const keyPackage = await generateKeyPackage({
      credential: createCredential(pubkey),
      signer: account.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState } = await createSimpleGroup(
      keyPackage,
      ciphersuite,
      "behavioral-smoke",
      { adminPubkeys: [pubkey], relays: ["wss://mock-relay.test"] },
    );
    const network = new MockNetwork();
    network.autoDeliver = false;
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
      signer: { getPublicKey: async () => pubkey } as never,
      ciphersuite,
      network,
    });
    const subject = new MarmotConformanceSubject({
      scenarioId: "behavioral-smoke/v1",
      groups: new Map([["alice", group]]),
      identities: new Map([["alice", pubkey]]),
      network,
      capabilities: new Set([
        "group_mutation",
        "application_messaging",
        "transport_delivery",
        "observation",
      ]),
      now: () => 1_000,
      advanceTime: () => {},
      restart: async () => group,
    });
    const steps = [
      {
        type: "create_group",
        creator: "alice",
        name: "behavioral-smoke",
        invitees: [],
      },
      { type: "send_app_message", sender: "alice", payload: "hello" },
      { type: "deliver_all" },
      { type: "tick", clients: ["alice"] },
      { type: "observe_exact", clients: ["alice"] },
    ];
    for (const step of steps)
      expect(await subject.execute(parseMdkScenarioStep(step))).toMatchObject({
        kind: "supported",
      });
  });
});
