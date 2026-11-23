/** @module @category Client - Group Images */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClientState } from "ts-mls";
import {
  decryptGroupImage,
  getGroupImageSource,
  getGroupImageSnapshotIdentity,
  GroupImageIntegrityError,
  type GroupImageSource,
  type GroupImageSnapshotIdentity,
} from "../../core/group-image.js";
import {
  fetchGroupImageTransport,
  GroupImageRequestError,
  normalizeGroupImageEndpoint,
  validateGroupImageRequestUrl,
  validateGroupImageUploadRequest,
  type GroupImageTransport,
  type GroupImageTransportRequest,
  type GroupImageTransportResponse,
} from "./group-image-transport.js";
import type { GroupPublishResult } from "../session/group-effects.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupImageProfile {
  endpoints?: readonly string[];
  resolveEndpoints?: (
    source: GroupImageSource,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  transport?: GroupImageTransport;
  maxDownloadBytes?: number;
  maxUploadBytes?: number;
  maxDescriptorBytes?: number;
  maxDiagnosticBytes?: number;
  maxEndpointCandidates?: number;
  deadlineMs?: number;
  /** Called again for every request and before delivery; false refuses contact. */
  contactPolicy?: GroupImageContactPolicy;
}
export type GroupImageContactPolicy = (
  request: { url: string; method: "GET" | "PUT" },
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export type GroupImageUnavailableReason =
  | "no-image"
  | "url-selected"
  | "endpoint-absent"
  | "missing-blob"
  | "contact-denied"
  | "byte-limit"
  | "deadline"
  | "transport"
  | "invalid-response"
  | "hash-mismatch"
  | "aead-failure"
  | "cancelled"
  | "stale"
  | "closed";
export type GroupImageReadResult =
  | {
      kind: "available";
      bytes: Uint8Array;
      mediaType: string;
      snapshotIdentity: GroupImageSnapshotIdentity;
    }
  | { kind: "unavailable"; reason: GroupImageUnavailableReason };
export interface GroupImageOperationOptions {
  signal?: AbortSignal;
}
export type GroupImageMutationResult =
  | { kind: "published"; publications: GroupPublishResult[] }
  | { kind: "unavailable"; reason: GroupImageUnavailableReason };
export type GroupImageReplacementResult = GroupImageMutationResult;
export type GroupImageClearResult = GroupImageMutationResult;

/** @internal Complete compatibility tuple; never weaken a caller via reuse. */
export interface EffectiveGroupImageReadProfile {
  endpoints: readonly string[];
  resolverOutcome: "configured" | "resolved";
  transport: GroupImageTransport;
  contactPolicy?: GroupImageContactPolicy;
  authorization: readonly boolean[];
  maxDownloadBytes: number;
  maxUploadBytes: number;
  maxDescriptorBytes: number;
  maxDiagnosticBytes: number;
  maxEndpointCandidates: number;
  deadlineMs: number;
  /** Provenance for future cache entries and in-flight operations. */
  compatibilityKey: string;
}

type BlossomSource = Extract<GroupImageSource, { kind: "blossom" }>;
type Unavailable = Extract<GroupImageReadResult, { kind: "unavailable" }>;

// ---------------------------------------------------------------------------
// Profile limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Ciphertext is the plaintext plus a 16-byte AEAD tag. */
const AEAD_TAG_BYTES = 16;
const DEFAULT_MAX_DOWNLOAD_BYTES = DEFAULT_MAX_UPLOAD_BYTES + AEAD_TAG_BYTES;
const DEFAULT_MAX_DESCRIPTOR_BYTES = 16 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 1024;
const DEFAULT_MAX_ENDPOINT_CANDIDATES = 4;
const DEFAULT_DEADLINE_MS = 60_000;
/** Largest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2_147_483_647;

/** Validate a positive integer limit, falling back to a default when unset. */
export function groupImageLimit(
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new GroupImageRequestError("byte-limit");
  return limit;
}

/** The total time budget for one image operation. */
function groupImageDeadline(profile: GroupImageProfile): number {
  return groupImageLimit(profile.deadlineMs, DEFAULT_DEADLINE_MS, MAX_TIMER_MS);
}

/** Validate every profile limit up front and fill in defaults. */
function groupImageLimits(profile: GroupImageProfile) {
  return {
    maxDownloadBytes: groupImageLimit(
      profile.maxDownloadBytes,
      DEFAULT_MAX_DOWNLOAD_BYTES,
    ),
    maxUploadBytes: groupImageLimit(
      profile.maxUploadBytes,
      DEFAULT_MAX_UPLOAD_BYTES,
    ),
    maxDescriptorBytes: groupImageLimit(
      profile.maxDescriptorBytes,
      DEFAULT_MAX_DESCRIPTOR_BYTES,
    ),
    maxDiagnosticBytes: groupImageLimit(
      profile.maxDiagnosticBytes,
      DEFAULT_MAX_DIAGNOSTIC_BYTES,
    ),
    maxEndpointCandidates: groupImageLimit(
      profile.maxEndpointCandidates,
      DEFAULT_MAX_ENDPOINT_CANDIDATES,
    ),
    deadlineMs: groupImageDeadline(profile),
  };
}

// ---------------------------------------------------------------------------
// Endpoints and contact policy
// ---------------------------------------------------------------------------

/** Blossom serves blobs at `<endpoint>/<sha256 hex>`. */
function blobUrl(endpoint: string, source: BlossomSource): string {
  return `${endpoint}/${bytesToHex(source.metadata.imageHash)}`;
}

/** Ask the contact policy whether a request may be sent. No policy allows all. */
async function contactAllowed(
  policy: GroupImageContactPolicy | undefined,
  request: { url: string; method: "GET" | "PUT" },
  signal: AbortSignal,
): Promise<boolean> {
  if (!policy) return true;
  return (await policy(request, signal)) === true;
}

/** Configured or resolved endpoints, validated, normalized and de-duplicated. */
export async function groupImageEndpoints(
  profile: GroupImageProfile,
  source: GroupImageSource,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) throw new GroupImageRequestError("cancelled");
  const maximum = groupImageLimit(
    profile.maxEndpointCandidates,
    DEFAULT_MAX_ENDPOINT_CANDIDATES,
  );
  const endpoints = profile.resolveEndpoints
    ? await profile.resolveEndpoints(source, signal)
    : (profile.endpoints ?? []);
  if (signal.aborted) throw new GroupImageRequestError("cancelled");

  if (!Array.isArray(endpoints))
    throw new GroupImageRequestError("contact-denied");
  if (endpoints.length === 0)
    throw new GroupImageRequestError("endpoint-absent");
  if (endpoints.length > maximum)
    throw new GroupImageRequestError("contact-denied");
  return [...new Set(endpoints.map(normalizeGroupImageEndpoint))];
}

/** Stable numeric ids for caller-supplied functions, used in compatibility keys. */
const functionIds = new WeakMap<object, number>();
let nextFunctionId = 0;
function identity(value: object | undefined): number {
  if (!value) return 0;
  let id = functionIds.get(value);
  if (!id) {
    id = ++nextFunctionId;
    functionIds.set(value, id);
  }
  return id;
}

/**
 * @internal Evaluate this caller before any cache lookup or shared admission.
 *
 * Two reads may only share a fetch or cache entry when every setting that could
 * restrict the caller (endpoints, policy decisions, limits...) is identical,
 * which is what `compatibilityKey` captures.
 */
export async function effectiveGroupImageReadProfile(
  profile: GroupImageProfile,
  source: BlossomSource,
  signal: AbortSignal,
): Promise<EffectiveGroupImageReadProfile> {
  const limits = groupImageLimits(profile);
  const endpoints = await groupImageEndpoints(profile, source, signal);
  const transport = profile.transport ?? fetchGroupImageTransport;
  const resolverOutcome = profile.resolveEndpoints ? "resolved" : "configured";

  // Ask the contact policy about every candidate endpoint.
  const authorization = await Promise.all(
    endpoints.map((endpoint) =>
      contactAllowed(
        profile.contactPolicy,
        { url: blobUrl(endpoint, source), method: "GET" },
        signal,
      ),
    ),
  );

  const compatibilityKey = JSON.stringify([
    endpoints,
    resolverOutcome,
    identity(profile.resolveEndpoints),
    identity(transport),
    identity(profile.contactPolicy),
    authorization,
    limits.maxDownloadBytes,
    limits.maxUploadBytes,
    limits.maxDescriptorBytes,
    limits.maxDiagnosticBytes,
    limits.maxEndpointCandidates,
    limits.deadlineMs,
  ]);

  return {
    ...limits,
    endpoints,
    resolverOutcome,
    transport,
    contactPolicy: profile.contactPolicy,
    authorization,
    compatibilityKey,
  };
}

// ---------------------------------------------------------------------------
// Time budget and requests
// ---------------------------------------------------------------------------

/**
 * @internal Run `operation` within one deadline covering resolver, policy,
 * transport and body reading.
 *
 * The returned promise rejects as soon as the caller cancels or the deadline
 * passes, even if `operation` ignores its abort signal and never settles.
 */
export async function withGroupImageBudget<T>(
  profile: GroupImageProfile,
  options: GroupImageOperationOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadlineMs = groupImageDeadline(profile);
  if (options.signal?.aborted) throw new GroupImageRequestError("cancelled");

  const expiresAt = performance.now() + deadlineMs;
  const controller = new AbortController();

  // Settles only by rejecting: on caller cancellation or deadline expiry.
  let interrupt!: (reason: "cancelled" | "deadline") => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = (reason) => {
      controller.abort();
      reject(new GroupImageRequestError(reason));
    };
  });
  const onCancel = () => interrupt("cancelled");
  const timer = setTimeout(() => interrupt("deadline"), deadlineMs);
  options.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const result = await Promise.race([
      operation(controller.signal),
      interrupted,
    ]);
    // The timer may not have fired yet even though the budget is spent.
    if (performance.now() >= expiresAt)
      throw new GroupImageRequestError("deadline");
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    controller.abort();
  }
}

/**
 * Send one checked request to an image server.
 *
 * Validates the request and profile, asks the contact policy, runs the
 * transport within the profile deadline (which also covers custom transports
 * that do not settle after abort) and bounds the response size.
 */
export async function requestGroupImage(
  profile: GroupImageProfile,
  request: Omit<GroupImageTransportRequest, "signal" | "deadlineMs">,
  options: GroupImageOperationOptions = {},
): Promise<GroupImageTransportResponse> {
  // Read the profile once so later caller mutation has no effect.
  const transport = profile.transport ?? fetchGroupImageTransport;
  const contactPolicy = profile.contactPolicy;

  validateGroupImageRequestUrl(request.url, request.method);
  groupImageLimit(request.maxBytes, 1);
  const limits = groupImageLimits(profile);
  if (
    request.body &&
    request.body.length > limits.maxUploadBytes + AEAD_TAG_BYTES
  )
    throw new GroupImageRequestError("byte-limit");

  // Own a copy of the request so the caller cannot change what is sent.
  request = {
    ...request,
    headers: { ...request.headers },
    body: request.body?.slice(),
  };
  validateGroupImageUploadRequest(request);

  const send = async (signal: AbortSignal) => {
    const allowed = await contactAllowed(
      contactPolicy,
      { url: request.url, method: request.method },
      signal,
    );
    if (!allowed) throw new GroupImageRequestError("contact-denied");
    if (signal.aborted) throw new GroupImageRequestError("cancelled");
    return transport({
      ...request,
      signal,
      deadlineMs: limits.deadlineMs,
      maxDiagnosticBytes: limits.maxDiagnosticBytes,
    });
  };
  const response = await withGroupImageBudget(
    { deadlineMs: limits.deadlineMs },
    options,
    send,
  );

  // Never trust a custom transport's response shape.
  if (
    !response ||
    !(response.body instanceof Uint8Array) ||
    !Number.isInteger(response.status)
  )
    throw new GroupImageRequestError("invalid-response");

  // Error bodies are diagnostics only and get a much smaller allowance.
  const ok = response.status >= 200 && response.status < 300;
  const limit = ok
    ? request.maxBytes
    : Math.min(request.maxBytes, limits.maxDiagnosticBytes);
  if (response.body.length > limit)
    throw new GroupImageRequestError("byte-limit");
  return { ...response, body: response.body.slice() };
}

/**
 * A signal that aborts when any input aborts. Unlike `AbortSignal.any`, the
 * listeners on the inputs are removed by `unlink()`, so long-lived caller
 * signals do not accumulate them.
 */
function linkSignals(...inputs: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  unlink: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const input of inputs) {
    input?.addEventListener("abort", abort, { once: true });
    if (input?.aborted) abort();
  }
  const unlink = () => {
    for (const input of inputs) input?.removeEventListener("abort", abort);
  };
  return { signal: controller.signal, unlink };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class GroupImageReadError extends Error {
  constructor(readonly reason: "closed" | "stale" | "missing-blob") {
    super(`group image ${reason}`);
  }
}

/** Map any thrown error to an `unavailable` result. */
export function groupImageUnavailable(error: unknown): Unavailable {
  const known =
    error instanceof GroupImageRequestError ||
    error instanceof GroupImageReadError ||
    error instanceof GroupImageIntegrityError;
  return { kind: "unavailable", reason: known ? error.reason : "transport" };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** A verified decrypt, plus the ciphertext size needed to re-check limits. */
type ImageReadSuccess = Extract<GroupImageReadResult, { kind: "available" }> & {
  ciphertextBytes: number;
};

/** A fetch shared by every concurrent reader with the same compatibility key. */
type ImageOperation = {
  controller: AbortController;
  waiters: number;
  /** Fetched plaintext, wiped once the last waiter leaves. */
  bytes?: Uint8Array;
  promise: Promise<ImageReadSuccess | Unavailable>;
};

type ImageCacheEntry = ImageReadSuccess & {
  compatibilityKey: string;
  plaintextBytes: number;
};

/** A successful read that may be cached, with the profile it was checked under. */
type VerifiedRead = { value: ImageReadSuccess; compatibilityKey: string };

function cacheCapacity(value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 0)
    throw new GroupImageRequestError("byte-limit");
  return capacity;
}

/**
 * Canonical source projection and verified image retrieval; no default
 * persistence.
 *
 * Every plaintext buffer the service owns is tracked in `plaintext` so that it
 * can be zeroed when it is no longer needed or when the group closes.
 */
export class GroupImageService {
  /** Shared fetches keyed by `<snapshot identity>:<compatibility key>`. */
  private readonly inFlight = new Map<string, ImageOperation>();
  /** Reader counts per snapshot, so retirement keeps entries still being read. */
  private readonly activeReads = new Map<GroupImageSnapshotIdentity, number>();
  /** Every owned plaintext buffer that must be wiped on close. */
  private readonly plaintext = new Set<Uint8Array>();
  /** LRU cache of verified plaintext; insertion order is recency order. */
  private readonly cache = new Map<
    GroupImageSnapshotIdentity,
    ImageCacheEntry
  >();
  private cacheBytes = 0;
  private readonly lifetime = new AbortController();
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxActiveReads: number;

  constructor(
    private readonly options: {
      getState: () => ClientState;
      /** @internal Canonical snapshots retained by the session. */
      getRetainedStates?: () => Iterable<ClientState>;
      isClosed: () => boolean;
      /** Verified in-memory entries, default 16; zero disables caching. */
      maxCacheEntries?: number;
      /** Total cached plaintext bytes, default 20 MiB; zero disables caching. */
      maxCacheBytes?: number;
      /** Concurrent physical reads, default four. */
      maxActiveReads?: number;
    },
  ) {
    this.maxCacheEntries = cacheCapacity(options.maxCacheEntries, 16);
    this.maxCacheBytes = cacheCapacity(options.maxCacheBytes, 20 * 1024 * 1024);
    this.maxActiveReads = groupImageLimit(options.maxActiveReads, 4);
  }

  /** Image lifetime, also used by manager-owned uploads and identity reads. */
  get closedSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** The image source selected by the current group state. */
  source(): GroupImageSource {
    return getGroupImageSource(this.options.getState());
  }

  /** Release owned image work and plaintext on group teardown. Idempotent. */
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    for (const operation of this.inFlight.values())
      operation.controller.abort();
    this.inFlight.clear();
    for (const bytes of this.plaintext) bytes.fill(0);
    this.plaintext.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** @internal Release detached owned copies after successful session persistence. */
  retireRetained(branchStates: Iterable<ClientState> = []): void {
    if (this.isClosed() || this.cache.size === 0) return;

    // Keep images still being read or referenced by any state we may return to.
    const keep = new Set(this.activeReads.keys());
    const protect = (source: GroupImageSource) => {
      if (source.kind === "blossom")
        keep.add(getGroupImageSnapshotIdentity(source.metadata));
    };
    protect(this.source());
    for (const state of this.options.getRetainedStates?.() ?? [])
      protect(getGroupImageSource(state));
    for (const state of branchStates) protect(getGroupImageSource(state));

    for (const snapshotIdentity of [...this.cache.keys()])
      if (!keep.has(snapshotIdentity)) this.evict(snapshotIdentity);
  }

  /**
   * Read, decrypt and verify the current group image.
   *
   * Never throws: every failure is reported as an `unavailable` result.
   */
  async read(
    profile: GroupImageProfile,
    options: GroupImageOperationOptions = {},
  ): Promise<GroupImageReadResult> {
    // Snapshot the profile so caller mutation mid-read has no effect.
    profile = { ...profile, endpoints: profile.endpoints?.slice() };
    if (this.isClosed()) return { kind: "unavailable", reason: "closed" };
    if (options.signal?.aborted)
      return { kind: "unavailable", reason: "cancelled" };

    const source = structuredClone(this.source());
    if (source.kind !== "blossom")
      return {
        kind: "unavailable",
        reason: source.kind === "url" ? "url-selected" : "no-image",
      };
    source.snapshotIdentity = getGroupImageSnapshotIdentity(source.metadata);

    // Cancelled by either the caller or service close.
    const { signal, unlink } = linkSignals(
      options.signal,
      this.lifetime.signal,
    );
    const endRead = this.beginRead(source.snapshotIdentity);

    // Plaintext produced for this caller but not yet returned. Wiped in
    // `finally` if anything (including deadline expiry) stops the hand-off.
    let undelivered: Uint8Array | undefined;
    const retainDelivery = (bytes: Uint8Array) => {
      undelivered = bytes;
      this.plaintext.add(bytes);
    };

    try {
      const expiresAt = performance.now() + groupImageDeadline(profile);
      const { result, verified } = await withGroupImageBudget(
        profile,
        { signal },
        (budget) => this.readWithin(profile, source, budget, retainDelivery),
      );

      if (result.kind === "available") {
        undelivered = result.bytes;
        if (signal.aborted) throw new GroupImageRequestError("cancelled");
        if (performance.now() >= expiresAt)
          throw new GroupImageRequestError("deadline");
        this.assertCurrent(source);

        // Only a successful delivery populates the cache; a failed, revoked,
        // expired or stale waiter never warms it for future callers.
        const cached =
          verified &&
          this.remember(
            { ...verified.value, bytes: result.bytes },
            verified.compatibilityKey,
          );
        // Copying a large image can itself take measurable time.
        if (performance.now() >= expiresAt) {
          if (cached && this.cache.get(source.snapshotIdentity) === cached)
            this.evict(source.snapshotIdentity);
          throw new GroupImageRequestError("deadline");
        }
      }

      if (this.isClosed()) return { kind: "unavailable", reason: "closed" };
      // Ownership passes to the caller: stop tracking without wiping.
      if (result.kind === "available") this.plaintext.delete(result.bytes);
      undelivered = undefined;
      return result;
    } catch (error) {
      if (this.isClosed()) return { kind: "unavailable", reason: "closed" };
      return groupImageUnavailable(error);
    } finally {
      if (undelivered) this.wipe(undelivered);
      endRead();
      unlink();
    }
  }

  /** The body of `read()` that runs inside the time budget. */
  private async readWithin(
    profile: GroupImageProfile,
    source: BlossomSource,
    signal: AbortSignal,
    retainDelivery: (bytes: Uint8Array) => void,
  ): Promise<{ result: GroupImageReadResult; verified?: VerifiedRead }> {
    // Evaluate this caller before touching any shared cache or fetch.
    const effective = await effectiveGroupImageReadProfile(
      profile,
      structuredClone(source),
      signal,
    );
    if (signal.aborted) throw new GroupImageRequestError("cancelled");
    if (!effective.authorization.some(Boolean))
      throw new GroupImageRequestError("contact-denied");
    this.assertCurrent(source);
    const { compatibilityKey } = effective;
    const deliver = (value: ImageReadSuccess) =>
      this.deliver(value, profile, source, effective, signal, retainDelivery);

    // Fast path: a verified entry fetched under an identical profile.
    const cached = this.cache.get(source.snapshotIdentity);
    if (cached?.compatibilityKey === compatibilityKey) {
      const result = await deliver(cached);
      return { result, verified: { value: cached, compatibilityKey } };
    }

    // Otherwise join (or start) the shared fetch for this profile.
    const key = `${source.snapshotIdentity}:${compatibilityKey}`;
    const operation = this.joinFetch(key, profile, source, effective);
    const leave = this.addWaiter(key, operation, signal);
    try {
      const fetched = await operation.promise;
      if (fetched.kind === "unavailable") return { result: fetched };
      // `deliver` copies the bytes before its first await, so the shared
      // buffer may safely be wiped once we leave.
      const result = await deliver(fetched);
      return { result, verified: { value: fetched, compatibilityKey } };
    } finally {
      leave();
    }
  }

  /** Return the in-flight fetch for `key`, starting one if needed. */
  private joinFetch(
    key: string,
    profile: GroupImageProfile,
    source: BlossomSource,
    effective: EffectiveGroupImageReadProfile,
  ): ImageOperation {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= this.maxActiveReads)
      throw new GroupImageRequestError("byte-limit");

    const controller = new AbortController();
    const operation: ImageOperation = {
      controller,
      waiters: 0,
      promise: this.fetch(profile, source, effective, controller.signal).then(
        (value) => {
          // The plaintext belongs to this operation until its last waiter
          // leaves. If everyone already left (or we closed), wipe it now.
          if (value.kind === "available") {
            operation.bytes = value.bytes;
            if (operation.waiters === 0 || this.isClosed())
              this.wipe(value.bytes);
          }
          return value;
        },
      ),
    };
    this.inFlight.set(key, operation);
    return operation;
  }

  /**
   * Register a waiter on a shared fetch. Returns an idempotent `leave()`,
   * also triggered by `signal`. The last waiter to leave aborts the fetch
   * and wipes its plaintext.
   */
  private addWaiter(
    key: string,
    operation: ImageOperation,
    signal: AbortSignal,
  ): () => void {
    operation.waiters++;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      signal.removeEventListener("abort", leave);
      if (--operation.waiters > 0) return;
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
      operation.controller.abort();
      if (operation.bytes) this.wipe(operation.bytes);
    };
    signal.addEventListener("abort", leave, { once: true });
    return leave;
  }

  /** Download, decrypt and verify the image from the first authorized endpoint. */
  private async fetch(
    profile: GroupImageProfile,
    source: BlossomSource,
    effective: EffectiveGroupImageReadProfile,
    signal: AbortSignal,
  ): Promise<ImageReadSuccess | Unavailable> {
    try {
      const endpoint = effective.endpoints.find(
        (_, index) => effective.authorization[index],
      );
      if (!endpoint) throw new GroupImageRequestError("contact-denied");

      const response = await requestGroupImage(
        profile,
        {
          url: blobUrl(endpoint, source),
          method: "GET",
          headers: {},
          maxBytes: effective.maxDownloadBytes,
        },
        { signal },
      );
      this.assertCurrent(source);
      if (response.status === 404)
        throw new GroupImageReadError("missing-blob");
      if (response.status !== 200)
        throw new GroupImageRequestError("invalid-response");

      // Decryption also verifies the hash and AEAD tag.
      const bytes = decryptGroupImage(response.body, source.metadata);
      if (bytes.length > effective.maxUploadBytes) {
        bytes.fill(0);
        throw new GroupImageRequestError("byte-limit");
      }
      this.assertCurrent(source);
      this.plaintext.add(bytes);
      return {
        kind: "available",
        bytes,
        mediaType: source.metadata.mediaType,
        snapshotIdentity: source.snapshotIdentity,
        ciphertextBytes: response.body.length,
      };
    } catch (error) {
      return groupImageUnavailable(error);
    }
  }

  /**
   * Hand a verified image (cached or freshly fetched) to one caller.
   *
   * The caller's profile is re-evaluated, even when another waiter performed
   * the request, so reuse can never bypass this caller's policy or limits.
   */
  private async deliver(
    value: ImageReadSuccess,
    profile: GroupImageProfile,
    source: BlossomSource,
    effective: EffectiveGroupImageReadProfile,
    signal: AbortSignal,
    retainDelivery: (bytes: Uint8Array) => void,
  ): Promise<GroupImageReadResult> {
    // Copy before any await: cache eviction and other waiters may wipe the
    // backing bytes while this caller's policy is being evaluated.
    const retained = value.bytes.slice();
    this.plaintext.add(retained);
    const release = () => this.wipe(retained);
    signal.addEventListener("abort", release, { once: true });
    try {
      const now = await effectiveGroupImageReadProfile(
        profile,
        structuredClone(source),
        signal,
      );
      if (
        !now.authorization.some(Boolean) ||
        now.compatibilityKey !== effective.compatibilityKey
      )
        throw new GroupImageRequestError("contact-denied");
      if (signal.aborted) throw new GroupImageRequestError("cancelled");
      if (
        value.ciphertextBytes > now.maxDownloadBytes ||
        retained.length > now.maxUploadBytes
      )
        throw new GroupImageRequestError("byte-limit");
      this.assertCurrent(source);

      const bytes = retained.slice();
      retainDelivery(bytes);
      return {
        kind: "available",
        bytes,
        mediaType: value.mediaType,
        snapshotIdentity: value.snapshotIdentity,
      };
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  }

  /** Store a verified image in the LRU cache, evicting the oldest as needed. */
  private remember(
    value: ImageReadSuccess,
    compatibilityKey: string,
  ): ImageCacheEntry | undefined {
    if (
      !this.maxCacheEntries ||
      !this.maxCacheBytes ||
      value.bytes.length > this.maxCacheBytes
    )
      return;

    // Same image under the same profile: just mark it most recently used.
    const previous = this.cache.get(value.snapshotIdentity);
    if (previous?.compatibilityKey === compatibilityKey) {
      this.cache.delete(value.snapshotIdentity);
      this.cache.set(value.snapshotIdentity, previous);
      return previous;
    }
    if (previous) this.evict(value.snapshotIdentity);

    const entry: ImageCacheEntry = {
      ...value,
      bytes: value.bytes.slice(),
      plaintextBytes: value.bytes.length,
      compatibilityKey,
    };
    this.cache.set(value.snapshotIdentity, entry);
    this.plaintext.add(entry.bytes);
    this.cacheBytes += entry.plaintextBytes;

    while (
      this.cache.size > this.maxCacheEntries ||
      this.cacheBytes > this.maxCacheBytes
    )
      this.evict(this.cache.keys().next().value!);
    return entry;
  }

  /** Drop a cache entry and wipe its plaintext. */
  private evict(snapshotIdentity: GroupImageSnapshotIdentity): void {
    const entry = this.cache.get(snapshotIdentity);
    if (!entry) return;
    this.cache.delete(snapshotIdentity);
    this.cacheBytes -= entry.plaintextBytes;
    this.wipe(entry.bytes);
  }

  /** Zero an owned plaintext buffer and stop tracking it. */
  private wipe(bytes: Uint8Array): void {
    bytes.fill(0);
    this.plaintext.delete(bytes);
  }

  /** Count a reader of `snapshotIdentity`; returns the matching release. */
  private beginRead(snapshotIdentity: GroupImageSnapshotIdentity): () => void {
    this.activeReads.set(
      snapshotIdentity,
      (this.activeReads.get(snapshotIdentity) ?? 0) + 1,
    );
    return () => {
      const readers = this.activeReads.get(snapshotIdentity)! - 1;
      if (readers === 0) this.activeReads.delete(snapshotIdentity);
      else this.activeReads.set(snapshotIdentity, readers);
    };
  }

  /** Also closes the service if the owning group has closed. */
  private isClosed(): boolean {
    if (this.options.isClosed()) this.close();
    return this.lifetime.signal.aborted;
  }

  /** Throw unless the service is open and `source` is still the current image. */
  private assertCurrent(source: BlossomSource): void {
    if (this.isClosed()) throw new GroupImageReadError("closed");
    const current = this.source();
    if (
      current.kind !== "blossom" ||
      getGroupImageSnapshotIdentity(current.metadata) !==
        source.snapshotIdentity
    )
      throw new GroupImageReadError("stale");
  }
}
