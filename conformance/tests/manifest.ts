import path from "node:path";

export const conformanceCapabilities = [
  "group_mutation",
  "application_messaging",
  "transport_delivery",
  "crash_reopen",
  "virtual_time",
  "semantic_transport_faults",
  "observation",
  "multi_group",
] as const;

export type ConformanceCapability = (typeof conformanceCapabilities)[number];

export interface ConformanceManifestEntry {
  id: string;
  kind:
    | "scenario_vector"
    | "scenario"
    | "generated_scenario_family"
    | "formal_case_fixture"
    | "byte_fixture";
  status:
    | "portable"
    | "incident_replay"
    | "rust_only_bridge"
    | "rust_only"
    | "generated"
    | "portable_policy_fixture";
  artifact?: string;
  coverage: string[];
  next: string;
}

export interface ConformanceManifest {
  manifest_version: "1";
  updated: string;
  purpose: string;
  entries: ConformanceManifestEntry[];
}

const MANIFEST_KEYS = ["entries", "manifest_version", "purpose", "updated"];
const ENTRY_KEYS = ["artifact", "coverage", "id", "kind", "next", "status"];
const CATALOG_ENTRY_KEYS = ["coverage", "id", "kind", "next", "status"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  where: string,
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  )
    throw new Error(`${where} has unknown or missing fields`);
}

export function resolveManifestArtifact(
  vectorsRoot: string,
  artifact: string,
): string {
  if (!artifact || path.isAbsolute(artifact))
    throw new Error("artifact must be a relative path");
  const root = path.resolve(vectorsRoot);
  const resolved = path.resolve(root, artifact);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`))
    throw new Error("artifact escapes vectors root");
  return resolved;
}

export function validateConformanceManifest(
  raw: unknown,
  vectorsRoot: string,
): ConformanceManifest {
  if (!isRecord(raw)) throw new Error("manifest must be an object");
  requireExactKeys(raw, MANIFEST_KEYS, "manifest");
  if (
    raw.manifest_version !== "1" ||
    typeof raw.updated !== "string" ||
    typeof raw.purpose !== "string"
  )
    throw new Error("invalid manifest header");
  if (!Array.isArray(raw.entries))
    throw new Error("manifest entries must be an array");
  const entries = raw.entries.map(
    (candidate, index): ConformanceManifestEntry => {
      if (!isRecord(candidate))
        throw new Error(`entry ${index} must be an object`);
      requireExactKeys(
        candidate,
        "artifact" in candidate ? ENTRY_KEYS : CATALOG_ENTRY_KEYS,
        `entry ${index}`,
      );
      if (
        typeof candidate.id !== "string" ||
        ![
          "scenario_vector",
          "scenario",
          "generated_scenario_family",
          "formal_case_fixture",
          "byte_fixture",
        ].includes(String(candidate.kind)) ||
        ![
          "portable",
          "incident_replay",
          "rust_only_bridge",
          "rust_only",
          "generated",
          "portable_policy_fixture",
        ].includes(String(candidate.status)) ||
        ("artifact" in candidate && typeof candidate.artifact !== "string") ||
        !Array.isArray(candidate.coverage) ||
        !candidate.coverage.every((item) => typeof item === "string") ||
        typeof candidate.next !== "string"
      )
        throw new Error(`entry ${index} is malformed`);
      // Only portable scenario vectors are executable by this adapter. Other
      // manifest records are inventory (some deliberately point at Rust/formal
      // sources outside vectors/) and are never exposed as loadable artifacts.
      if (
        candidate.kind === "scenario_vector" &&
        typeof candidate.artifact === "string"
      )
        resolveManifestArtifact(vectorsRoot, candidate.artifact);
      return candidate as unknown as ConformanceManifestEntry;
    },
  );
  return {
    manifest_version: "1",
    updated: raw.updated,
    purpose: raw.purpose,
    entries,
  };
}
