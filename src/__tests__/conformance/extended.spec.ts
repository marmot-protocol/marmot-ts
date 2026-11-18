import fixture from "../../../refs/mdk/crates/cgka-conformance-simulator/vectors/deferred-tick-catchup.v1.json" with { type: "json" };
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
import { memoryStorage } from "../../utils/storage.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { MarmotConformanceSubject, parseMdkScenarioStep } from "./subject.js";

const CLIENTS = ["alice", "bob", "carol", "dave"] as const;
type Client = (typeof CLIENTS)[number];

type ExpectedOutcome =
  | {
      type: "client_state";
      client: Client;
      epoch: number;
      member_count: number;
      received_payloads: string[];
    }
  | { type: "group_profile"; client: Client; name: string; description: string }
  | {
      type: "pending_resolution";
      client: Client;
      step_index: number;
      pending: string;
      resolution: "confirmed";
    }
  | {
      type: "clients_converged";
      clients: Client[];
      epoch: number;
      member_count: number;
    }
  | { type: "no_pending_work"; clients: Client[] };

function requireClient(value: unknown): Client {
  switch (value) {
    case "alice":
    case "bob":
    case "carol":
    case "dave":
      return value;
    default:
      throw new Error(`Unknown fixture actor: ${String(value)}`);
  }
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected fixture text");
  return value;
}

function requireCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Expected a nonnegative fixture count");
  return value;
}

function requireStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected fixture text list");
  return value.map(requireString);
}

function validateExpectedOutcome(value: unknown): ExpectedOutcome {
  if (typeof value !== "object" || value === null || !("type" in value))
    throw new Error("Expected a discriminated fixture outcome");
  if (
    value.type === "client_state" &&
    "client" in value &&
    "epoch" in value &&
    "member_count" in value &&
    "received_payloads" in value
  )
    return {
      type: value.type,
      client: requireClient(value.client),
      epoch: requireCount(value.epoch),
      member_count: requireCount(value.member_count),
      received_payloads: requireStrings(value.received_payloads),
    };
  if (
    value.type === "group_profile" &&
    "client" in value &&
    "name" in value &&
    "description" in value
  )
    return {
      type: value.type,
      client: requireClient(value.client),
      name: requireString(value.name),
      description: requireString(value.description),
    };
  if (
    value.type === "pending_resolution" &&
    "client" in value &&
    "step_index" in value &&
    "pending" in value &&
    "resolution" in value &&
    value.resolution === "confirmed"
  )
    return {
      type: value.type,
      client: requireClient(value.client),
      step_index: requireCount(value.step_index),
      pending: requireString(value.pending),
      resolution: value.resolution,
    };
  if (
    value.type === "clients_converged" &&
    "clients" in value &&
    "epoch" in value &&
    "member_count" in value
  )
    return {
      type: value.type,
      clients: requireStrings(value.clients).map(requireClient),
      epoch: requireCount(value.epoch),
      member_count: requireCount(value.member_count),
    };
  if (value.type === "no_pending_work" && "clients" in value)
    return {
      type: value.type,
      clients: requireStrings(value.clients).map(requireClient),
    };
  throw new Error(`Invalid fixture outcome: ${String(value.type)}`);
}

const expectedOutcomes = fixture.expected_outcomes.map(validateExpectedOutcome);

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
    const states = new Map<Client, ClientState>([["alice", add.newState]]);
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
    const groups = new Map<Client, MarmotGroup>();
    for (const client of CLIENTS) {
      const group = new MarmotGroup(states.get(client)!, {
        storage: memoryStorage(),
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

    const expectedClients = expectedOutcomes.filter(
      (
        outcome,
      ): outcome is Extract<ExpectedOutcome, { type: "client_state" }> =>
        outcome.type === "client_state",
    );
    for (const expected of expectedClients) {
      const snapshot = finalSnapshots![expected.client]!;
      expect(snapshot.epoch).toBe(String(expected.epoch));
      expect(snapshot.leaves).toHaveLength(expected.member_count);
      expect(
        snapshot.application_outputs.map((output) => output.value),
      ).toEqual(expected.received_payloads);
    }
    for (const expected of expectedOutcomes.filter(
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
