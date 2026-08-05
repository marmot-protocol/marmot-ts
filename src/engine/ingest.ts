/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { Debugger } from "debug";
import {
  acceptAll,
  type CiphersuiteImpl,
  type ClientState,
  contentTypes,
  encode,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  type LeafIndex,
  mlsMessageEncoder,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  ValidationError,
  wireformats,
} from "ts-mls";

import { verifyApplicationRumorAuthorship } from "../core/application-rumor.js";
import { marmotAuthService } from "../core/auth-service.js";
import { validateCommitLegality } from "../core/components/integrity.js";
import {
  type CommitOrderingKey,
  commitDigest,
  compareCommitOrderingKeys,
} from "../core/convergence.js";
import { getCredentialPubkey } from "../core/credential.js";
import { type DeferredReason, deferredReasons } from "../core/inbound.js";
import { classifyLateCommit } from "../core/retained-history.js";
import { withCapturedProposals } from "./admin-policy.js";
import { contentDedupId } from "./message-dedup.js";
import type { RetainedHistoryStore } from "./retained-store.js";
import {
  deriveStateNotifications,
  groupWithdrawnNotificationsByCommit,
  type StateNotification,
} from "./state-notifications.js";
import type { IngestResult, PeeledMessagePair } from "./types.js";
import { framedContentType, framedEpoch } from "./wire-format.js";

/** A message deferred this batch, remembered so terminal yields report it as
 * `deferred` (retryable) rather than `unreadable` (terminal/malformed). */
type DeferredEntry = { message: MlsMessage; reason: DeferredReason };

/** The applied outcome of a fork resolution, as the ingest loop consumes it. */
export type AppliedForkResolution<TEnvelope> =
  | {
      outcome: "recovered";
      result: ProcessMessageResult;
      /**
       * The winning branch's tip commit MLS message, when the winner chain
       * applied at least one commit to reach it (D-10/D-12) — lets the ingest
       * loop attribute a `selfRemoved` notification to the exact commit that
       * produced the `removedFromGroup` tombstone when the rewind lands on
       * it. `undefined` only when the winner tip is the fork root itself (no
       * chain applied), which never coincides with a fresh removal.
       */
      tipCommitMessage: MlsMessage | undefined;
      /**
       * The {@link StateNotification}s derived from the WHOLE applied winner
       * chain (D-10/D-11) — one derivation per `ChainLink`, in chain order,
       * concatenated. A rewind that adopts an N-commit branch applies N
       * commits, so reporting only the tip's diff would silently drop every
       * intermediate commit's membership/component changes (CR-07). Each
       * entry stays attributed to the commit digest that produced it, so the
       * caller can still group by commit.
       *
       * Computed and ledger-recorded by `#applyForkResolution` — the same
       * shared rewind-apply path used by both pool-replay recovery and
       * tree-fed re-convergence — so every one of them is withdrawable by a
       * later rewind. `undefined` when the winner tip is the fork root itself
       * (no chain applied, mirroring `tipCommitMessage`).
       */
      notifications: StateNotification[] | undefined;
      /**
       * App payloads abandoned by the rewind, to report as `invalidated` (M7).
       * Each carries the fork node (`tag`/`epoch`) it had decrypted against so
       * the retraction names its losing branch.
       */
      invalidated: {
        envelope: TEnvelope;
        message: MlsMessage;
        payload: Uint8Array;
        tag: string;
        epoch: number;
      }[];
      /**
       * Notifications withdrawn because the commit(s) that produced them were
       * superseded by this rewind (D-11, CONV-03). Flat — not yet grouped by
       * producing commit digest; the caller groups via
       * {@link groupWithdrawnNotificationsByCommit} before yielding
       * `stateInvalidated` results, since a rewind may supersede more than one
       * commit at once.
       */
      withdrawnNotifications: StateNotification[];
    }
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
  /** The rollback horizon (`maxRewindCommits`) from the active convergence policy. */
  maxRewindCommits: number;
  log: Debugger;
  getState(): ClientState;
  setState(state: ClientState): void;
  /**
   * Records an applied commit on the canonical branch: updates retained history
   * and the full-fork history tree. Replaces a direct `retained.record` so both
   * stay in lockstep, with the freshly-produced child captured pristine.
   */
  recordCommit(
    parentState: ClientState,
    message: MlsMessage,
    newState: ClientState,
  ): void;
  /**
   * Records that a proposal was staged onto the current state (its epoch and
   * confirmation tag are unchanged), so the history tree's node snapshot picks
   * up the new `unappliedProposals`.
   */
  recordProposalStaged(state: ClientState): void;
  /** Builds the admin-verification callback against the current state. */
  createAdminCallback(): IncomingMessageCallback;
  /** Resolves a fork and applies the rewind (state + lifecycle) on success. */
  resolveFork(
    forkEpoch: number,
    pool: MlsMessage[],
    encrypted: TEnvelope[],
    witnessEnvelopes: TEnvelope[],
  ): Promise<AppliedForkResolution<TEnvelope>>;
  /**
   * Remembers an application payload delivered as `accepted` on the current
   * branch state, so a later rewind that abandons that branch can retract it
   * as `invalidated` (M7).
   */
  recordDeliveredAppPayload(
    epoch: number,
    stateTag: string,
    envelope: TEnvelope,
    message: MlsMessage,
    payload: Uint8Array,
  ): void;
  /**
   * Records the {@link StateNotification}s derived from an accepted commit,
   * keyed by its `commitDigest` (D-10/D-11), so a later rewind that supersedes
   * this commit can withdraw exactly these notifications.
   */
  recordStateNotifications(
    digest: Uint8Array,
    epoch: number,
    notifications: StateNotification[],
  ): void;
  /** Drives the group to the terminal `Unrecoverable` lifecycle state. */
  toUnrecoverable(): void;
  /**
   * Content-derived inbound dedup (`inbound-processing.md`; reference
   * `seen_message_ids` / `sent_message_ids`). Keyed on {@link contentDedupId} so
   * the same MLS message re-wrapped in a fresh transport envelope is recognized
   * across sources and restarts-within-process.
   */
  dedup: {
    /**
     * Classifies a peeled message against prior history: `duplicate` (this
     * content was already terminally processed), `own-echo` (our own send
     * replayed back), or `undefined` (fresh — process it).
     */
    classify(message: MlsMessage): "duplicate" | "own-echo" | undefined;
    /** Records a content id as seen, once the message reaches a terminal apply. */
    remember(message: MlsMessage): void;
  };
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
  decryptFailed: ReadonlySet<TEnvelope>,
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
    // A peel failure is retryable (the unlocking state may arrive later); the
    // engine pools these rather than dropping them.
    decryptFailure: decryptFailed.has(envelope) || undefined,
  };
}

/**
 * Whether a decrypted application message is authentic: its inner Nostr event
 * id is canonical AND its `pubkey` matches the MLS-authenticated sender's
 * account identity (`foundation/identity.md`, `protocol-core/group-messaging.md`).
 * MLS authenticates *who* sent the bytes (the sender leaf); this binds the inner
 * author to that sender so a member can't forge another account's authorship.
 * A failure — including an unattributable sender (no leaf index) or a
 * non-conformant payload — is `invalid_encoding`; the message is dropped, never
 * delivered.
 */
export function isAuthenticApplicationMessage(
  result: ProcessMessageResult & { kind: "applicationMessage" },
  state: ClientState,
  log: Debugger,
  label: string,
): boolean {
  const senderLeafIndex = (result as { senderLeafIndex?: unknown })
    .senderLeafIndex;
  if (senderLeafIndex === undefined) {
    log("reject app message envelope:%s – unattributable sender", label);
    return false;
  }
  try {
    const credential = getCredentialFromLeafIndex(
      state.ratchetTree,
      senderLeafIndex as LeafIndex,
    );
    const senderPubkey = getCredentialPubkey(credential);
    verifyApplicationRumorAuthorship(result.message, senderPubkey);
    return true;
  } catch (error) {
    log("reject app message envelope:%s – %s", label, (error as Error).message);
    return false;
  }
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
    _decryptFailed?: Set<TEnvelope>;
  },
): AsyncGenerator<IngestResult<TEnvelope>> {
  const log = ctx.log.extend(`ingest:${Date.now().toString(36).slice(-5)}`);

  // D-13: once canonical state is the removedFromGroup tombstone, later input
  // for this group is classified `self-evicted` before any per-message work —
  // no peel, no decrypt, no authentication (`protocol-core/member-departure.md`
  // "Realizing removal": such input "need not be decrypted or authenticated").
  // This must be the very first check in the function, ahead of the peel call,
  // so a whole batch short-circuits uniformly regardless of retry state.
  if (ctx.getState().groupActiveState.kind === "removedFromGroup") {
    log(
      "group is removedFromGroup – yielding %d envelope(s) as self-evicted",
      envelopes.length,
    );
    for (const envelope of envelopes) {
      yield { kind: "skipped", envelope, reason: "self-evicted" };
    }
    return;
  }

  const retryCount = options?.retryCount ?? 0;
  const maxRetries = options?.maxRetries ?? 5;
  const errorList: Array<{ envelope: TEnvelope; error: unknown }> =
    options?._errors ?? [];
  // Envelopes deferred this batch (future-epoch / missing-parent commits). They
  // ride the same retry set as `unreadable` so a later pass can apply them once
  // the gap fills, but at a terminal yield they surface as `deferred`, not stale.
  const deferred: Map<TEnvelope, DeferredEntry> =
    options?._deferred ?? new Map();
  // Envelopes whose kind-445 wrapper never opened (peel failures) — retryable,
  // so they surface as `unreadable` with `decryptFailure` set for the pool.
  const decryptFailedAll: Set<TEnvelope> = options?._decryptFailed ?? new Set();

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
      yield terminalResult(envelope, deferred, errorList, decryptFailedAll);
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
    decryptFailedAll.add(envelope);
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
        decryptFailure: true,
      };
    }
    return;
  }

  const unreadable: TEnvelope[] = [...decryptFailed];

  // Content-derived dedup (`inbound-processing.md`): before any MLS processing or
  // convergence classification, drop a message whose content we have already
  // terminally processed (`duplicate`) or that is our own send replayed back in a
  // fresh transport envelope (`own-echo` → reported as `self-echo`). Keyed on the
  // peeled MLS bytes, so a re-wrap with a new Nostr event id is still caught.
  // Intra-batch repeats collapse to the first occurrence as well.
  const batchSeen = new Set<string>();
  const fresh: PeeledMessagePair<TEnvelope>[] = [];
  for (const pair of read) {
    const id = contentDedupId(pair.message);
    const cls = ctx.dedup.classify(pair.message);
    if (cls === "own-echo") {
      log(
        "skip envelope:%s reason:self-echo (own send)",
        envelopeLabel(pair.envelope),
      );
      yield {
        kind: "skipped",
        envelope: pair.envelope,
        message: pair.message,
        reason: "self-echo",
      };
      continue;
    }
    if (cls === "duplicate" || batchSeen.has(id)) {
      log("skip envelope:%s reason:duplicate", envelopeLabel(pair.envelope));
      yield {
        kind: "skipped",
        envelope: pair.envelope,
        message: pair.message,
        reason: "duplicate",
      };
      continue;
    }
    batchSeen.add(id);
    fresh.push(pair);
  }

  let commits: PeeledMessagePair<TEnvelope>[] = [];
  const nonCommits: PeeledMessagePair<TEnvelope>[] = [];

  for (const pair of fresh) {
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
        ctx.recordProposalStaged(result.newState);
        ctx.dedup.remember(message);
        yield { kind: "processed", result, envelope, message };
      } else if (result.kind === "applicationMessage") {
        // The MLS layer has authenticated the sender; advance our ratchet to
        // reflect the consumed generation even if we then drop the payload.
        ctx.setState(result.newState);
        if (
          !isAuthenticApplicationMessage(
            result,
            result.newState,
            log,
            envelopeLabel(envelope),
          )
        ) {
          // M3: forged inner id / author ⇒ invalid_encoding, never delivered.
          yield {
            kind: "skipped",
            envelope,
            message,
            reason: "invalid-app-payload",
          };
          continue;
        }
        // Remember this eager delivery keyed by the branch state it decrypted
        // against (epoch + confirmation tag); a later rewind abandoning this
        // branch retracts it as `invalidated` (M7). An app message advances the
        // ratchet but not the epoch/confirmation tag, so newState identifies the
        // delivery branch.
        ctx.recordDeliveredAppPayload(
          Number(result.newState.groupContext.epoch),
          bytesToHex(result.newState.confirmationTag),
          envelope,
          message,
          result.message,
        );
        ctx.dedup.remember(message);
        log("application message envelope:%s", envelopeLabel(envelope));
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

  const capture = withCapturedProposals(ctx.createAdminCallback());

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
      // Clear any proposals left buffered from a prior message in this loop
      // before processing this one (withCapturedProposals contract).
      capture.take();

      const result = await processMessage({
        context: {
          cipherSuite: ctx.ciphersuite,
          authService: marmotAuthService,
          externalPsks: {},
        },
        state: ctx.getState(),
        message,
        callback: capture.callback,
      });

      const capturedProposals = capture.take();

      if (result.kind === "newState") {
        if (result.actionTaken === "reject") {
          log(
            "commit envelope:%s rejected by admin policy",
            envelopeLabel(envelope),
          );
          ctx.dedup.remember(message);
          yield {
            kind: "rejected",
            result,
            envelope,
            message,
            reason: "admin-policy",
          };
          continue;
        }

        const parentState = ctx.getState();

        // WIRE-03/CONV-01 (D-03): validate the commit's resulting GroupContext
        // AFTER processMessage returns (never inside the callback — Pitfall 1),
        // BEFORE canonical state advances. A violating commit is rejected here
        // and never reaches ctx.setState/ctx.recordCommit.
        const violation = validateCommitLegality({
          parentState,
          resultingState: result.newState,
          proposals: capturedProposals,
        });
        if (violation) {
          log(
            "commit envelope:%s rejected reason:%s detail:%s",
            envelopeLabel(envelope),
            violation.reason,
            violation.detail,
          );
          ctx.dedup.remember(message);
          yield {
            kind: "rejected",
            result,
            envelope,
            message,
            reason: violation.reason,
          };
          continue;
        }

        ctx.setState(result.newState);

        // D-10/D-11: the commit's digest is computed once here and reused for
        // both the notification attribution below and the `removed` branch's
        // own attribution — never a second hashing path over the same bytes.
        const acceptedCommitDigest = commitDigest(
          encode(mlsMessageEncoder, message),
        );
        const notifications = deriveStateNotifications({
          parentState,
          resultingState: result.newState,
          commitDigest: acceptedCommitDigest,
        });

        // The commit removed *us* (an admin's Remove, or a peer committing our
        // own self_remove). State is now the `removedFromGroup` tombstone: no
        // secrets advanced, so nothing else in this batch can be decrypted and
        // retained history is moot. Surface it and stop the generator — there is
        // nothing left to process once we are out (member-departure.md).
        if (result.newState.groupActiveState.kind === "removedFromGroup") {
          log(
            "commit envelope:%s removed us from the group",
            envelopeLabel(envelope),
          );
          ctx.dedup.remember(message);
          // D-10/D-12: the derived list always contains a `selfRemoved` entry
          // on this branch (parent was active, resulting state is the
          // tombstone), alongside `epochAdvanced` and this member's own
          // `memberRemoved` entry, for the same commit.
          ctx.recordStateNotifications(
            acceptedCommitDigest,
            Number(result.newState.groupContext.epoch),
            notifications,
          );
          yield {
            kind: "removed",
            result,
            envelope,
            message,
            notifications,
          };
          return;
        }

        ctx.recordCommit(parentState, message, result.newState);
        ctx.recordStateNotifications(
          acceptedCommitDigest,
          Number(result.newState.groupContext.epoch),
          notifications,
        );
        ctx.dedup.remember(message);
        log(
          "commit envelope:%s applied – new epoch:%d",
          envelopeLabel(envelope),
          ctx.getState().groupContext.epoch,
        );
        yield { kind: "processed", result, envelope, message, notifications };
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
        // The canonical branch we rewound onto may itself have removed us; the
        // winning tip is now live state, so report `removed` rather than
        // `processed` (member-departure.md). The rewind's `invalidated`
        // retractions below are still reported — they are independent.
        if (ctx.getState().groupActiveState.kind === "removedFromGroup") {
          // D-10/D-12: attribute the derived notifications (including
          // `selfRemoved`) to the winning branch's OWN tip commit, not
          // `rep.message` (which is merely the first forkPool entry that
          // triggered this resolution) — the tip commit is the one that
          // actually produced the tombstone. `resolution.notifications` is
          // derived (and ledger-recorded) by `#applyForkResolution`, the same
          // shared rewind-apply path the direct commit branch above uses.
          //
          // WR-18: `notifications` here spans the WHOLE applied winner chain,
          // while `message` is only `rep.message`. This is the one place the
          // per-commit reading of `ProcessedIngestResult`/`RemovedIngestResult`
          // does not hold — consumers must attribute by each entry's
          // `commitDigest`, as those types now document.
          yield {
            kind: "removed",
            result: resolution.result,
            envelope: rep.envelope,
            message: rep.message,
            notifications: resolution.notifications,
          };
        } else {
          yield {
            kind: "processed",
            result: resolution.result,
            envelope: rep.envelope,
            message: rep.message,
            notifications: resolution.notifications,
          };
        }
        for (let i = 1; i < retainedPool.length; i++)
          yield {
            kind: "skipped",
            envelope: retainedPool[i].envelope,
            message: retainedPool[i].message,
            reason: "past-epoch",
          };
        // D-11: withdrawn state notifications are yielded BEFORE the
        // app-payload `invalidated` retractions below, so the two retraction
        // streams have a deterministic relative order within this drainable
        // generator.
        for (const group of groupWithdrawnNotificationsByCommit(
          resolution.withdrawnNotifications,
        )) {
          yield {
            kind: "stateInvalidated",
            commitDigest: group.commitDigest,
            forkEpoch: minForkEpoch,
            withdrawn: group.withdrawn,
          };
        }
        // App payloads delivered on the now-abandoned branch are retracted (M7).
        for (const inv of resolution.invalidated) {
          log(
            "invalidate app payload envelope:%s",
            envelopeLabel(inv.envelope),
          );
          yield {
            kind: "invalidated",
            envelope: inv.envelope,
            message: inv.message,
            payload: inv.payload,
            tag: inv.tag,
            epoch: inv.epoch,
          };
        }
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
          maxRewindCommits: ctx.maxRewindCommits,
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
      yield terminalResult(envelope, deferred, errorList, decryptFailedAll);
    }
    return;
  }

  log("scheduling retry for %d unreadable envelope(s)", unreadable.length);
  yield* ingestEnvelopes(ctx, unreadable, {
    retryCount: retryCount + 1,
    maxRetries,
    _errors: errorList,
    _deferred: deferred,
    _decryptFailed: decryptFailedAll,
  });
}
