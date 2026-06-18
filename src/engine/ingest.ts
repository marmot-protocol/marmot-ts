/** @module @category Engine */
import { Debugger } from "debug";
import {
  acceptAll,
  type CiphersuiteImpl,
  type ClientState,
  contentTypes,
  encode,
  type IncomingMessageCallback,
  mlsMessageEncoder,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  ValidationError,
  wireformats,
} from "ts-mls";

import { marmotAuthService } from "../core/auth-service.js";
import {
  type CommitOrderingKey,
  commitDigest,
  compareCommitOrderingKeys,
  DEFAULT_CONVERGENCE_POLICY,
} from "../core/convergence.js";
import { type DeferredReason, deferredReasons } from "../core/inbound.js";
import { classifyLateCommit } from "../core/retained-history.js";
import type { RetainedHistoryStore } from "./retained-store.js";
import type { IngestResult, PeeledMessagePair } from "./types.js";
import { framedContentType, framedEpoch } from "./wire-format.js";

/** A message deferred this batch, remembered so terminal yields report it as
 * `deferred` (retryable) rather than `unreadable` (terminal/malformed). */
type DeferredEntry = { message: MlsMessage; reason: DeferredReason };

/** The applied outcome of a fork resolution, as the ingest loop consumes it. */
export type AppliedForkResolution =
  | { outcome: "recovered"; result: ProcessMessageResult }
  | { outcome: "superseded" | "skip" };

/**
 * The engine-facing surface the ingest pipeline drives. State and lifecycle
 * mutation stay owned by the engine; the pipeline only reads/advances through
 * these hooks so the convergence rewind and `Unrecoverable` transition remain
 * the engine's responsibility.
 */
export interface IngestContext<TEnvelope> {
  ciphersuite: CiphersuiteImpl;
  peeler: {
    peelGroupMessages(
      envelopes: TEnvelope[],
      state: ClientState,
    ): Promise<{
      read: PeeledMessagePair<TEnvelope>[];
      unreadable: TEnvelope[];
    }>;
  };
  retained: RetainedHistoryStore;
  log: Debugger;
  getState(): ClientState;
  setState(state: ClientState): void;
  /** Builds the admin-verification callback against the current state. */
  createAdminCallback(): IncomingMessageCallback;
  /** Resolves a fork and applies the rewind (state + lifecycle) on success. */
  resolveFork(
    forkEpoch: number,
    pool: MlsMessage[],
    encrypted: TEnvelope[],
    witnessEnvelopes: TEnvelope[],
  ): Promise<AppliedForkResolution>;
  /** Drives the group to the terminal `Unrecoverable` lifecycle state. */
  toUnrecoverable(): void;
}

/**
 * A decryption failure that retrying can never recover. The MLS secret tree
 * only ratchets forward, so once a generation's secret has been consumed and
 * deleted (forward secrecy) it is gone for good; ts-mls signals this with a
 * {@link ValidationError} "Desired gen in the past". This is expected — and
 * benign — for a member's own application messages replayed by a relay and for
 * duplicate deliveries. Re-attempting against the same (or a further-advanced)
 * state is byte-for-byte futile, so these are dropped as unreadable on the
 * first pass instead of churning through the retry loop.
 */
function isPermanentDecryptFailure(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    error.message.includes("Desired gen in the past")
  );
}

/** A short, stable label for an envelope in debug logs. */
function envelopeLabel<TEnvelope>(envelope: TEnvelope): string {
  if (
    envelope &&
    typeof envelope === "object" &&
    "id" in envelope &&
    typeof (envelope as { id: unknown }).id === "string"
  ) {
    return (envelope as { id: string }).id.slice(0, 8);
  }
  return "?";
}

/**
 * Resolves a still-unprocessed envelope to its terminal {@link IngestResult}:
 * `deferred` (retryable — missing parent / future epoch) when the batch marked
 * it as such, otherwise `unreadable` (terminal). Keeping deferred inputs out of
 * `unreadable` is what stops a future-epoch commit being mislabeled
 * `stale: invalid_encoding` (`protocol-core/inbound-processing.md`).
 */
function terminalResult<TEnvelope>(
  envelope: TEnvelope,
  deferred: Map<TEnvelope, DeferredEntry>,
  errorList: Array<{ envelope: TEnvelope; error: unknown }>,
): IngestResult<TEnvelope> {
  const entry = deferred.get(envelope);
  if (entry)
    return {
      kind: "deferred",
      envelope,
      message: entry.message,
      reason: entry.reason,
    };
  return {
    kind: "unreadable",
    envelope,
    errors: errorList
      .filter((e) => e.envelope === envelope)
      .map((e) => e.error),
  };
}

/** Orders peeled commits deterministically by their convergence ordering key. */
function sortPeeledCommits<TEnvelope>(
  commits: PeeledMessagePair<TEnvelope>[],
): PeeledMessagePair<TEnvelope>[] {
  const keyed = commits.map((pair) => {
    const sourceEpoch = Number(framedEpoch(pair.message) ?? 0n);
    const key: CommitOrderingKey = {
      sourceEpoch,
      commitDigest: commitDigest(encode(mlsMessageEncoder, pair.message)),
    };
    return { pair, key };
  });
  keyed.sort((a, b) => compareCommitOrderingKeys(a.key, b.key));
  return keyed.map((entry) => entry.pair);
}

/**
 * Ingests transport envelopes and applies MLS messages to group state
 * (Marmot v2 `protocol-core/inbound-processing.md`). Decrypts (retrying against
 * retained states), splits commits from non-commits, applies in-order commits,
 * routes past/future-epoch commits through convergence fork recovery, and
 * retries out-of-order messages only while a pass made progress.
 *
 * This is the engine's `message_processor/ingest` seam, extracted from
 * `MarmotGroupEngine` so the 400-line pipeline can be read and tested in
 * isolation from send and lifecycle.
 */
export async function* ingestEnvelopes<TEnvelope>(
  ctx: IngestContext<TEnvelope>,
  envelopes: TEnvelope[],
  options?: {
    retryCount?: number;
    maxRetries?: number;
    _errors?: Array<{ envelope: TEnvelope; error: unknown }>;
    _deferred?: Map<TEnvelope, DeferredEntry>;
  },
): AsyncGenerator<IngestResult<TEnvelope>> {
  const log = ctx.log.extend(`ingest:${Date.now().toString(36).slice(-5)}`);

  const retryCount = options?.retryCount ?? 0;
  const maxRetries = options?.maxRetries ?? 5;
  const errorList: Array<{ envelope: TEnvelope; error: unknown }> =
    options?._errors ?? [];
  // Envelopes deferred this batch (future-epoch / missing-parent commits). They
  // ride the same retry set as `unreadable` so a later pass can apply them once
  // the gap fills, but at a terminal yield they surface as `deferred`, not stale.
  const deferred: Map<TEnvelope, DeferredEntry> =
    options?._deferred ?? new Map();

  if (retryCount === 0) {
    log("start – %d envelope(s), maxRetries=%d", envelopes.length, maxRetries);
  } else {
    log(
      "retry %d/%d – %d envelope(s) remaining",
      retryCount,
      maxRetries,
      envelopes.length,
    );
  }

  if (retryCount > maxRetries) {
    log(
      "max retries exceeded – yielding %d envelope(s) as deferred/unreadable",
      envelopes.length,
    );
    for (const envelope of envelopes) {
      yield terminalResult(envelope, deferred, errorList);
    }
    return;
  }

  if (envelopes.length === 0) return;

  // Snapshot the state so we can tell whether this pass advanced anything.
  // Every successful apply replaces it via setState, so identity inequality
  // means progress. Retrying envelopes against an unchanged state is
  // deterministic and can only reproduce the same failures.
  const stateBeforePass = ctx.getState();

  let { read, unreadable: decryptFailed } = await ctx.peeler.peelGroupMessages(
    envelopes,
    ctx.getState(),
  );

  if (decryptFailed.length > 0 && ctx.retained.size > 0) {
    const stillFailed: TEnvelope[] = [];
    for (const envelope of decryptFailed) {
      let recovered = false;
      for (const retained of ctx.retained.states()) {
        if (retained === ctx.getState()) continue;
        const retry = await ctx.peeler.peelGroupMessages([envelope], retained);
        if (retry.read.length > 0) {
          read = [...read, ...retry.read];
          recovered = true;
          break;
        }
      }
      if (!recovered) stillFailed.push(envelope);
    }
    decryptFailed = stillFailed;
  }

  log(
    "decryption: %d/%d readable, %d failed",
    read.length,
    envelopes.length,
    decryptFailed.length,
  );

  for (const envelope of decryptFailed) {
    log("decrypt failed envelope:%s", envelopeLabel(envelope));
    errorList.push({
      envelope,
      error: new Error("Failed to decrypt group message"),
    });
  }

  if (read.length === 0) {
    log(
      "nothing readable – yielding %d decrypt failure(s) as unreadable",
      decryptFailed.length,
    );
    for (const envelope of decryptFailed) {
      yield {
        kind: "unreadable",
        envelope,
        errors: errorList
          .filter((e) => e.envelope === envelope)
          .map((e) => e.error),
      };
    }
    return;
  }

  const unreadable: TEnvelope[] = [...decryptFailed];

  let commits: PeeledMessagePair<TEnvelope>[] = [];
  const nonCommits: PeeledMessagePair<TEnvelope>[] = [];

  for (const pair of read) {
    // Commits are MLS PublicMessage under Marmot v2 (see wire-format.ts); other
    // framed content (application, proposals) goes through the non-commit path.
    if (framedContentType(pair.message) === contentTypes.commit) {
      commits.push(pair);
    } else {
      nonCommits.push(pair);
    }
  }

  log(
    "split: %d commit(s), %d non-commit(s)",
    commits.length,
    nonCommits.length,
  );

  for (const { envelope, message } of nonCommits) {
    try {
      if (
        message.wireformat !== wireformats.mls_private_message &&
        message.wireformat !== wireformats.mls_public_message
      ) {
        log(
          "skip envelope:%s reason:wrong-wireformat",
          envelopeLabel(envelope),
        );
        yield {
          kind: "skipped",
          envelope,
          message,
          reason: "wrong-wireformat",
        };
        continue;
      }

      const result = await processMessage({
        context: {
          cipherSuite: ctx.ciphersuite,
          authService: marmotAuthService,
          externalPsks: {},
        },
        state: ctx.getState(),
        message,
        callback: acceptAll,
      });

      if (result.kind === "newState") {
        log(
          "proposal accepted envelope:%s epoch:%d",
          envelopeLabel(envelope),
          ctx.getState().groupContext.epoch,
        );
        ctx.setState(result.newState);
        yield { kind: "processed", result, envelope, message };
      } else if (result.kind === "applicationMessage") {
        log("application message envelope:%s", envelopeLabel(envelope));
        ctx.setState(result.newState);
        yield { kind: "processed", result, envelope, message };
      }
    } catch (error) {
      if (isPermanentDecryptFailure(error)) {
        log(
          "non-commit permanently unreadable envelope:%s – %s",
          envelopeLabel(envelope),
          (error as Error).message,
        );
        yield { kind: "unreadable", envelope, errors: [error] };
        continue;
      }
      log(
        "non-commit failed envelope:%s – queued for retry: %O",
        envelopeLabel(envelope),
        error,
      );
      errorList.push({ envelope, error });
      unreadable.push(envelope);
    }
  }

  commits = sortPeeledCommits(commits);

  const adminCallback = ctx.createAdminCallback();

  const forkPool: {
    envelope: TEnvelope;
    message: MlsMessage;
    epoch: number;
  }[] = [];

  for (const { envelope, message } of commits) {
    // A commit is always framed (private or public); guard narrows the type and
    // defends against a non-framed message reaching the commit path.
    if (
      message.wireformat !== wireformats.mls_private_message &&
      message.wireformat !== wireformats.mls_public_message
    ) {
      log(
        "skip commit envelope:%s reason:wrong-wireformat",
        envelopeLabel(envelope),
      );
      yield { kind: "skipped", envelope, message, reason: "wrong-wireformat" };
      continue;
    }

    const commitEpoch = framedEpoch(message) ?? 0n;
    const currentEpoch = ctx.getState().groupContext.epoch;

    if (commitEpoch < currentEpoch) {
      forkPool.push({ envelope, message, epoch: Number(commitEpoch) });
      continue;
    }

    if (commitEpoch > currentEpoch + 1n) {
      // A commit more than one epoch ahead is missing the intermediate parent
      // commit(s) that would advance us to its source epoch. That parent may
      // still arrive (this or a later batch), so this is retryable `deferred`
      // (missing_parent), not a terminal error. It rides `unreadable` for the
      // in-batch retry but `deferred` remembers it for the terminal yield.
      log(
        "defer commit envelope:%s epoch:%d too far ahead (current=%d) – missing parent",
        envelopeLabel(envelope),
        commitEpoch,
        currentEpoch,
      );
      deferred.set(envelope, {
        message,
        reason: deferredReasons.missingParent,
      });
      unreadable.push(envelope);
      continue;
    }

    log(
      "processing commit envelope:%s epoch:%d->%d",
      envelopeLabel(envelope),
      currentEpoch,
      commitEpoch,
    );

    try {
      const result = await processMessage({
        context: {
          cipherSuite: ctx.ciphersuite,
          authService: marmotAuthService,
          externalPsks: {},
        },
        state: ctx.getState(),
        message,
        callback: adminCallback,
      });

      if (result.kind === "newState") {
        if (result.actionTaken === "reject") {
          log(
            "commit envelope:%s rejected by admin policy",
            envelopeLabel(envelope),
          );
          yield { kind: "rejected", result, envelope, message };
          continue;
        }

        const parentState = ctx.getState();
        ctx.setState(result.newState);
        ctx.retained.record(parentState, message, result.newState);
        log(
          "commit envelope:%s applied – new epoch:%d",
          envelopeLabel(envelope),
          ctx.getState().groupContext.epoch,
        );
        yield { kind: "processed", result, envelope, message };
      }
    } catch (error) {
      if (isPermanentDecryptFailure(error)) {
        log(
          "commit permanently unreadable envelope:%s – %s",
          envelopeLabel(envelope),
          (error as Error).message,
        );
        yield { kind: "unreadable", envelope, errors: [error] };
        continue;
      }
      log(
        "commit failed envelope:%s – queued for retry: %O",
        envelopeLabel(envelope),
        error,
      );
      errorList.push({ envelope, error });
      unreadable.push(envelope);
    }
  }

  if (forkPool.length > 0) {
    const retainedPool = forkPool.filter((p) => ctx.retained.hasState(p.epoch));
    const orphanPool = forkPool.filter((p) => !ctx.retained.hasState(p.epoch));

    if (retainedPool.length > 0) {
      const minForkEpoch = Math.min(...retainedPool.map((p) => p.epoch));
      const resolution = await ctx.resolveFork(
        minForkEpoch,
        retainedPool.map((p) => p.message),
        decryptFailed,
        envelopes,
      );
      if (resolution.outcome === "recovered") {
        log(
          "convergence rewound to canonical branch – epoch:%d",
          ctx.getState().groupContext.epoch,
        );
        const rep = retainedPool[0];
        yield {
          kind: "processed",
          result: resolution.result,
          envelope: rep.envelope,
          message: rep.message,
        };
        for (let i = 1; i < retainedPool.length; i++)
          yield {
            kind: "skipped",
            envelope: retainedPool[i].envelope,
            message: retainedPool[i].message,
            reason: "past-epoch",
          };
      } else {
        for (const p of retainedPool)
          yield {
            kind: "skipped",
            envelope: p.envelope,
            message: p.message,
            reason: "past-epoch",
          };
      }
    }

    if (orphanPool.length > 0) {
      const currentTipEpoch = Number(ctx.getState().groupContext.epoch);
      const anchorEpoch = ctx.retained.anchorEpoch() ?? currentTipEpoch;
      for (const p of orphanPool) {
        if (p.epoch >= currentTipEpoch) {
          yield {
            kind: "skipped",
            envelope: p.envelope,
            message: p.message,
            reason: "past-epoch",
          };
          continue;
        }
        const outcome = classifyLateCommit({
          sourceEpoch: p.epoch,
          anchorEpoch,
          currentTipEpoch,
          maxRewindCommits: DEFAULT_CONVERGENCE_POLICY.maxRewindCommits,
          parentArrived: true,
          retainedParentStateAvailable: false,
        });
        if (outcome.kind === "missing_retained_anchor") {
          ctx.toUnrecoverable();
          log("convergence lost retained anchor – group is Unrecoverable");
          yield {
            kind: "skipped",
            envelope: p.envelope,
            message: p.message,
            reason: "missing-retained-anchor",
          };
        } else if (outcome.kind === "beyond_anchor") {
          yield {
            kind: "skipped",
            envelope: p.envelope,
            message: p.message,
            reason: "beyond-anchor",
          };
        } else {
          yield {
            kind: "skipped",
            envelope: p.envelope,
            message: p.message,
            reason: "past-epoch",
          };
        }
      }
    }
  }

  log("done processing batch – epoch:%d", ctx.getState().groupContext.epoch);

  if (unreadable.length === 0) {
    log("done – no unreadable envelopes remain");
    return;
  }

  // A retry only helps when something applied this pass (e.g. a commit advanced
  // the epoch, unlocking an out-of-order message). If the pass made no progress,
  // the same envelopes against the same state would fail identically — so yield
  // them now instead of spinning to maxRetries.
  if (ctx.getState() === stateBeforePass) {
    log(
      "no progress this pass – yielding %d envelope(s) as deferred/unreadable",
      unreadable.length,
    );
    for (const envelope of unreadable) {
      yield terminalResult(envelope, deferred, errorList);
    }
    return;
  }

  log("scheduling retry for %d unreadable envelope(s)", unreadable.length);
  yield* ingestEnvelopes(ctx, unreadable, {
    retryCount: retryCount + 1,
    maxRetries,
    _errors: errorList,
    _deferred: deferred,
  });
}
