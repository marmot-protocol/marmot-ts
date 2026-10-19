import { describe, expect, expectTypeOf, it } from "vitest";
import { defaultCredentialTypes } from "ts-mls";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  GroupHistoryTree,
  groupWithdrawnNotificationsByCommit,
  type AuditContextOptions,
  type AuditSink,
  type AppliedNotificationsIngestResult,
  type ConvergenceScheduler,
  type EdgeSnapshot,
  type HistoryEdge,
  type HistoryNode,
  type RetainedHistoryStore,
  type StateInvalidatedIngestResult,
  type StateNotification,
  type TimerHandle,
} from "../index.js";
import * as exports from "../index.js";
// MLS is audited explicitly while the nine owned namespaces retain snapshots.
import * as mlsExports from "../mls.js";
import * as clientExports from "../client/index.js";
import * as coreExports from "../core/index.js";
import * as engineExports from "../engine/index.js";
import * as extraExports from "../extra/index.js";
import * as utilsExports from "../utils/index.js";
import * as auditExports from "../audit/index.js";
import * as extraAuditNodeExports from "../extra/audit/node.js";
import * as extraAuditBrowserExports from "../extra/audit/browser.js";

type RootSignatureTypes =
  | StateNotification
  | AppliedNotificationsIngestResult
  | StateInvalidatedIngestResult
  | AuditContextOptions
  | AuditSink
  | ConvergenceScheduler
  | EdgeSnapshot
  | HistoryEdge
  | HistoryNode
  | RetainedHistoryStore
  | TimerHandle;

type ClientSignatureTypes = [
  clientExports.GeneratedKeyPackage,
  clientExports.GenerateKeyPackageOptions,
  clientExports.PublishKeyPackageOptions,
  clientExports.CreateGroupOptions,
  clientExports.KeyPackageConsumptionReceipt,
  clientExports.RejectReason,
  clientExports.SessionIngestResult<
    clientExports.EngineIngestResultOfKind<"processed">
  >,
];
type CoreSignatureTypes = [
  coreExports.OpaqueBounds,
  coreExports.ConvergenceStatus,
  coreExports.MediaCryptoFields,
];
type EngineSignatureTypes = [
  engineExports.DisbandTombstone,
  engineExports.DisbandNotificationState,
  engineExports.DeliveredAppPayload<string>,
];

const PRIVATE_EXPORT_NAMES = [
  "HistoryRetentionPin",
  "HistoryRetentionOptions",
  "HistoryRetentionPlan",
  "retentionFloor",
  "retainedTopology",
  "projectHistoricalReceivers",
  "encodeCheckpoint",
  "decodeCheckpoint",
  "TreeCheckpoint",
  "HistoryTreeStore",
  "RetentionLease",
  "registerSettledRetentionOwner",
  "unregisterSettledRetentionOwner",
  "completeSettledRetentionOwner",
  "registerPublicationRetention",
  "linkPublicationRetention",
  "confirmPublicationRetention",
  "unregisterPublicationRetention",
  "registerPublicationPreparationOwner",
  "unregisterPublicationPreparationOwner",
  "rejectPublicationPreparation",
  "encodeDeliveredEvidence",
  "decodeDeliveredEvidence",
  "DeliveredEvidence",
  "retainSettled",
  "prepareRetention",
  "publishRetention",
  "resumeRetentionCleanup",
  "isRetentionPublished",
  "DeferredEntry",
  "GroupFactory",
  "GroupFactoryOptions",
  "FoundingCreateResult",
  "FoundingPendingRecord",
  "DeliveredPayloadLedger",
  "disbandTombstoneKey",
  "encodeDisbandTombstone",
  "decodeDisbandTombstone",
  "disbandTerminalIntentKey",
  "encodeDisbandTerminalIntent",
  "decodeDisbandTerminalIntent",
  "disbandRegistryStateKey",
  "removalEvidenceKey",
  "defaultVerifyEvent",
  "safeVerifyEvent",
  "convergenceStatuses",
  "AccountIdentityProofRequest",
  "AccountIdentityProof",
  "SignedAccountIdentityProofEvent",
  "AccountIdentityProofEventSigner",
  "AccountIdentityProofSigner",
] as const;

// D-02 legacy-export guard. The 15 legacy account-identity-proof exports removed in
// `ef756c8` (07-07-SUMMARY.md coverage D2) — a frozen historical exact-match list, not a
// fuzzy/substring check: current exports like `AccountIdentityProofError`,
// `accountIdentityProofTemplate`, and `validateLeafAccountIdentityProof` legitimately
// contain the token `AccountIdentityProof` and must not be flagged.
const REMOVED_LEGACY_EXPORT_NAMES: ReadonlySet<string> = new Set([
  "ACCOUNT_IDENTITY_PROOF_EVENT_KIND",
  "ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE",
  "accountIdentityProofEventId",
  "accountIdentityProofEventJson",
  "accountIdentityProofSignatureFromSignedEvent",
  "accountIdentityProofSigningDigest",
  "buildAccountIdentityProofEvent",
  "buildAccountIdentityProofExtension",
  "decodeAccountIdentityProof",
  "encodeAccountIdentityProof",
  "makeAccountIdentityProofExtension",
  "mlsSignatureScheme",
  "signAccountIdentityProof",
  "verifyAllLeafAccountIdentityProofs",
  "verifyLeafAccountIdentityProof",
]);

// Catches new legacy-shaped names (e.g. an accidental export of the private legacy
// constant) that the frozen denylist above would miss. Verified against the root
// snapshot during planning to match no current export.
const LEGACY_EXPORT_NAME_PATTERN =
  /LEGACY_ACCOUNT_IDENTITY_PROOF|AccountIdentityProof(Event|Extension)|ACCOUNT_IDENTITY_PROOF_(EVENT|EXTENSION)/i;

const LEGACY_PROOF_EXTENSION_TYPE = 0xf2f1;

const MAX_LEGACY_VALUE_SCAN_DEPTH = 4;

/**
 * Walks a public export namespace looking for a removed legacy export name, a
 * legacy-proof-shaped name, or any value (top-level or nested in arrays, Sets, Maps,
 * plain objects, or class statics) equal to the legacy `0xf2f1` extension type as a
 * number, bigint, or hex string. Only own string-keyed data descriptors of plain
 * objects/functions and exact built-in Array/Set/Map containers are inspected.
 * Accessors, prototypes, arbitrary instances and function bodies are not followed.
 * A minimum-depth WeakMap stops cycles while allowing shallower alias rescans;
 * a depth cap bounds the walk. Typed arrays, symbols,
 * legacy domain strings and factory results are outside this syntax/value audit.
 * Returns an empty array when the namespace is clean.
 */
function findLegacyExportViolations(
  namespace: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  const visited = new WeakMap<object, number>();

  function isLegacyExtensionTypeValue(value: unknown): boolean {
    if (typeof value === "number") return value === LEGACY_PROOF_EXTENSION_TYPE;
    if (typeof value === "bigint")
      return value === BigInt(LEGACY_PROOF_EXTENSION_TYPE);
    if (typeof value === "string") return value.toLowerCase() === "0xf2f1";
    return false;
  }

  function walk(value: unknown, path: string, depth: number): void {
    if (depth > MAX_LEGACY_VALUE_SCAN_DEPTH) return;
    if (isLegacyExtensionTypeValue(value)) {
      violations.push(`${path}: equals the legacy 0xf2f1 extension type`);
      return;
    }
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return;
    const container = value as object;
    const previousDepth = visited.get(container);
    if (previousDepth !== undefined && previousDepth <= depth) return;
    visited.set(container, depth);

    const proto: unknown = Object.getPrototypeOf(container);
    const isArray = Array.isArray(container) && proto === Array.prototype;
    const isSet = proto === Set.prototype;
    const isMap = proto === Map.prototype;
    if (
      !isArray &&
      !isSet &&
      !isMap &&
      typeof container !== "function" &&
      proto !== Object.prototype &&
      proto !== null
    )
      return;
    if (isSet) {
      let index = 0;
      for (const entry of Set.prototype.values.call(
        container,
      ) as Iterable<unknown>) {
        walk(entry, `${path}<set:${index}>`, depth + 1);
        index++;
      }
    }
    if (isMap) {
      let index = 0;
      for (const [key, entry] of Map.prototype.entries.call(
        container,
      ) as Iterable<[unknown, unknown]>) {
        walk(key, `${path}<map-key:${index}>`, depth + 1);
        walk(entry, `${path}<map-value:${index}>`, depth + 1);
        index++;
      }
    }
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(container),
    )) {
      if (!Object.hasOwn(descriptor, "value")) continue;
      if (typeof container === "function" && key === "prototype") continue;
      const childPath =
        isArray && /^\d+$/.test(key)
          ? `${path}[${key}]`
          : path
            ? `${path}.${key}`
            : key;
      if (REMOVED_LEGACY_EXPORT_NAMES.has(key))
        violations.push(`${childPath}: removed legacy export name`);
      else if (LEGACY_EXPORT_NAME_PATTERN.test(key))
        violations.push(`${childPath}: legacy-proof-shaped export name`);
      walk(descriptor.value as unknown, childPath, depth + 1);
    }
  }

  walk(namespace, "", -1);

  return violations;
}

const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, string | { types: string; import: string }> };

const PUBLIC_CODE_ENTRIES = Object.entries(packageManifest.exports)
  .filter(([key]) => key !== "./package.json")
  .map(([key, target]) => {
    if (
      typeof target !== "object" ||
      typeof target.types !== "string" ||
      typeof target.import !== "string"
    )
      throw new Error(`${key}: expected runtime and types export targets`);
    if (
      !/^\.\/dist\/.+\.d\.ts$/.test(target.types) ||
      target.import !== target.types.replace(/\.d\.ts$/, ".js")
    )
      throw new Error(
        `${key}: runtime/types export targets must describe the same supported source`,
      );
    return {
      key,
      sourcePath: target.types
        .replace(/^\.\/dist\//, "src/")
        .replace(/\.d\.ts$/, ".ts"),
    };
  });

const PUBLIC_NAMESPACES: Record<string, Record<string, unknown>> = {
  ".": exports,
  "./mls": mlsExports,
  "./client": clientExports,
  "./core": coreExports,
  "./engine": engineExports,
  "./audit": auditExports,
  "./extra": extraExports,
  "./extra/audit/node": extraAuditNodeExports,
  "./extra/audit/browser": extraAuditBrowserExports,
  "./utils": utilsExports,
};

const REPRESENTATIVE_EXPORTS: Record<string, string> = {
  ".": "MarmotClient",
  "./mls": "groupContextEncoder",
  "./client": "GroupImageService",
  "./core": "createSimpleGroup",
  "./engine": "MarmotGroupEngine",
  "./audit": "noopAuditSink",
  "./extra": "InMemoryKeyValueStore",
  "./extra/audit/node": "NodeJsonlAuditRecorder",
  "./extra/audit/browser": "AutoBrowserAuditWriter",
  "./utils": "normalizeRelayUrl",
};

type PublicSurface = [string, Record<string, unknown>];
const ALL_PUBLIC_SURFACES: PublicSurface[] = PUBLIC_CODE_ENTRIES.map(
  ({ key }) => {
    const namespace = PUBLIC_NAMESPACES[key];
    if (!namespace)
      throw new Error(
        `${key}: missing source namespace; expected ${REPRESENTATIVE_EXPORTS[key] ?? "representative export"}`,
      );
    return [key, namespace];
  },
);
const PUBLIC_SURFACES = ALL_PUBLIC_SURFACES.filter(([key]) => key !== "./mls");

function findPublicSurfaceViolations(surfaces: PublicSurface[]): string[] {
  const violations: string[] = [];
  for (const { key } of PUBLIC_CODE_ENTRIES) {
    const matches = surfaces.filter(([entry]) => entry === key);
    const anchor = REPRESENTATIVE_EXPORTS[key];
    if (matches.length !== 1) {
      violations.push(`${key}: expected one namespace with ${anchor}`);
      continue;
    }
    const namespace = matches[0]![1];
    const expected = PUBLIC_NAMESPACES[key]!;
    if (
      !anchor ||
      !Object.hasOwn(namespace, anchor) ||
      namespace[anchor] !== expected[anchor]
    )
      violations.push(`${key}: expected representative ${anchor}`);
    if (
      Object.keys(namespace).sort().join("|") !==
      Object.keys(expected).sort().join("|")
    )
      violations.push(
        `${key}: unexpected namespace keys; expected representative ${anchor}`,
      );
  }
  for (const [key] of surfaces)
    if (!PUBLIC_CODE_ENTRIES.some((entry) => entry.key === key))
      violations.push(
        `${key}: undeclared code entry; no representative expected`,
      );
  return violations;
}

describe("exports", () => {
  it("matches the owned runtime inventory to manifest code entry order", () => {
    const codeEntries = PUBLIC_CODE_ENTRIES.map(({ key }) => key);
    expect(codeEntries).toEqual([
      ".",
      "./mls",
      "./client",
      "./core",
      "./engine",
      "./audit",
      "./extra",
      "./extra/audit/node",
      "./extra/audit/browser",
      "./utils",
    ]);
    expect(Object.keys(PUBLIC_NAMESPACES)).toEqual(codeEntries);
    expect(PUBLIC_SURFACES.map(([key]) => key)).toEqual(
      codeEntries.filter((key) => key !== "./mls"),
    );
    expect(codeEntries).not.toContain("./package.json");
    expect(findPublicSurfaceViolations(ALL_PUBLIC_SURFACES)).toEqual([]);
  });
  it("rejects missing, added and swapped namespaces with their entry and representative", () => {
    for (const { key } of PUBLIC_CODE_ENTRIES) {
      expect(findPublicSurfaceViolations(ALL_PUBLIC_SURFACES)).toEqual([]);
      const missing = ALL_PUBLIC_SURFACES.filter(([entry]) => entry !== key);
      expect(findPublicSurfaceViolations(missing).join("\n")).toContain(
        `${key}: expected one namespace with ${REPRESENTATIVE_EXPORTS[key]}`,
      );
      const wrong = key === "." ? coreExports : exports;
      const swapped = ALL_PUBLIC_SURFACES.map(
        ([entry, namespace]): PublicSurface => [
          entry,
          entry === key ? wrong : namespace,
        ],
      );
      expect(findPublicSurfaceViolations(swapped).join("\n")).toContain(
        `${key}:`,
      );
      expect(findPublicSurfaceViolations(swapped).join("\n")).toContain(
        `representative ${REPRESENTATIVE_EXPORTS[key]}`,
      );
    }
    expect(
      findPublicSurfaceViolations([
        ...ALL_PUBLIC_SURFACES,
        ["./added", exports],
      ]),
    ).toContain("./added: undeclared code entry; no representative expected");
  });
  it("keeps retention planners, checkpoint codecs, pins, leases and owner bridges private on every entrypoint", async () => {
    const internals = [
      "HistoryRetentionPin",
      "HistoryRetentionOptions",
      "HistoryRetentionPlan",
      "retentionFloor",
      "retainedTopology",
      "projectHistoricalReceivers",
      "encodeCheckpoint",
      "decodeCheckpoint",
      "TreeCheckpoint",
      "RetentionLease",
      "registerSettledRetentionOwner",
      "unregisterSettledRetentionOwner",
      "completeSettledRetentionOwner",
      "registerPublicationRetention",
      "linkPublicationRetention",
      "confirmPublicationRetention",
      "unregisterPublicationRetention",
      "registerPublicationPreparationOwner",
      "unregisterPublicationPreparationOwner",
      "rejectPublicationPreparation",
      "encodeDeliveredEvidence",
      "decodeDeliveredEvidence",
      "DeliveredEvidence",
      "retainSettled",
      "prepareRetention",
      "publishRetention",
      "resumeRetentionCleanup",
      ...PRIVATE_EXPORT_NAMES,
    ];
    for (const [entrypoint, namespace] of ALL_PUBLIC_SURFACES)
      for (const name of internals)
        expect(namespace, `${entrypoint}: ${name}`).not.toHaveProperty(name);
  });
  it("keeps private type-only contracts absent from all ten compiler export surfaces", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const config = ts.readConfigFile(
      `${root}tsconfig.build.json`,
      ts.sys.readFile,
    );
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const program = ts.createProgram(parsed.fileNames, {
      ...parsed.options,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    for (const { key, sourcePath: file } of PUBLIC_CODE_ENTRIES) {
      const source = program.getSourceFile(`${root}${file}`);
      if (!source) throw new Error(`Missing supported source ${file}`);
      const module = checker.getSymbolAtLocation(source);
      if (!module) throw new Error(`Missing supported module ${file}`);
      const symbols = checker.getExportsOfModule(module);
      const publicNames = symbols.map((symbol) => symbol.name);
      expect(
        publicNames,
        `${key}: expected representative ${REPRESENTATIVE_EXPORTS[key]}`,
      ).toContain(REPRESENTATIVE_EXPORTS[key]);
      const runtimeNames = symbols
        .filter((symbol) => {
          if (
            symbol.declarations?.some(
              (declaration) =>
                ts.isExportSpecifier(declaration) &&
                (declaration.isTypeOnly ||
                  (ts.isExportDeclaration(declaration.parent.parent) &&
                    declaration.parent.parent.isTypeOnly)),
            )
          )
            return false;
          const target =
            symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
          return (target.flags & ts.SymbolFlags.Value) !== 0;
        })
        .map((symbol) => symbol.name)
        .sort();
      expect(
        runtimeNames,
        `${key}: compiler target must match source namespace and ${REPRESENTATIVE_EXPORTS[key]}`,
      ).toEqual(Object.keys(PUBLIC_NAMESPACES[key]!).sort());
      for (const name of PRIVATE_EXPORT_NAMES)
        expect(
          publicNames,
          `${file}: private type or value ${name}`,
        ).not.toContain(name);
    }
  }, 30_000);
  it("names every public signature type and preserves the actual conditional aliases", () => {
    expectTypeOf<ClientSignatureTypes>().not.toBeNever();
    expectTypeOf<CoreSignatureTypes>().not.toBeNever();
    expectTypeOf<EngineSignatureTypes>().not.toBeNever();
    expectTypeOf<
      ClientSignatureTypes[6]
    >().toEqualTypeOf<clientExports.ProcessedIngestResult>();
    expectTypeOf<clientExports.GenerateKeyPackageOptions>().toEqualTypeOf<
      NonNullable<Parameters<clientExports.KeyPackagePublisher["generate"]>[0]>
    >();
    expectTypeOf<clientExports.GeneratedKeyPackage>().toEqualTypeOf<
      Awaited<ReturnType<clientExports.KeyPackagePublisher["generate"]>>
    >();
    expectTypeOf<clientExports.PublishKeyPackageOptions>().toEqualTypeOf<
      Parameters<clientExports.KeyPackagePublisher["publish"]>[0]
    >();
    expectTypeOf<exports.GenerateKeyPackageOptions>().toEqualTypeOf<coreExports.GenerateKeyPackageOptions>();
    expectTypeOf<exports.DisbandTombstone>().toEqualTypeOf<engineExports.DisbandTombstone>();
    expectTypeOf<exports.DisbandNotificationState>().toEqualTypeOf<engineExports.DisbandNotificationState>();
    expectTypeOf<exports.DeliveredAppPayload<string>>().toEqualTypeOf<
      engineExports.DeliveredAppPayload<string>
    >();
    expectTypeOf<coreExports.MediaCryptoFields>().toEqualTypeOf<
      Pick<
        coreExports.MediaAttachment,
        "plaintextSha256" | "mediaType" | "filename"
      > & { version?: coreExports.EncryptedMediaVersion }
    >();
    expectTypeOf<coreExports.ConvergenceStatus>().toEqualTypeOf<
      "Syncing" | "Resolving" | "Settled" | "Blocked"
    >();
  });
  it("exposes image helpers and service through their intended entries", () => {
    const coreNames = [
      "canonicalizeGroupImageMediaType",
      "encodeGroupBlossomImage",
      "decodeGroupBlossomImage",
      "buildGroupImageAad",
      "encryptGroupImage",
      "decryptGroupImage",
      "getGroupImageSource",
      "getGroupImageSnapshotIdentity",
      "GroupImageIntegrityError",
    ];
    for (const name of coreNames) {
      expect(coreExports).toHaveProperty(name);
      expect(exports[name as keyof typeof exports]).toBe(
        coreExports[name as keyof typeof coreExports],
      );
    }
    for (const name of [
      "GroupImageService",
      "fetchGroupImageTransport",
    ] as const) {
      expect(clientExports).toHaveProperty(name);
      expect(exports[name]).toBe(clientExports[name]);
      expect(coreExports).not.toHaveProperty(name);
    }
  });
  it("exposes the shared Marmot credential policy through root and core", () => {
    expect(coreExports).toHaveProperty("marmotAuthService");
    expect(exports).toHaveProperty("marmotAuthService");
    expect(exports.marmotAuthService).toBe(coreExports.marmotAuthService);
  });

  it("validates basic identity shape and curve without binding the signature key", async () => {
    const service = coreExports.marmotAuthService;
    expect(service).toBeDefined();
    const credential = coreExports.createCredential(
      "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    );
    await expect(
      service.validateCredential(credential, new Uint8Array()),
    ).resolves.toBe(true);
    await expect(
      service.validateCredential(credential, new Uint8Array(32)),
    ).resolves.toBe(true);
    for (const identity of [
      new Uint8Array(31),
      new Uint8Array(33),
      new Uint8Array(32).fill(0xbb),
    ]) {
      await expect(
        service.validateCredential(
          { ...credential, identity },
          new Uint8Array(),
        ),
      ).resolves.toBe(false);
    }
    await expect(
      service.validateCredential(
        { credentialType: defaultCredentialTypes.x509, certificates: [] },
        new Uint8Array(),
      ),
    ).resolves.toBe(false);
  });

  it("should name every root public-signature symbol from the root", () => {
    expectTypeOf<RootSignatureTypes>().not.toBeNever();
    expectTypeOf(GroupHistoryTree).toBeConstructibleWith();
    expectTypeOf(groupWithdrawnNotificationsByCommit).toBeFunction();
  });

  it("exports the complete group image root surface", () => {
    expect(Object.keys(exports).sort()).toMatchInlineSnapshot(`
      [
        "ACCOUNT_IDENTITY_PROOF_COMPONENT",
        "ACCOUNT_IDENTITY_PROOF_COMPONENT_ID",
        "ADDRESSABLE_KEY_PACKAGE_KIND",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT_ID",
        "AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES",
        "AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_ROLE_FANOUT",
        "AGENT_TEXT_STREAM_ROLE_RECEIVE",
        "AGENT_TEXT_STREAM_ROLE_SEND",
        "APP_COMPONENTS_COMPONENT_ID",
        "AUTHORIZATION_PROOF_LENGTH",
        "AUTHORIZATION_PROOF_MAX_CREATED_AT",
        "AccountIdentityProofError",
        "AuthorizationProofError",
        "BLOSSOM_LOCATOR_KIND",
        "BLOSSOM_LOCATOR_KIND_V1",
        "BinaryDecodeError",
        "BinaryReader",
        "BinaryWriter",
        "BoundedIdCache",
        "DEFAULT_CONVERGENCE_POLICY",
        "DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS",
        "DEFAULT_GROUP_COMPONENT_IDS",
        "ENCRYPTED_MEDIA_FORMAT_V1",
        "ENCRYPTED_MEDIA_FORMAT_V2",
        "ENCRYPTED_MEDIA_VERSION",
        "ENCRYPTED_MEDIA_VERSION_V1",
        "ENCRYPTED_MEDIA_VERSION_V2",
        "GIFT_WRAP_KIND",
        "GROUP_ADMIN_POLICY_COMPONENT",
        "GROUP_ADMIN_POLICY_COMPONENT_ID",
        "GROUP_AVATAR_URL_COMPONENT",
        "GROUP_AVATAR_URL_COMPONENT_ID",
        "GROUP_BLOSSOM_IMAGE_COMPONENT",
        "GROUP_BLOSSOM_IMAGE_COMPONENT_ID",
        "GROUP_DESCRIPTION_MAX_BYTES",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT_ID",
        "GROUP_ENCRYPTED_MEDIA_V1_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID",
        "GROUP_ENCRYPTED_MEDIA_V2_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID",
        "GROUP_EVENT_KIND",
        "GROUP_LIFECYCLE_COMPONENT",
        "GROUP_LIFECYCLE_COMPONENT_ID",
        "GROUP_MESSAGE_RETENTION_COMPONENT",
        "GROUP_MESSAGE_RETENTION_COMPONENT_ID",
        "GROUP_NAME_MAX_BYTES",
        "GROUP_PROFILE_COMPONENT",
        "GROUP_PROFILE_COMPONENT_ID",
        "GroupHistoryTree",
        "GroupImageIntegrityError",
        "GroupImageService",
        "GroupMediaService",
        "GroupMediaStore",
        "GroupRumorHistory",
        "GroupRuntime",
        "GroupSession",
        "GroupTerminalError",
        "GroupsManager",
        "INBOX_RELAY_LIST_KIND",
        "INBOX_RELAY_TAG",
        "InvalidGroupContextExtensionError",
        "InviteManager",
        "KEY_PACKAGE_APP_COMPONENTS_TAG",
        "KEY_PACKAGE_CIPHER_SUITE_TAG",
        "KEY_PACKAGE_CLIENT_TAG",
        "KEY_PACKAGE_EXTENSIONS_TAG",
        "KEY_PACKAGE_MLS_VERSION_TAG",
        "KEY_PACKAGE_PROPOSALS_TAG",
        "KEY_PACKAGE_RELAYS_TAG",
        "KeyPackageManager",
        "KeyPackageNotFoundError",
        "KeyPackagePublisher",
        "KeyPackageRotatePreconditionError",
        "KeyPackageStore",
        "LAST_RESORT_EXTENSION_TYPE",
        "MAX_VARINT",
        "MarmotClient",
        "MarmotGroup",
        "MarmotGroupEngine",
        "MediaAttachmentRejection",
        "MissingRelayError",
        "MissingSlotIdentifierError",
        "NIP65_RELAY_LIST_KIND",
        "NIP65_RELAY_TAG",
        "NOSTR_GROUP_ID_TAG",
        "NOSTR_ROUTING_COMPONENT",
        "NOSTR_ROUTING_COMPONENT_ID",
        "NOSTR_ROUTING_MAX_RELAYS",
        "NoGroupRelaysError",
        "NoMarmotGroupDataError",
        "NostrWelcomeDelivery",
        "Proposals",
        "SAFE_AAD_COMPONENT_ID",
        "SUPPORTED_APP_COMPONENT_IDS",
        "SUPPORTED_LOCATOR_KINDS",
        "WELCOME_EVENT_KIND",
        "accountIdentityProofTemplate",
        "adminPolicyEntry",
        "agentTextStreamEntry",
        "appComponentsEntry",
        "assertCurrentGroupAccountIdentityProofProfile",
        "assertNoAccountIdentityProofComponent",
        "authorizationProofEventId",
        "blossomContentHashFromUrl",
        "buildAppDataDictionary",
        "buildAuthorizationProofEvent",
        "buildBlossomBlobUrl",
        "buildBlossomUploadUrl",
        "buildFallbackFetchUrls",
        "buildForkTreeView",
        "buildGroupImageAad",
        "calculateKeyPackageRef",
        "canTransitionLifecycle",
        "canonicalizeGroupImageMediaType",
        "canonicalizeMimeType",
        "canonicalizeMimeTypeV2",
        "checkKeyPackageProposalsTag",
        "classifyChangedLeaf",
        "classifyDisbandCommit",
        "classifyGroupAccountIdentityProofProfile",
        "classifyLateCommit",
        "collectAppDataUpdateOps",
        "commitDigest",
        "commitOrderingPriority",
        "compareBranchScores",
        "compareCommitOrderingKeys",
        "componentEntry",
        "convergenceOutcomeToCategory",
        "createAdminCommitPolicyCallback",
        "createApplicationMessageIntent",
        "createBlossomUploadAuthorization",
        "createChatRumor",
        "createCredential",
        "createDefaultKeyPackageLifetime",
        "createDeleteKeyPackageEvent",
        "createEncryptedGroupEventContent",
        "createEncryptedMediaPolicyV2",
        "createGiftWrap",
        "createGroup",
        "createGroupEvent",
        "createInboxRelayListEvent",
        "createInviteIntent",
        "createKeyPackageEvent",
        "createNip65RelayListEvent",
        "createSimpleGroup",
        "createThreeMonthLifetime",
        "createWelcomeRumor",
        "decideCommitAuthorization",
        "decodeAdminPolicyV1",
        "decodeAgentTextStreamQuicPolicyV1",
        "decodeAuthorizationProof",
        "decodeComponentsList",
        "decodeContent",
        "decodeEncryptedMediaPolicyV1",
        "decodeEncryptedMediaPolicyV2",
        "decodeGroupAvatarUrlV1",
        "decodeGroupBlossomImage",
        "decodeGroupLifecycleV1",
        "decodeGroupProfileV1",
        "decodeMessageRetentionV1",
        "decodeNostrRoutingV1",
        "decodeUtf8",
        "decodeVarint",
        "decryptGroupImage",
        "decryptGroupMessage",
        "decryptGroupMessageEvent",
        "decryptGroupMessages",
        "decryptMediaFile",
        "decryptMediaFileWithKeys",
        "defaultCapabilities",
        "defaultMarmotClientConfig",
        "deferredReasons",
        "deriveMediaEncryptionKey",
        "deriveMediaFileKeyFromSecret",
        "deserializeApplicationData",
        "deserializeApplicationRumor",
        "deserializeClientState",
        "detectEncoding",
        "diffChangedLeaves",
        "disposition",
        "encodeAdminPolicyV1",
        "encodeAgentTextStreamQuicPolicyV1",
        "encodeAuthorizationProof",
        "encodeComponentsList",
        "encodeContent",
        "encodeEncryptedMediaPolicyV1",
        "encodeEncryptedMediaPolicyV2",
        "encodeGroupAvatarUrlV1",
        "encodeGroupBlossomImage",
        "encodeGroupLifecycleV1",
        "encodeGroupProfileV1",
        "encodeMediaImetaTag",
        "encodeMessageRetentionV1",
        "encodeNostrRoutingV1",
        "encodeUtf8",
        "encodeVarint",
        "encryptGroupImage",
        "encryptMediaFile",
        "encryptedMediaBlossomDefault",
        "encryptedMediaEntry",
        "encryptedMediaV2BlossomDefault",
        "encryptedMediaV2Entry",
        "ensureLastResortExtension",
        "ensureMarmotCapabilities",
        "evaluateKeyPackageForGroup",
        "exportMediaSecret",
        "extendedExtensionTypes",
        "fetchBlossomBlob",
        "fetchGroupImageTransport",
        "formatMlsTimestamp",
        "generateKeyPackage",
        "getAdminPolicy",
        "getAgentTextStreamPolicy",
        "getAppComponents",
        "getComponentData",
        "getCredentialLeafNodeIndexes",
        "getCredentialPubkey",
        "getEncodingTag",
        "getEncryptedMediaPolicy",
        "getEncryptedMediaPolicyV2",
        "getEpoch",
        "getGroupAvatarUrl",
        "getGroupIdHex",
        "getGroupImageSnapshotIdentity",
        "getGroupImageSource",
        "getGroupLifecycle",
        "getGroupMediaPolicy",
        "getGroupMemberPubkeys",
        "getGroupMembers",
        "getGroupProfile",
        "getGroupProfileSupport",
        "getInboxRelays",
        "getKeyPackage",
        "getKeyPackageCipherSuiteId",
        "getKeyPackageClient",
        "getKeyPackageExtensions",
        "getKeyPackageIdentifier",
        "getKeyPackageLifetime",
        "getKeyPackageMLSVersion",
        "getKeyPackageNostrPubkey",
        "getKeyPackageReference",
        "getKeyPackageRelays",
        "getMarmotGroupInfo",
        "getMarmotGroupView",
        "getMediaAttachmentOutcomes",
        "getMediaAttachments",
        "getMemberCount",
        "getMessageRetention",
        "getNip65Relays",
        "getNostrGroupIdHex",
        "getNostrRouting",
        "getPubkeyLeafNodeIndexes",
        "getPubkeyLeafNodes",
        "getTagValue",
        "getWelcome",
        "getWelcomeGroupRelays",
        "getWelcomeKeyPackageEventId",
        "getWelcomeKeyPackageRefs",
        "groupAvatarUrlEntry",
        "groupLifecycleEntry",
        "groupLifecycleStates",
        "groupProfileEntry",
        "groupProtocolLifecycleValues",
        "groupWithdrawnNotificationsByCommit",
        "hasAccountIdentityProofMaterial",
        "hasAck",
        "ingestResultDisposition",
        "inputCategories",
        "isAppPayloadExpired",
        "isApplicationMessage",
        "isBranchEligible",
        "isCommitMessage",
        "isHexKey",
        "isLastResortExtension",
        "isLifetimeCurrentWithGrace",
        "isLifetimeValid",
        "isLifetimeWithinCap",
        "isProposalMessage",
        "isReusableKeyPackage",
        "isSafeBlossomFetchUrl",
        "isSameCredential",
        "isValidAccountIdentity",
        "isValidInboxRelayListEvent",
        "isValidNip65RelayListEvent",
        "isValidRelayUrl",
        "isWitnessEligible",
        "keyPackageDefaultExtensions",
        "makeAppComponentsExtension",
        "makeLeafAppComponentsExtension",
        "marmotAuthService",
        "marmotRequiredCapabilitiesExtension",
        "mayApplyRetainedInbound",
        "mayPrepareLocalCommit",
        "mayRunForkDetection",
        "messageRetentionEntry",
        "missingGroupRequirements",
        "mlsSignatureSchemeForCiphersuite",
        "normalizeConvergencePolicy",
        "normalizeRelayUrl",
        "nostrRoutingEntry",
        "nostrTransportBinding",
        "parseEncryptedMediaVersion",
        "parseMediaAttachment",
        "parseMediaImetaTag",
        "produceAccountIdentityProof",
        "produceAuthorizationProof",
        "prunableRetainedEpochs",
        "readWelcomeGroupInfo",
        "readWelcomeMarmotGroupView",
        "rejectUnsafeGroupAvatarContactUrl",
        "replaceExtension",
        "requiredRetainedEpochs",
        "resolveMediaFetchUrls",
        "scoreBranch",
        "selectCanonicalBranch",
        "selectFairQueuedStateIntent",
        "selectFetchableLocators",
        "selectGroupMediaVersion",
        "serializeApplicationRumor",
        "serializeClientState",
        "sortGroupCommits",
        "transitionLifecycle",
        "unixNow",
        "uploadBlossomBlob",
        "uploadBlossomBlobWithFallback",
        "validateAddProposalAccountIdentityProofs",
        "validateAdminLeafCoupling",
        "validateAndNormalizeBlobEndpointUrlV2",
        "validateAppComponentIntegrity",
        "validateCommitAccountIdentityProofs",
        "validateCommitLegality",
        "validateConvergencePolicy",
        "validateGroupMemberAccountIdentityProofs",
        "validateKeyPackageAccountIdentityProof",
        "validateKeyPackageSlot",
        "validateLeafAccountIdentityProof",
        "validateResultingProfileInvariants",
        "validateUpdateProposalAccountIdentityProofs",
        "validateWelcomeGroup",
        "varintSize",
        "verifyApplicationRumorAuthorship",
        "verifyAuthorizationProof",
      ]
    `);
  });
});

describe("./client exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(clientExports).sort()).toMatchInlineSnapshot(`
      [
        "BoundedIdCache",
        "GroupImageService",
        "GroupMediaService",
        "GroupMediaStore",
        "GroupRumorHistory",
        "GroupRuntime",
        "GroupSession",
        "GroupTerminalError",
        "GroupsManager",
        "InviteManager",
        "KeyPackageManager",
        "KeyPackageNotFoundError",
        "KeyPackagePublisher",
        "KeyPackageRotatePreconditionError",
        "KeyPackageStore",
        "MarmotClient",
        "MarmotGroup",
        "MissingRelayError",
        "MissingSlotIdentifierError",
        "NoGroupRelaysError",
        "NoMarmotGroupDataError",
        "NostrWelcomeDelivery",
        "Proposals",
        "buildForkTreeView",
        "createAdminCommitPolicyCallback",
        "createApplicationMessageIntent",
        "createBlossomUploadAuthorization",
        "createChatRumor",
        "createInviteIntent",
        "fetchBlossomBlob",
        "fetchGroupImageTransport",
        "getGroupMediaPolicy",
        "ingestResultDisposition",
        "selectFairQueuedStateIntent",
        "selectGroupMediaVersion",
        "uploadBlossomBlob",
        "uploadBlossomBlobWithFallback",
      ]
    `);
  });
});

describe("./core exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(coreExports).sort()).toMatchInlineSnapshot(`
      [
        "ACCOUNT_IDENTITY_PROOF_COMPONENT",
        "ACCOUNT_IDENTITY_PROOF_COMPONENT_ID",
        "ADDRESSABLE_KEY_PACKAGE_KIND",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT_ID",
        "AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES",
        "AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_ROLE_FANOUT",
        "AGENT_TEXT_STREAM_ROLE_RECEIVE",
        "AGENT_TEXT_STREAM_ROLE_SEND",
        "APP_COMPONENTS_COMPONENT_ID",
        "AUTHORIZATION_PROOF_LENGTH",
        "AUTHORIZATION_PROOF_MAX_CREATED_AT",
        "AccountIdentityProofError",
        "AuthorizationProofError",
        "BLOSSOM_LOCATOR_KIND",
        "BLOSSOM_LOCATOR_KIND_V1",
        "BinaryDecodeError",
        "BinaryReader",
        "BinaryWriter",
        "DEFAULT_CONVERGENCE_POLICY",
        "DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS",
        "DEFAULT_GROUP_COMPONENT_IDS",
        "ENCRYPTED_MEDIA_FORMAT_V1",
        "ENCRYPTED_MEDIA_FORMAT_V2",
        "ENCRYPTED_MEDIA_VERSION",
        "ENCRYPTED_MEDIA_VERSION_V1",
        "ENCRYPTED_MEDIA_VERSION_V2",
        "GIFT_WRAP_KIND",
        "GROUP_ADMIN_POLICY_COMPONENT",
        "GROUP_ADMIN_POLICY_COMPONENT_ID",
        "GROUP_AVATAR_URL_COMPONENT",
        "GROUP_AVATAR_URL_COMPONENT_ID",
        "GROUP_BLOSSOM_IMAGE_COMPONENT",
        "GROUP_BLOSSOM_IMAGE_COMPONENT_ID",
        "GROUP_DESCRIPTION_MAX_BYTES",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT_ID",
        "GROUP_ENCRYPTED_MEDIA_V1_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_V1_COMPONENT_ID",
        "GROUP_ENCRYPTED_MEDIA_V2_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID",
        "GROUP_EVENT_KIND",
        "GROUP_LIFECYCLE_COMPONENT",
        "GROUP_LIFECYCLE_COMPONENT_ID",
        "GROUP_MESSAGE_RETENTION_COMPONENT",
        "GROUP_MESSAGE_RETENTION_COMPONENT_ID",
        "GROUP_NAME_MAX_BYTES",
        "GROUP_PROFILE_COMPONENT",
        "GROUP_PROFILE_COMPONENT_ID",
        "GroupImageIntegrityError",
        "INBOX_RELAY_LIST_KIND",
        "INBOX_RELAY_TAG",
        "InvalidGroupContextExtensionError",
        "KEY_PACKAGE_APP_COMPONENTS_TAG",
        "KEY_PACKAGE_CIPHER_SUITE_TAG",
        "KEY_PACKAGE_CLIENT_TAG",
        "KEY_PACKAGE_EXTENSIONS_TAG",
        "KEY_PACKAGE_MLS_VERSION_TAG",
        "KEY_PACKAGE_PROPOSALS_TAG",
        "KEY_PACKAGE_RELAYS_TAG",
        "LAST_RESORT_EXTENSION_TYPE",
        "MAX_VARINT",
        "MediaAttachmentRejection",
        "NIP65_RELAY_LIST_KIND",
        "NIP65_RELAY_TAG",
        "NOSTR_GROUP_ID_TAG",
        "NOSTR_ROUTING_COMPONENT",
        "NOSTR_ROUTING_COMPONENT_ID",
        "NOSTR_ROUTING_MAX_RELAYS",
        "SAFE_AAD_COMPONENT_ID",
        "SUPPORTED_APP_COMPONENT_IDS",
        "SUPPORTED_LOCATOR_KINDS",
        "WELCOME_EVENT_KIND",
        "accountIdentityProofTemplate",
        "adminPolicyEntry",
        "agentTextStreamEntry",
        "appComponentsEntry",
        "assertCurrentGroupAccountIdentityProofProfile",
        "assertNoAccountIdentityProofComponent",
        "authorizationProofEventId",
        "blossomContentHashFromUrl",
        "buildAppDataDictionary",
        "buildAuthorizationProofEvent",
        "buildBlossomBlobUrl",
        "buildBlossomUploadUrl",
        "buildFallbackFetchUrls",
        "buildGroupImageAad",
        "calculateKeyPackageRef",
        "canTransitionLifecycle",
        "canonicalizeGroupImageMediaType",
        "canonicalizeMimeType",
        "canonicalizeMimeTypeV2",
        "checkKeyPackageProposalsTag",
        "classifyChangedLeaf",
        "classifyDisbandCommit",
        "classifyGroupAccountIdentityProofProfile",
        "classifyLateCommit",
        "collectAppDataUpdateOps",
        "commitDigest",
        "commitOrderingPriority",
        "compareBranchScores",
        "compareCommitOrderingKeys",
        "componentEntry",
        "convergenceOutcomeToCategory",
        "createCredential",
        "createDeleteKeyPackageEvent",
        "createEncryptedGroupEventContent",
        "createEncryptedMediaPolicyV2",
        "createGroup",
        "createGroupEvent",
        "createInboxRelayListEvent",
        "createKeyPackageEvent",
        "createNip65RelayListEvent",
        "createSimpleGroup",
        "createWelcomeRumor",
        "decideCommitAuthorization",
        "decodeAdminPolicyV1",
        "decodeAgentTextStreamQuicPolicyV1",
        "decodeAuthorizationProof",
        "decodeComponentsList",
        "decodeEncryptedMediaPolicyV1",
        "decodeEncryptedMediaPolicyV2",
        "decodeGroupAvatarUrlV1",
        "decodeGroupBlossomImage",
        "decodeGroupLifecycleV1",
        "decodeGroupProfileV1",
        "decodeMessageRetentionV1",
        "decodeNostrRoutingV1",
        "decodeUtf8",
        "decodeVarint",
        "decryptGroupImage",
        "decryptGroupMessage",
        "decryptGroupMessageEvent",
        "decryptGroupMessages",
        "decryptMediaFile",
        "decryptMediaFileWithKeys",
        "defaultCapabilities",
        "defaultMarmotClientConfig",
        "deferredReasons",
        "deriveMediaEncryptionKey",
        "deriveMediaFileKeyFromSecret",
        "deserializeApplicationData",
        "deserializeApplicationRumor",
        "deserializeClientState",
        "diffChangedLeaves",
        "disposition",
        "encodeAdminPolicyV1",
        "encodeAgentTextStreamQuicPolicyV1",
        "encodeAuthorizationProof",
        "encodeComponentsList",
        "encodeEncryptedMediaPolicyV1",
        "encodeEncryptedMediaPolicyV2",
        "encodeGroupAvatarUrlV1",
        "encodeGroupBlossomImage",
        "encodeGroupLifecycleV1",
        "encodeGroupProfileV1",
        "encodeMediaImetaTag",
        "encodeMessageRetentionV1",
        "encodeNostrRoutingV1",
        "encodeUtf8",
        "encodeVarint",
        "encryptGroupImage",
        "encryptMediaFile",
        "encryptedMediaBlossomDefault",
        "encryptedMediaEntry",
        "encryptedMediaV2BlossomDefault",
        "encryptedMediaV2Entry",
        "ensureLastResortExtension",
        "ensureMarmotCapabilities",
        "evaluateKeyPackageForGroup",
        "exportMediaSecret",
        "extendedExtensionTypes",
        "generateKeyPackage",
        "getAdminPolicy",
        "getAgentTextStreamPolicy",
        "getAppComponents",
        "getComponentData",
        "getCredentialLeafNodeIndexes",
        "getCredentialPubkey",
        "getEncryptedMediaPolicy",
        "getEncryptedMediaPolicyV2",
        "getEpoch",
        "getGroupAvatarUrl",
        "getGroupIdHex",
        "getGroupImageSnapshotIdentity",
        "getGroupImageSource",
        "getGroupLifecycle",
        "getGroupMemberPubkeys",
        "getGroupMembers",
        "getGroupProfile",
        "getGroupProfileSupport",
        "getInboxRelays",
        "getKeyPackage",
        "getKeyPackageCipherSuiteId",
        "getKeyPackageClient",
        "getKeyPackageExtensions",
        "getKeyPackageIdentifier",
        "getKeyPackageLifetime",
        "getKeyPackageMLSVersion",
        "getKeyPackageNostrPubkey",
        "getKeyPackageReference",
        "getKeyPackageRelays",
        "getMarmotGroupInfo",
        "getMarmotGroupView",
        "getMediaAttachmentOutcomes",
        "getMediaAttachments",
        "getMemberCount",
        "getMessageRetention",
        "getNip65Relays",
        "getNostrGroupIdHex",
        "getNostrRouting",
        "getPubkeyLeafNodeIndexes",
        "getPubkeyLeafNodes",
        "getWelcome",
        "getWelcomeGroupRelays",
        "getWelcomeKeyPackageEventId",
        "getWelcomeKeyPackageRefs",
        "groupAvatarUrlEntry",
        "groupLifecycleEntry",
        "groupLifecycleStates",
        "groupProfileEntry",
        "groupProtocolLifecycleValues",
        "hasAccountIdentityProofMaterial",
        "inputCategories",
        "isAppPayloadExpired",
        "isApplicationMessage",
        "isBranchEligible",
        "isCommitMessage",
        "isHexKey",
        "isLastResortExtension",
        "isProposalMessage",
        "isReusableKeyPackage",
        "isSafeBlossomFetchUrl",
        "isSameCredential",
        "isValidAccountIdentity",
        "isValidInboxRelayListEvent",
        "isValidNip65RelayListEvent",
        "isWitnessEligible",
        "keyPackageDefaultExtensions",
        "makeAppComponentsExtension",
        "makeLeafAppComponentsExtension",
        "marmotAuthService",
        "marmotRequiredCapabilitiesExtension",
        "mayApplyRetainedInbound",
        "mayPrepareLocalCommit",
        "mayRunForkDetection",
        "messageRetentionEntry",
        "missingGroupRequirements",
        "mlsSignatureSchemeForCiphersuite",
        "normalizeConvergencePolicy",
        "nostrRoutingEntry",
        "nostrTransportBinding",
        "parseEncryptedMediaVersion",
        "parseMediaAttachment",
        "parseMediaImetaTag",
        "produceAccountIdentityProof",
        "produceAuthorizationProof",
        "prunableRetainedEpochs",
        "readWelcomeGroupInfo",
        "readWelcomeMarmotGroupView",
        "rejectUnsafeGroupAvatarContactUrl",
        "replaceExtension",
        "requiredRetainedEpochs",
        "resolveMediaFetchUrls",
        "scoreBranch",
        "selectCanonicalBranch",
        "selectFetchableLocators",
        "serializeApplicationRumor",
        "serializeClientState",
        "sortGroupCommits",
        "transitionLifecycle",
        "validateAddProposalAccountIdentityProofs",
        "validateAdminLeafCoupling",
        "validateAndNormalizeBlobEndpointUrlV2",
        "validateAppComponentIntegrity",
        "validateCommitAccountIdentityProofs",
        "validateCommitLegality",
        "validateConvergencePolicy",
        "validateGroupMemberAccountIdentityProofs",
        "validateKeyPackageAccountIdentityProof",
        "validateKeyPackageSlot",
        "validateLeafAccountIdentityProof",
        "validateResultingProfileInvariants",
        "validateUpdateProposalAccountIdentityProofs",
        "validateWelcomeGroup",
        "varintSize",
        "verifyApplicationRumorAuthorship",
        "verifyAuthorizationProof",
      ]
    `);
  });
});

describe("./engine exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(engineExports).sort()).toMatchInlineSnapshot(`
      [
        "AdminDepletionError",
        "CommitLegalityError",
        "DisbandingError",
        "ForkRecovery",
        "GroupHistoryTree",
        "IngestionPool",
        "MarmotGroupEngine",
        "ProposalAuthorizationError",
        "RetainedHistoryStore",
        "StateNotificationLedger",
        "UnsupportedGroupProfileError",
        "collectWitnessesAt",
        "createAdminCommitPolicyCallback",
        "decodeDisbandConvergence",
        "decodeDisbandRequest",
        "decodeOwnCommitRecord",
        "deriveStateNotifications",
        "disbandConvergenceKey",
        "disbandRequestKey",
        "encodeDisbandConvergence",
        "encodeDisbandRequest",
        "encodeOwnCommitRecord",
        "groupWithdrawnNotificationsByCommit",
        "ingestEnvelopes",
        "ingestResultDisposition",
        "isAuthenticApplicationMessage",
        "openConvergencePass",
        "ownCommitRecordIdentity",
        "refreshConvergencePass",
        "requiredComponentIdsOf",
        "resolveCandidateParent",
        "validatePreApplyProposals",
        "withCapturedProposals",
      ]
    `);
  });
});

describe("./extra exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraExports).sort()).toMatchInlineSnapshot(`
      [
        "EncryptedKeyValueStore",
        "InMemoryKeyValueStore",
        "KeyValueRumorHistoryBackend",
        "makeKeyValueRumorHistoryFactory",
      ]
    `);
  });
});

describe("./utils exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(utilsExports).sort()).toMatchInlineSnapshot(`
      [
        "createDefaultKeyPackageLifetime",
        "createGiftWrap",
        "createThreeMonthLifetime",
        "decodeContent",
        "detectEncoding",
        "encodeContent",
        "formatMlsTimestamp",
        "getEncodingTag",
        "getTagValue",
        "hasAck",
        "isLifetimeCurrentWithGrace",
        "isLifetimeValid",
        "isLifetimeWithinCap",
        "isValidRelayUrl",
        "normalizeRelayUrl",
        "unixNow",
      ]
    `);
  });
});

describe("./audit exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(auditExports).sort()).toMatchInlineSnapshot(`
      [
        "AuditEmitter",
        "JsonlAuditRecorder",
        "MARMOT_AUDIT_SCHEMA_VERSION",
        "MemoryAuditSink",
        "NoopAuditSink",
        "SafeAuditSink",
        "auditEpochStateName",
        "auditNowMs",
        "createAuditEmitter",
        "createAuditEvent",
        "deriveAccountRef",
        "deriveEngineId",
        "deriveMemberRef",
        "digestBytes",
        "digestString",
        "errorDetail",
        "mergeAuditContexts",
        "messageArtifactKindFromNostrKind",
        "noopAuditSink",
        "safeAuditSink",
        "toAuditBytes",
      ]
    `);
  });
});

describe("./extra/audit/node exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraAuditNodeExports).sort()).toMatchInlineSnapshot(`
      [
        "NodeJsonlAuditRecorder",
        "NodeJsonlAuditWriter",
        "uploadAuditLogFile",
      ]
    `);
  });
});

describe("./extra/audit/browser exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraAuditBrowserExports).sort()).toMatchInlineSnapshot(`
      [
        "AutoBrowserAuditWriter",
        "IndexedDbAuditWriter",
        "OpfsAuditWriter",
      ]
    `);
  });
});

describe("legacy 0xf2f1 account-identity-proof export guard (D-02)", () => {
  it.each([
    "encodeAccountIdentityProof",
    "accountidentityproofevent",
    "accountIdentityProofExtensionExtra",
    "legacy_account_identity_proof_hidden",
    "account_identity_proof_event_kind",
  ])(
    "flags nested data-property name %s on plain objects and function statics",
    (name) => {
      const current = {
        accountIdentityProofTemplate: "current",
        AccountIdentityProofError: class extends Error {},
      };
      expect(findLegacyExportViolations({ nested: current })).toEqual([]);
      expect(
        findLegacyExportViolations({ nested: { [name]: "inert" } }).some(
          (violation) => violation.startsWith(`nested.${name}:`),
        ),
      ).toBe(true);
      const Holder = Object.assign(
        () => {
          throw new Error("factory must not execute");
        },
        { [name]: "inert" },
      );
      expect(
        findLegacyExportViolations({ Holder }).some((violation) =>
          violation.startsWith(`Holder.${name}:`),
        ),
      ).toBe(true);
      const hidden: Record<string, unknown> = {};
      Object.defineProperty(hidden, name, {
        value: "inert",
        enumerable: false,
      });
      expect(
        findLegacyExportViolations({ hidden }).some((violation) =>
          violation.startsWith(`hidden.${name}:`),
        ),
      ).toBe(true);
    },
  );

  it.each([0xf2f1, BigInt(0xf2f1), "0xF2F1", "0XF2f1"])(
    "flags legacy atom %s across every supported container after clean controls",
    (atom) => {
      function containers(value: unknown): Record<string, unknown>[] {
        class Holder {
          static TYPE = value;
        }
        return [
          { value },
          { array: [value] },
          { set: new Set([value]) },
          { map: new Map([["current", value]]) },
          { key: new Map([[value, "current"]]) },
          { Holder },
        ];
      }
      for (const clean of containers(0x8009))
        expect(findLegacyExportViolations(clean)).toEqual([]);
      for (const poison of containers(atom))
        expect(
          findLegacyExportViolations(poison).some((violation) =>
            violation.includes("legacy 0xf2f1 extension type"),
          ),
        ).toBe(true);
    },
  );

  it("does not execute getters, factories, class instances or custom container iterators", () => {
    let calls = 0;
    function forbidden(): never {
      calls++;
      throw new Error("inspection executed code");
    }
    const namespace: Record<string, unknown> = { factory: forbidden };
    const plain: Record<string, unknown> = {};
    Object.defineProperty(plain, "getter", {
      get: forbidden,
      enumerable: true,
    });
    Object.defineProperty(namespace, "getter", {
      get: forbidden,
      enumerable: true,
    });
    const array: unknown[] = [0x8009];
    Object.defineProperty(array, "1", { get: forbidden, enumerable: true });
    Object.defineProperty(array, "forEach", { get: forbidden });
    const set = new Set([0x8009]);
    const map = new Map<unknown, unknown>([[{ toString: forbidden }, 0x8009]]);
    Object.defineProperty(set, Symbol.iterator, { get: forbidden });
    Object.defineProperty(map, Symbol.iterator, { get: forbidden });
    class Instance {
      hidden = 0xf2f1;
      get getter(): never {
        return forbidden();
      }
    }
    class DerivedSet extends Set<unknown> {
      override [Symbol.iterator](): SetIterator<unknown> {
        return forbidden();
      }
    }
    class DerivedMap extends Map<unknown, unknown> {
      override [Symbol.iterator](): MapIterator<[unknown, unknown]> {
        return forbidden();
      }
    }
    class DerivedArray extends Array<unknown> {
      get getter(): never {
        return forbidden();
      }
    }
    class Holder {
      static get getter(): never {
        return forbidden();
      }
      hidden = 0xf2f1;
    }
    Object.defineProperty(Holder.prototype, "encodeAccountIdentityProof", {
      value: 0xf2f1,
    });
    expect(
      findLegacyExportViolations({
        factory: forbidden,
        plain,
        array,
        set,
        map,
        instance: new Instance(),
        derivedSet: new DerivedSet([0xf2f1]),
        derivedMap: new DerivedMap([[0xf2f1, 0xf2f1]]),
        derivedArray: new DerivedArray(0xf2f1),
        Holder,
      }),
    ).toEqual([]);
    expect(findLegacyExportViolations(namespace)).toEqual([]);
    expect(calls).toBe(0);
  });

  it.each(["deep-first", "shallow-first"] as const)(
    "detects a shared legacy atom within depth regardless of %s alias order",
    (order) => {
      const shared = { legacy: 0xf2f1 };
      const deep = { a: { b: { c: { d: shared } } } };
      const namespace =
        order === "deep-first"
          ? { deep, shallow: shared }
          : { shallow: shared, deep };

      expect(findLegacyExportViolations(namespace)).toEqual([
        "shallow.legacy: equals the legacy 0xf2f1 extension type",
      ]);
    },
  );

  it("skips a shared legacy atom reached only beyond the depth cap", () => {
    const shared = { legacy: 0xf2f1 };
    const deep = { a: { b: { c: { d: shared } } } };

    expect(findLegacyExportViolations({ deep, alias: deep })).toEqual([]);
  });

  it("terminates cyclic shared aliases while rescanning a shallower path", () => {
    const shared: Record<string, unknown> = { current: 0x8009 };
    const partner = { back: shared };
    shared.self = shared;
    shared.partner = partner;
    const deep = { a: { b: { c: { d: shared } } } };

    expect(findLegacyExportViolations({ deep, shallow: shared })).toEqual([]);
    shared.legacy = 0xf2f1;
    expect(findLegacyExportViolations({ deep, shallow: shared })).toEqual([
      "shallow.legacy: equals the legacy 0xf2f1 extension type",
    ]);
  });

  it("bounds cycles and depth and permits unrelated inert atoms", () => {
    const cycle: Record<string, unknown> = {
      current: 0x8009,
      unrelated: "0xf2f10",
    };
    cycle.self = cycle;
    expect(findLegacyExportViolations({ cycle })).toEqual([]);
    cycle.legacy = 0xf2f1;
    expect(
      findLegacyExportViolations({ cycle }).some((violation) =>
        violation.includes("cycle.legacy"),
      ),
    ).toBe(true);
    expect(
      findLegacyExportViolations({
        deep: { a: { b: { c: { d: { beyond: 0xf2f1 } } } } },
      }),
    ).toEqual([]);
    expect(
      findLegacyExportViolations({
        current: [
          0x0004,
          0x8009,
          0xf2f0,
          BigInt(0x8009),
          "0X8009",
          "legacy domain string",
        ],
      }),
    ).toEqual([]);
    expect(
      findLegacyExportViolations({
        nullPrototype: Object.assign(
          Object.create(null) as Record<string, unknown>,
          { legacy: 0xf2f1 },
        ),
      }),
    ).not.toEqual([]);
  });

  it("keeps all five erased historical proof types in the compiler denylist", () => {
    for (const name of [
      "AccountIdentityProofRequest",
      "AccountIdentityProof",
      "SignedAccountIdentityProofEvent",
      "AccountIdentityProofEventSigner",
      "AccountIdentityProofSigner",
    ])
      expect(PRIVATE_EXPORT_NAMES).toContain(name);
  });
  it("rejects nested removed legacy export names after a clean current-name control", () => {
    expect(
      findLegacyExportViolations({
        nested: { accountIdentityProofTemplate: "current" },
      }),
    ).toEqual([]);
    const violations = findLegacyExportViolations({
      nested: { encodeAccountIdentityProof: () => undefined },
    });
    expect(
      violations.some((violation) =>
        violation.includes(
          "nested.encodeAccountIdentityProof: removed legacy export name",
        ),
      ),
      "nested removed name must be attributed",
    ).toBe(true);
  });
  it.each(PUBLIC_SURFACES)(
    "%s exposes no legacy proof export",
    (_subpath, namespace) => {
      expect(findLegacyExportViolations(namespace)).toEqual([]);
    },
  );

  it("flags planted legacy names, legacy-shaped constants and nested 0xf2f1 values (guard self-test)", () => {
    // Denylist: an exact removed legacy export name.
    expect(
      findLegacyExportViolations({
        encodeAccountIdentityProof: () => undefined,
      }),
    ).not.toEqual([]);

    // Name pattern: a legacy-shaped name not in the frozen denylist.
    expect(
      findLegacyExportViolations({
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE: 0x1234,
      }),
    ).not.toEqual([]);

    // Top-level number equal to the legacy extension type.
    expect(
      findLegacyExportViolations({ SOME_EXTENSION_TYPE: 0xf2f1 }),
    ).not.toEqual([]);

    // Nested in an array.
    expect(findLegacyExportViolations({ ids: [0x0001, 0xf2f1] })).not.toEqual(
      [],
    );

    // Nested bigint inside a plain object.
    expect(
      findLegacyExportViolations({ table: { legacy: BigInt(0xf2f1) } }),
    ).not.toEqual([]);

    // A Set containing a case-insensitive hex-string form.
    expect(
      findLegacyExportViolations({ tags: new Set(["0xF2F1"]) }),
    ).not.toEqual([]);

    // A Map key equal to the legacy extension type.
    expect(
      findLegacyExportViolations({ byId: new Map([[0xf2f1, "legacy"]]) }),
    ).not.toEqual([]);

    // A class static equal to the legacy extension type.
    class Holder {
      static TYPE = 0xf2f1;
    }
    expect(findLegacyExportViolations({ Holder })).not.toEqual([]);

    // Negative control: current, legitimate `0x8009` names and values must not trip the
    // guard. The five erased historical proof types are checked separately in the
    // compiler-symbol denylist across all ten manifest code entrypoints.
    expect(
      findLegacyExportViolations({
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID: 0x8009,
        AccountIdentityProofError: class extends Error {},
        accountIdentityProofTemplate:
          "Authorize this MLS leaf key for my Marmot account",
      }),
    ).toEqual([]);
  });
});
