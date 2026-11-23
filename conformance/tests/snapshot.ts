import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defaultExtensionTypes,
  encode,
  getAppDataDictionary,
  isDefaultExtension,
  groupContextEncoder,
  mlsExporter,
  nodeTypes,
  type CiphersuiteImpl,
  type ClientState,
  type RequiredCapabilities,
  type ExtensionRequiredCapabilities,
} from "ts-mls";
import { getCredentialPubkey } from "../../src/core/credential.js";

export interface CanonicalConformanceSnapshot {
  group_id: string;
  epoch: string;
  group_context_sha256: string;
  exporter_commitment_sha256: string;
  leaves: Array<{
    index: number;
    account_identity: string;
    signature_public_key: string;
    capabilities: {
      versions: number[];
      ciphersuites: number[];
      extensions: number[];
      proposals: number[];
      credentials: number[];
    };
  }>;
  required_capabilities: RequiredCapabilities;
  app_data_dictionary: Array<{ component_id: number; value: string }>;
  lifecycle: string;
  convergence_status: string;
  local_gates: string[];
  unresolved_publications: CanonicalUnresolvedPublication[];
  input_dispositions: Array<{ input: string; disposition: string }>;
  application_outputs: Array<{
    identity: string;
    kind: string;
    value: string;
    observed: boolean;
  }>;
}

export interface CanonicalUnresolvedPublication {
  outbound_bytes: string;
  recipient_scope: string[];
  external_attempt_may_have_occurred: boolean;
  acknowledgement_succeeded: boolean;
  prior_state: { epoch: string; group_context_sha256: string };
  pending_state: { epoch: string; group_context_sha256: string };
}

export interface SnapshotProjectionInput {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  lifecycle: string;
  convergenceStatus: string;
  localGates?: string[];
  unresolvedPublications?: CanonicalUnresolvedPublication[];
  inputDispositions?: Array<{ input: string; disposition: string }>;
  applicationOutputs?: Array<{
    identity: string;
    kind: string;
    value: Uint8Array | string;
    observed: boolean;
  }>;
}

const SNAPSHOT_KEYS = [
  "app_data_dictionary",
  "application_outputs",
  "convergence_status",
  "epoch",
  "exporter_commitment_sha256",
  "group_context_sha256",
  "group_id",
  "input_dispositions",
  "leaves",
  "lifecycle",
  "local_gates",
  "required_capabilities",
  "unresolved_publications",
];

const UINT16_MAX = 0xffff;
const HEX = /^(?:[0-9a-f]{2})*$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new Error(`${label} has unknown or missing fields`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function hex(value: unknown, label: string, fixedLength?: number): string {
  const text = string(value, label);
  if (
    !HEX.test(text) ||
    (fixedLength !== undefined && text.length !== fixedLength)
  )
    throw new Error(
      `${label} must be lowercase hexadecimal${fixedLength ? ` of length ${fixedLength}` : ""}`,
    );
  return text;
}

function sortedUniqueUint16(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  let prior = -1;
  for (const item of value) {
    if (
      !Number.isInteger(item) ||
      item < 0 ||
      item > UINT16_MAX ||
      item <= prior
    )
      throw new Error(`${label} must contain sorted unique uint16 values`);
    prior = item;
  }
  return value as number[];
}

function sortedUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  let prior: string | undefined;
  for (const item of value) {
    const current = string(item, label);
    if (prior !== undefined && current <= prior)
      throw new Error(`${label} must contain sorted unique strings`);
    prior = current;
  }
  return value as string[];
}

function assertCanonicalConformanceSnapshot(
  value: unknown,
): asserts value is CanonicalConformanceSnapshot {
  const snapshot = object(value, "snapshot");
  exactKeys(snapshot, SNAPSHOT_KEYS, "snapshot");
  hex(snapshot.group_id, "group_id");
  if (!/^(?:0|[1-9][0-9]*)$/.test(string(snapshot.epoch, "epoch")))
    throw new Error("epoch must be an unsigned decimal integer");
  hex(snapshot.group_context_sha256, "group_context_sha256", 64);
  hex(snapshot.exporter_commitment_sha256, "exporter_commitment_sha256", 64);

  if (!Array.isArray(snapshot.leaves))
    throw new Error("leaves must be an array");
  let priorLeaf = -1;
  for (const [position, rawLeaf] of snapshot.leaves.entries()) {
    const leaf = object(rawLeaf, `leaves[${position}]`);
    exactKeys(
      leaf,
      ["index", "account_identity", "signature_public_key", "capabilities"],
      `leaves[${position}]`,
    );
    if (
      typeof leaf.index !== "number" ||
      !Number.isInteger(leaf.index) ||
      leaf.index <= priorLeaf
    )
      throw new Error("leaves must be strictly ordered by non-negative index");
    priorLeaf = leaf.index;
    hex(leaf.account_identity, `leaves[${position}].account_identity`, 64);
    hex(leaf.signature_public_key, `leaves[${position}].signature_public_key`);
    const capabilities = object(
      leaf.capabilities,
      `leaves[${position}].capabilities`,
    );
    exactKeys(
      capabilities,
      ["versions", "ciphersuites", "extensions", "proposals", "credentials"],
      `leaves[${position}].capabilities`,
    );
    for (const key of [
      "versions",
      "ciphersuites",
      "extensions",
      "proposals",
      "credentials",
    ] as const)
      sortedUniqueUint16(
        capabilities[key],
        `leaves[${position}].capabilities.${key}`,
      );
  }

  const required = object(
    snapshot.required_capabilities,
    "required_capabilities",
  );
  exactKeys(
    required,
    ["extensionTypes", "proposalTypes", "credentialTypes"],
    "required_capabilities",
  );
  for (const key of [
    "extensionTypes",
    "proposalTypes",
    "credentialTypes",
  ] as const)
    sortedUniqueUint16(required[key], `required_capabilities.${key}`);

  if (!Array.isArray(snapshot.app_data_dictionary))
    throw new Error("app_data_dictionary must be an array");
  let priorComponent = -1;
  for (const [position, rawEntry] of snapshot.app_data_dictionary.entries()) {
    const entry = object(rawEntry, `app_data_dictionary[${position}]`);
    exactKeys(
      entry,
      ["component_id", "value"],
      `app_data_dictionary[${position}]`,
    );
    if (
      typeof entry.component_id !== "number" ||
      !Number.isInteger(entry.component_id) ||
      entry.component_id <= priorComponent
    )
      throw new Error(
        "app_data_dictionary must be strictly ordered by component_id",
      );
    priorComponent = entry.component_id;
    hex(entry.value, `app_data_dictionary[${position}].value`);
  }

  if (
    ![
      "Stable",
      "PendingPublish",
      "Merging",
      "Recovering",
      "Unrecoverable",
    ].includes(string(snapshot.lifecycle, "lifecycle"))
  )
    throw new Error("lifecycle is invalid");
  if (
    !["Settled", "Syncing", "Resolving", "Blocked"].includes(
      string(snapshot.convergence_status, "convergence_status"),
    )
  )
    throw new Error("convergence_status is invalid");
  sortedUniqueStrings(snapshot.local_gates, "local_gates");

  if (!Array.isArray(snapshot.unresolved_publications))
    throw new Error("unresolved_publications must be an array");
  for (const [
    position,
    rawPublication,
  ] of snapshot.unresolved_publications.entries()) {
    const publication = object(
      rawPublication,
      `unresolved_publications[${position}]`,
    );
    exactKeys(
      publication,
      [
        "outbound_bytes",
        "recipient_scope",
        "external_attempt_may_have_occurred",
        "acknowledgement_succeeded",
        "prior_state",
        "pending_state",
      ],
      `unresolved_publications[${position}]`,
    );
    hex(
      publication.outbound_bytes,
      `unresolved_publications[${position}].outbound_bytes`,
    );
    sortedUniqueStrings(
      publication.recipient_scope,
      `unresolved_publications[${position}].recipient_scope`,
    );
    if (
      typeof publication.external_attempt_may_have_occurred !== "boolean" ||
      typeof publication.acknowledgement_succeeded !== "boolean"
    )
      throw new Error(
        `unresolved_publications[${position}] acknowledgement fields must be boolean`,
      );
    for (const stateKey of ["prior_state", "pending_state"] as const) {
      const state = object(
        publication[stateKey],
        `unresolved_publications[${position}].${stateKey}`,
      );
      exactKeys(
        state,
        ["epoch", "group_context_sha256"],
        `unresolved_publications[${position}].${stateKey}`,
      );
      if (!/^(?:0|[1-9][0-9]*)$/.test(string(state.epoch, `${stateKey}.epoch`)))
        throw new Error(
          `${stateKey}.epoch must be an unsigned decimal integer`,
        );
      hex(state.group_context_sha256, `${stateKey}.group_context_sha256`, 64);
    }
  }

  if (!Array.isArray(snapshot.input_dispositions))
    throw new Error("input_dispositions must be an array");
  const inputs = new Set<string>();
  for (const [
    position,
    rawDisposition,
  ] of snapshot.input_dispositions.entries()) {
    const disposition = object(
      rawDisposition,
      `input_dispositions[${position}]`,
    );
    exactKeys(
      disposition,
      ["input", "disposition"],
      `input_dispositions[${position}]`,
    );
    const input = string(
      disposition.input,
      `input_dispositions[${position}].input`,
    );
    if (inputs.has(input))
      throw new Error("input_dispositions identities must be unique");
    inputs.add(input);
    if (
      !["accepted", "stale", "deferred", "invalidated"].includes(
        string(
          disposition.disposition,
          `input_dispositions[${position}].disposition`,
        ),
      )
    )
      throw new Error(`input_dispositions[${position}].disposition is invalid`);
  }

  if (!Array.isArray(snapshot.application_outputs))
    throw new Error("application_outputs must be an array");
  const effects = new Set<string>();
  for (const [position, rawOutput] of snapshot.application_outputs.entries()) {
    const output = object(rawOutput, `application_outputs[${position}]`);
    exactKeys(
      output,
      ["identity", "kind", "value", "observed"],
      `application_outputs[${position}]`,
    );
    const identity = string(
      output.identity,
      `application_outputs[${position}].identity`,
    );
    if (effects.has(identity))
      throw new Error("application output identities must be unique");
    effects.add(identity);
    string(output.kind, `application_outputs[${position}].kind`);
    if (
      typeof output.value !== "string" ||
      typeof output.observed !== "boolean"
    )
      throw new Error(
        `application_outputs[${position}] has invalid value or observed field`,
      );
  }
}

export function validateCanonicalConformanceSnapshot(
  value: unknown,
): CanonicalConformanceSnapshot {
  assertCanonicalConformanceSnapshot(value);
  return value;
}

function requiredCapabilities(state: ClientState): RequiredCapabilities {
  const extension = state.groupContext.extensions.find(
    (candidate): candidate is ExtensionRequiredCapabilities =>
      isDefaultExtension(candidate) &&
      candidate.extensionType === defaultExtensionTypes.required_capabilities,
  );
  if (
    !extension ||
    extension.extensionType !== defaultExtensionTypes.required_capabilities
  )
    return { extensionTypes: [], proposalTypes: [], credentialTypes: [] };
  return {
    extensionTypes: [...extension.extensionData.extensionTypes].sort(
      (a, b) => a - b,
    ),
    proposalTypes: [...extension.extensionData.proposalTypes].sort(
      (a, b) => a - b,
    ),
    credentialTypes: [...extension.extensionData.credentialTypes].sort(
      (a, b) => a - b,
    ),
  };
}

export async function projectCanonicalConformanceSnapshot(
  input: SnapshotProjectionInput,
): Promise<CanonicalConformanceSnapshot> {
  const { state } = input;
  const contextBytes = encode(groupContextEncoder, state.groupContext);
  const exporter = await mlsExporter(
    state.keySchedule.exporterSecret,
    "marmot",
    new TextEncoder().encode("convergence-conformance-v1"),
    32,
    input.ciphersuite,
  );
  const commitmentDomain = new TextEncoder().encode(
    "marmot-convergence-conformance-v1",
  );
  const commitment = new Uint8Array(
    commitmentDomain.length + 1 + exporter.length,
  );
  commitment.set(commitmentDomain);
  commitment.set(exporter, commitmentDomain.length + 1);
  const leaves = state.ratchetTree.flatMap((node, nodeIndex) => {
    if (!node || node.nodeType !== nodeTypes.leaf) return [];
    const capabilities = node.leaf.capabilities;
    return [
      {
        index: nodeIndex / 2,
        account_identity: getCredentialPubkey(node.leaf.credential),
        signature_public_key: bytesToHex(node.leaf.signaturePublicKey),
        capabilities: {
          versions: [...capabilities.versions].sort((a, b) => a - b),
          ciphersuites: [...capabilities.ciphersuites].sort((a, b) => a - b),
          extensions: [...capabilities.extensions].sort((a, b) => a - b),
          proposals: [...capabilities.proposals].sort((a, b) => a - b),
          credentials: [...capabilities.credentials].sort((a, b) => a - b),
        },
      },
    ];
  });
  return {
    group_id: bytesToHex(state.groupContext.groupId),
    epoch: state.groupContext.epoch.toString(),
    group_context_sha256: bytesToHex(sha256(contextBytes)),
    exporter_commitment_sha256: bytesToHex(sha256(commitment)),
    leaves,
    required_capabilities: requiredCapabilities(state),
    app_data_dictionary: [
      ...(getAppDataDictionary(state.groupContext.extensions) ?? []),
    ]
      .sort((a, b) => a.componentId - b.componentId)
      .map((entry) => ({
        component_id: entry.componentId,
        value: bytesToHex(entry.data),
      })),
    lifecycle: input.lifecycle,
    convergence_status: input.convergenceStatus,
    local_gates: [...(input.localGates ?? [])].sort(),
    unresolved_publications: [...(input.unresolvedPublications ?? [])],
    input_dispositions: [...(input.inputDispositions ?? [])],
    application_outputs: (input.applicationOutputs ?? []).map((output) => ({
      ...output,
      value:
        typeof output.value === "string"
          ? output.value
          : bytesToHex(output.value),
    })),
  };
}
