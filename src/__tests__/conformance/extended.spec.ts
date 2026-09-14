import fixture from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/deferred-tick-catchup.v1.json";
import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
  type ClientState,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { MarmotConformanceSubject, parseMdkScenarioStep } from "./subject.js";

const CLIENTS = ["alice", "bob", "carol", "dave"] as const;

describe("deterministic offline catchup pressure", () => {
  it("executes the complete pinned scenario with distinct production actors", async () => {
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const accounts = new Map(
      CLIENTS.map((client, index) => [
        client,
        PrivateKeyAccount.fromKey((index + 1).toString(16).padStart(64, "0")),
      ]),
    );
    const identities = new Map(
      await Promise.all(
        CLIENTS.map(
          async (client) =>
            [
              client,
              await accounts.get(client)!.signer.getPublicKey(),
            ] as const,
        ),
      ),
    );
    const packages = new Map(
      await Promise.all(
        CLIENTS.map(
          async (client) =>
            [
              client,
              await generateKeyPackage({
                credential: createCredential(identities.get(client)!),
                signer: accounts.get(client)!.signer,
                ciphersuiteImpl: ciphersuite,
              }),
            ] as const,
        ),
      ),
    );
    const { clientState: created } = await createSimpleGroup(
      packages.get("alice")!,
      ciphersuite,
      "reconnect",
      {
        adminPubkeys: [identities.get("alice")!],
        relays: ["wss://mock-relay.test"],
      },
    );
    const add = await createCommit({
      context: {
        cipherSuite: ciphersuite,
        authService: unsafeTestingAuthenticationService,
      },
      state: created,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: CLIENTS.slice(1).map((client) => ({
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: packages.get(client)!.publicPackage },
      })),
    });
    const states = new Map<string, ClientState>([["alice", add.newState]]);
    for (const client of CLIENTS.slice(1)) {
      const keyPackage = packages.get(client)!;
      states.set(
        client,
        await joinGroup({
          context: {
            cipherSuite: ciphersuite,
            authService: unsafeTestingAuthenticationService,
          },
          welcome: add.welcome!.welcome!,
          keyPackage: keyPackage.publicPackage,
          privateKeys: keyPackage.privatePackage,
          ratchetTree: undefined,
        }),
      );
    }

    const network = new MockNetwork();
    network.autoDeliver = false;
    const groups = new Map<string, MarmotGroup>();
    for (const client of CLIENTS) {
      const group = new MarmotGroup(states.get(client)!, {
        store: new InMemoryKeyValueStore(),
        ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
        rewindStore: new InMemoryKeyValueStore<Uint8Array>(),
        signer: accounts.get(client)!.signer,
        ciphersuite,
        network,
      });
      await group.save(true);
      groups.set(client, group);
    }
    expect(new Set(groups.values()).size).toBe(CLIENTS.length);

    let now = 1_000;
    const subject = new MarmotConformanceSubject({
      scenarioId: fixture.scenario.name,
      groups,
      identities,
      network,
      capabilities: new Set([
        "group_mutation",
        "application_messaging",
        "transport_delivery",
        "virtual_time",
        "observation",
      ]),
      now: () => now,
      advanceTime: (milliseconds) => {
        now += milliseconds;
      },
      restart: async () => {
        throw new Error("fixture contains no restart operation");
      },
    });

    let finalSnapshots:
      Record<string, Awaited<ReturnType<typeof subject.snapshot>>> | undefined;
    for (const rawStep of fixture.scenario.steps) {
      const action = parseMdkScenarioStep(rawStep);
      const result = await subject.execute(action);
      expect(result.kind).toBe("supported");
      if (result.kind === "supported" && result.snapshots)
        finalSnapshots = result.snapshots;
    }
    expect(finalSnapshots).toBeDefined();

    const expectedClients = fixture.expected_outcomes.filter(
      (
        outcome,
      ): outcome is Extract<
        (typeof fixture.expected_outcomes)[number],
        { type: "client_state" }
      > => outcome.type === "client_state",
    );
    for (const expected of expectedClients) {
      const snapshot = finalSnapshots![expected.client]!;
      expect(snapshot.epoch).toBe(String(expected.epoch));
      expect(snapshot.leaves).toHaveLength(expected.member_count);
      expect(
        snapshot.application_outputs.map((output) => output.value),
      ).toEqual(expected.received_payloads);
    }
    for (const expected of fixture.expected_outcomes.filter(
      (outcome) => outcome.type === "group_profile",
    ))
      expect(groups.get(expected.client)!.groupData).toMatchObject({
        name: expected.name,
        description: expected.description,
      });

    const canonical = CLIENTS.map((client) => {
      const snapshot = finalSnapshots![client]!;
      return {
        epoch: snapshot.epoch,
        group_context_sha256: snapshot.group_context_sha256,
        exporter_commitment_sha256: snapshot.exporter_commitment_sha256,
        leaves: snapshot.leaves,
        app_data_dictionary: snapshot.app_data_dictionary,
      };
    });
    expect(canonical.slice(1)).toEqual(
      canonical.slice(1).map(() => canonical[0]),
    );
    expect(
      CLIENTS.every((client) => groups.get(client)!.lifecycle === "Stable"),
    ).toBe(true);
  }, 60_000);
});
