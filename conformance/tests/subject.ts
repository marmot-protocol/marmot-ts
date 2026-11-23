import type { MarmotGroup } from "../../src/client/group/marmot-group.js";
import type { MockNetwork } from "../../src/__tests__/helpers/mock-network.js";
import type { CanonicalConformanceSnapshot } from "./snapshot.js";
import { projectCanonicalConformanceSnapshot } from "./snapshot.js";
import type { ConformanceCapability } from "./manifest.js";
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "../../src/client/group/application-message.js";
import { deserializeApplicationRumor } from "../../src/core/application-rumor.js";
import { proposeUpdateMetadata } from "../../src/client/group/proposals/update-metadata.js";
import { proposeInviteUser } from "../../src/client/group/proposals/invite-user.js";
import type { KeyPackage } from "ts-mls";

export type ConformanceAction =
  | { type: "send_application"; client: string; input: string; payload: string }
  | { type: "create_group"; creator: string; invitees: string[]; name: string }
  | { type: "deliver_all" }
  | { type: "advance_time"; milliseconds: number }
  | { type: "tick"; clients: string[] }
  | { type: "clear_events"; clients: string[] }
  | { type: "acknowledge_outbound"; client: string; publication: string }
  | { type: "update_group_data"; client: string; name: string }
  | { type: "invite_members"; inviter: string; invitees: string[] }
  | { type: "update_admin_policy"; client: string; admins: string[] }
  | { type: "observe_admin_policy"; clients: string[] }
  | { type: "set_partition" }
  | { type: "withhold_message"; label: string }
  | { type: "release_withheld"; label: string }
  | { type: "duplicate_message" }
  | { type: "reorder_messages" }
  | { type: "observe_exact"; clients: string[] }
  | { type: "restart"; client: string }
  | { type: "snapshot"; client: string }
  | {
      type: "scenario_operation";
      operation: string;
      capability: ConformanceCapability;
      step: Readonly<Record<string, unknown>>;
    };

export type ConformanceActionResult =
  | {
      kind: "supported";
      action: ConformanceAction["type"];
      snapshot?: CanonicalConformanceSnapshot;
      snapshots?: Record<string, CanonicalConformanceSnapshot>;
    }
  | {
      kind: "unsupported";
      scenarioId: string;
      capability: ConformanceCapability;
      reason: string;
    };

export interface MarmotConformanceSubjectOptions {
  scenarioId: string;
  groups: Map<string, MarmotGroup>;
  network: MockNetwork;
  capabilities: ReadonlySet<ConformanceCapability>;
  now: () => number;
  advanceTime: (milliseconds: number) => void;
  restart: (client: string, group: MarmotGroup) => Promise<MarmotGroup>;
  executeScenarioOperation?: (
    step: Readonly<Record<string, unknown>>,
    subject: MarmotConformanceSubject,
  ) => Promise<void>;
  identities?: ReadonlyMap<string, string>;
  keyPackages?: ReadonlyMap<string, KeyPackage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

const ACTION_CAPABILITY: Record<
  ConformanceAction["type"],
  ConformanceCapability
> = {
  send_application: "application_messaging",
  create_group: "group_mutation",
  deliver_all: "transport_delivery",
  advance_time: "virtual_time",
  tick: "transport_delivery",
  clear_events: "observation",
  acknowledge_outbound: "transport_delivery",
  update_group_data: "group_mutation",
  invite_members: "group_mutation",
  update_admin_policy: "group_mutation",
  observe_admin_policy: "observation",
  set_partition: "semantic_transport_faults",
  withhold_message: "semantic_transport_faults",
  release_withheld: "semantic_transport_faults",
  duplicate_message: "semantic_transport_faults",
  reorder_messages: "semantic_transport_faults",
  observe_exact: "observation",
  restart: "crash_reopen",
  snapshot: "transport_delivery",
  scenario_operation: "group_mutation",
};

const STEP_CAPABILITY: Record<string, ConformanceCapability> = {
  create_group: "group_mutation",
  acknowledge_outbound: "transport_delivery",
  deliver_all: "transport_delivery",
  tick: "virtual_time",
  send_app_message: "application_messaging",
  observe: "observation",
  clear_events: "observation",
  invite_members: "group_mutation",
  update_group_data: "group_mutation",
  update_group_profile: "group_mutation",
  observe_exact: "observation",
  probe_bidirectional_decryptability: "application_messaging",
  expect_update_admin_policy_error: "group_mutation",
  update_admin_policy: "group_mutation",
  observe_admin_policy: "observation",
  set_partition: "semantic_transport_faults",
  withhold_message: "semantic_transport_faults",
  release_withheld: "semantic_transport_faults",
  restart_client: "crash_reopen",
  await_quiescence: "virtual_time",
  omit_message: "semantic_transport_faults",
  duplicate_message: "semantic_transport_faults",
  reorder_messages: "semantic_transport_faults",
  clear_partition: "semantic_transport_faults",
  leave: "group_mutation",
  assert: "observation",
  remove_members: "group_mutation",
  in_group: "multi_group",
};

/** Strictly maps one MDK Scenario IR operation to a declared adapter capability. */
export function parseMdkScenarioStep(value: unknown): ConformanceAction {
  if (!isRecord(value)) throw new Error("Scenario IR step must be an object");
  const step = value;
  if (typeof step.type !== "string")
    throw new Error("Scenario IR step must declare a string type");
  const capability = STEP_CAPABILITY[step.type];
  if (!capability)
    throw new Error(`Unsupported Scenario IR operation ${step.type}`);
  if (
    step.type === "create_group" &&
    typeof step.creator === "string" &&
    typeof step.name === "string" &&
    isStringArray(step.invitees)
  )
    return {
      type: "create_group",
      creator: step.creator,
      invitees: step.invitees,
      name: step.name,
    };
  if (step.type === "deliver_all") return { type: "deliver_all" };
  if (step.type === "tick" && isStringArray(step.clients))
    return { type: "tick", clients: step.clients };
  if (step.type === "clear_events" && isStringArray(step.clients))
    return { type: "clear_events", clients: step.clients };
  if (
    step.type === "acknowledge_outbound" &&
    typeof step.client === "string" &&
    typeof step.publication === "string"
  )
    return {
      type: "acknowledge_outbound",
      client: step.client,
      publication: step.publication,
    };
  if (
    step.type === "update_group_data" &&
    typeof step.client === "string" &&
    typeof step.name === "string"
  )
    return { type: "update_group_data", client: step.client, name: step.name };
  if (step.type === "observe_exact" && isStringArray(step.clients))
    return { type: "observe_exact", clients: step.clients };
  if (step.type === "observe" && isStringArray(step.clients))
    return { type: "observe_exact", clients: step.clients };
  if (
    step.type === "invite_members" &&
    typeof step.inviter === "string" &&
    isStringArray(step.invitees)
  )
    return {
      type: "invite_members",
      inviter: step.inviter,
      invitees: step.invitees,
    };
  if (
    step.type === "update_admin_policy" &&
    typeof step.client === "string" &&
    isStringArray(step.admins)
  )
    return {
      type: "update_admin_policy",
      client: step.client,
      admins: step.admins,
    };
  if (step.type === "observe_admin_policy" && isStringArray(step.clients))
    return { type: "observe_admin_policy", clients: step.clients };
  if (step.type === "set_partition") return { type: "set_partition" };
  if (step.type === "withhold_message" && typeof step.label === "string")
    return { type: "withhold_message", label: step.label };
  if (step.type === "release_withheld" && typeof step.label === "string")
    return { type: "release_withheld", label: step.label };
  if (step.type === "duplicate_message") return { type: "duplicate_message" };
  if (step.type === "reorder_messages") return { type: "reorder_messages" };
  if (step.type === "restart_client" && typeof step.client === "string")
    return { type: "restart", client: step.client };
  if (
    step.type === "send_app_message" &&
    typeof step.sender === "string" &&
    typeof step.payload === "string"
  )
    return {
      type: "send_application",
      client: step.sender,
      input: step.payload,
      payload: step.payload,
    };
  return {
    type: "scenario_operation",
    operation: step.type,
    capability,
    step,
  };
}

/** Production-backed deterministic boundary used by portable conformance scenarios. */
export class MarmotConformanceSubject {
  readonly #dispositions: Array<{ input: string; disposition: string }> = [];
  readonly #deliveryCursor = new Map<string, number>();
  readonly #outputs = new Map<
    string,
    Array<{
      identity: string;
      kind: string;
      value: string;
      observed: boolean;
    }>
  >();
  readonly #withheld = new Map<
    string,
    (typeof this.options.network.queuedEvents)[number]
  >();

  constructor(readonly options: MarmotConformanceSubjectOptions) {}

  support(action: ConformanceAction): ConformanceActionResult | undefined {
    const capability =
      action.type === "scenario_operation"
        ? action.capability
        : ACTION_CAPABILITY[action.type];
    if (
      this.options.capabilities.has(capability) &&
      (action.type !== "scenario_operation" ||
        this.options.executeScenarioOperation !== undefined)
    )
      return undefined;
    return {
      kind: "unsupported",
      scenarioId: this.options.scenarioId,
      capability,
      reason: `subject does not support ${capability}`,
    };
  }

  async execute(action: ConformanceAction): Promise<ConformanceActionResult> {
    const unsupported = this.support(action);
    if (unsupported) return unsupported;
    switch (action.type) {
      case "create_group": {
        const clients = [action.creator, ...action.invitees];
        const groups = clients.map((client) => this.requireGroup(client));
        if (new Set(groups).size !== groups.length)
          throw new Error("scenario clients must use distinct group actors");
        const groupIds = new Set(groups.map((group) => group.idStr));
        if (groupIds.size !== 1)
          throw new Error("scenario clients do not share one MLS group");
        if (groups.some((group) => group.groupData?.name !== action.name))
          throw new Error("scenario group name does not match fixture");
        return { kind: "supported", action: action.type };
      }
      case "send_application": {
        const group = this.requireGroup(action.client);
        const identity = this.options.identities?.get(action.client);
        const effects = await group.session.send(
          identity
            ? createApplicationMessageIntent(
                createChatRumor({
                  pubkey: identity,
                  content: action.payload,
                  created_at: this.options.now(),
                }),
              )
            : {
                kind: "applicationMessage",
                payload: new TextEncoder().encode(action.payload),
              },
        );
        await group.runtime.publishEffects(effects);
        this.#dispositions.push({
          input: action.input,
          disposition: "accepted",
        });
        return { kind: "supported", action: action.type };
      }
      case "deliver_all":
        this.options.network.deliverQueued();
        return { kind: "supported", action: action.type };
      case "advance_time":
        this.options.advanceTime(action.milliseconds);
        return { kind: "supported", action: action.type };
      case "tick": {
        for (const client of action.clients) {
          const group = this.requireGroup(client);
          const cursor = this.#deliveryCursor.get(client) ?? 0;
          const events = this.options.network.events.slice(cursor);
          const batchOutputs: Array<{
            identity: string;
            kind: string;
            value: string;
            observed: boolean;
          }> = [];
          for await (const result of group.ingest(events)) {
            if (
              result.kind === "processed" &&
              result.result.kind === "applicationMessage"
            ) {
              const rumor = deserializeApplicationRumor(result.result.message);
              batchOutputs.push({
                identity: rumor.id,
                kind: "message",
                value: rumor.content,
                observed: true,
              });
            }
          }
          // Preserve the fixture's tick/batch order, while canonicalizing the
          // independent messages surfaced by one ingest/retry pass.
          batchOutputs.sort(
            (left, right) =>
              left.value.localeCompare(right.value) ||
              left.identity.localeCompare(right.identity),
          );
          this.#outputs.set(client, [
            ...(this.#outputs.get(client) ?? []),
            ...batchOutputs,
          ]);
          this.#deliveryCursor.set(client, this.options.network.events.length);
        }
        return { kind: "supported", action: action.type };
      }
      case "clear_events":
        for (const client of action.clients) this.#outputs.set(client, []);
        return { kind: "supported", action: action.type };
      case "acknowledge_outbound":
        // The production mock publisher acknowledges synchronously; reaching
        // this step verifies that the named client's prior publication did not
        // leave it outside Stable.
        if (this.requireGroup(action.client).lifecycle !== "Stable")
          throw new Error(`${action.publication}: publication is not stable`);
        return { kind: "supported", action: action.type };
      case "update_group_data": {
        const group = this.requireGroup(action.client);
        const actorPubkey = this.options.identities?.get(action.client);
        if (!actorPubkey)
          throw new Error(`missing identity for ${action.client}`);
        const proposals = await proposeUpdateMetadata({ name: action.name })(
          group.session.proposalContext(),
        );
        const effects = await group.session.send({
          kind: "commit",
          actorPubkey,
          extraProposals: proposals,
        });
        await group.runtime.publishEffects(effects);
        return { kind: "supported", action: action.type };
      }
      case "invite_members": {
        const group = this.requireGroup(action.inviter);
        const actorPubkey = this.options.identities?.get(action.inviter);
        if (!actorPubkey)
          throw new Error(`missing identity for ${action.inviter}`);
        const proposals = action.invitees.map((invitee) => {
          const keyPackage = this.options.keyPackages?.get(invitee);
          if (!keyPackage)
            throw new Error(`missing key package for ${invitee}`);
          return proposeInviteUser(keyPackage);
        });
        await group.submitIntent({
          kind: "commit",
          actorPubkey,
          extraProposals: proposals,
        });
        return { kind: "supported", action: action.type };
      }
      case "update_admin_policy": {
        if (action.admins.length === 0) throw new Error("admin_policy");
        const group = this.requireGroup(action.client);
        const actorPubkey = this.options.identities?.get(action.client);
        if (
          !actorPubkey ||
          !group.groupData?.adminPubkeys.includes(actorPubkey)
        )
          throw new Error("not_group_admin");
        const adminPubkeys = action.admins.map((client) => {
          const pubkey = this.options.identities?.get(client);
          if (!pubkey) throw new Error(`missing identity for ${client}`);
          return pubkey;
        });
        const proposals = await proposeUpdateMetadata({ adminPubkeys })(
          group.session.proposalContext(),
        );
        await group.submitIntent({
          kind: "commit",
          actorPubkey,
          extraProposals: proposals,
        });
        return { kind: "supported", action: action.type };
      }
      case "observe_admin_policy":
        for (const client of action.clients)
          this.requireGroup(client).groupData;
        return { kind: "supported", action: action.type };
      case "set_partition":
        this.options.network.autoDeliver = false;
        return { kind: "supported", action: action.type };
      case "withhold_message": {
        const event = this.options.network.queuedEvents.pop();
        if (!event) throw new Error(`nothing to withhold as ${action.label}`);
        this.#withheld.set(action.label, event);
        return { kind: "supported", action: action.type };
      }
      case "release_withheld": {
        const event = this.#withheld.get(action.label);
        if (!event) throw new Error(`unknown withheld label ${action.label}`);
        this.options.network.queuedEvents.push(event);
        this.#withheld.delete(action.label);
        return { kind: "supported", action: action.type };
      }
      case "duplicate_message":
        this.options.network.duplicateQueued(0);
        return { kind: "supported", action: action.type };
      case "reorder_messages":
        this.options.network.queuedEvents.reverse();
        return { kind: "supported", action: action.type };
      case "observe_exact": {
        const snapshots: Record<string, CanonicalConformanceSnapshot> = {};
        for (const client of action.clients)
          snapshots[client] = await this.snapshot(client);
        return { kind: "supported", action: action.type, snapshots };
      }
      case "restart": {
        const group = this.requireGroup(action.client);
        this.options.groups.set(
          action.client,
          await this.options.restart(action.client, group),
        );
        return { kind: "supported", action: action.type };
      }
      case "snapshot": {
        this.requireGroup(action.client);
        return {
          kind: "supported",
          action: action.type,
          snapshot: await this.snapshot(action.client),
        };
      }
      case "scenario_operation":
        await this.options.executeScenarioOperation!(action.step, this);
        return {
          kind: "supported",
          action: action.type,
        };
    }
  }

  async snapshot(client: string): Promise<CanonicalConformanceSnapshot> {
    const group = this.requireGroup(client);
    return projectCanonicalConformanceSnapshot({
      state: group.state,
      ciphersuite: group.ciphersuite,
      lifecycle: group.lifecycle,
      convergenceStatus: group.convergenceStatus,
      inputDispositions: this.#dispositions,
      applicationOutputs: this.#outputs.get(client),
    });
  }

  private requireGroup(client: string): MarmotGroup {
    const group = this.options.groups.get(client);
    if (!group)
      throw new Error(`${this.options.scenarioId}: unknown client ${client}`);
    return group;
  }
}
