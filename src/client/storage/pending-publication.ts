/** Durable exact-byte recovery for acknowledgement-uncertain commits. */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
  type MlsWelcomeMessage,
} from "ts-mls";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { defaultVerifyEvent, safeVerifyEvent } from "../verify.js";
import type { GroupRecordStore } from "./database/group-batch.js";
import type {
  OwnCommitStampRecord,
  PublicationRecord,
} from "./database/types.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { GroupPublishWork } from "../session/group-effects.js";
import type { PendingState } from "../../engine/types.js";
import type { OwnCommitConvergenceStamp } from "../../engine/own-commit-stamp.js";

type CommitWork = Extract<
  GroupPublishWork,
  { kind: "groupEvolution" | "selfUpdate" }
>;

export interface PendingPublication {
  work: CommitWork;
  relays: string[];
  acknowledged: boolean;
  uncertain?: boolean;
  response?: Record<string, PublishResponse>;
}

const HEX = /^(?:[a-f0-9]{2})*$/;
const HEX_32 = /^[a-f0-9]{64}$/;

function invalid(): never {
  throw new Error("Invalid pending publication record");
}

function stampToRecord(stamp: OwnCommitConvergenceStamp): OwnCommitStampRecord {
  return {
    committer: stamp.committer,
    priority: stamp.priority,
    consumedProposalRefs: stamp.consumedProposalRefs.map(bytesToHex).sort(),
  };
}

function stampFromRecord(
  record: OwnCommitStampRecord,
): OwnCommitConvergenceStamp {
  if (
    !record ||
    typeof record.committer !== "string" ||
    (record.priority !== "privileged" && record.priority !== "ordinary") ||
    !Array.isArray(record.consumedProposalRefs) ||
    !record.consumedProposalRefs.every(
      (ref) => typeof ref === "string" && HEX.test(ref),
    )
  )
    invalid();
  return {
    committer: record.committer,
    priority: record.priority,
    consumedProposalRefs: record.consumedProposalRefs.map(hexToBytes),
  };
}

/**
 * The pending commit publication, kept in the group record's `publication`
 * field. Local storage is trusted to the same extent as the canonical MLS
 * state store.
 */
export class PendingPublicationStore {
  constructor(readonly store: GroupRecordStore) {}

  async read(): Promise<PendingPublication | undefined> {
    const value = (await this.store.get()).publication;
    if (!value) return undefined;
    if (
      !value ||
      typeof value !== "object" ||
      !["groupEvolution", "selfUpdate"].includes(value.kind) ||
      !value.pending ||
      !["commit", "selfUpdate"].includes(value.pending.kind) ||
      !Array.isArray(value.relays) ||
      !value.relays.length ||
      !value.relays.every((r: unknown) => typeof r === "string") ||
      typeof value.acknowledged !== "boolean"
    )
      invalid();
    const stored = value.pending;
    if (
      !(stored.parentState instanceof Uint8Array) ||
      !(stored.newState instanceof Uint8Array) ||
      !(stored.commitMessage instanceof Uint8Array)
    )
      throw new Error("Invalid pending publication bytes");
    const evidence = stored.terminalEvidence;
    if (
      evidence !== undefined &&
      (!evidence ||
        typeof evidence.commitDigest !== "string" ||
        !HEX_32.test(evidence.commitDigest) ||
        typeof evidence.actorPubkey !== "string" ||
        !Number.isSafeInteger(evidence.sourceEpoch) ||
        typeof evidence.parentTag !== "string" ||
        evidence.terminalOutcome !== "disbanded")
    )
      invalid();
    const message = decode(mlsMessageDecoder, stored.commitMessage);
    if (
      !message ||
      !value.envelope?.id ||
      !safeVerifyEvent(defaultVerifyEvent, value.envelope)
    )
      throw new Error("Invalid pending publication bytes");
    const pending: PendingState = {
      kind: stored.kind,
      newState: deserializeClientState(stored.newState),
      parentState: deserializeClientState(stored.parentState),
      commitMessage: message,
      ...(stored.ownCommitStamp && {
        ownCommitStamp: stampFromRecord(stored.ownCommitStamp),
      }),
      ...(evidence && {
        terminalEvidence: {
          commitDigest: hexToBytes(evidence.commitDigest),
          actorPubkey: evidence.actorPubkey,
          sourceEpoch: evidence.sourceEpoch,
          parentTag: evidence.parentTag,
          terminalOutcome: "disbanded" as const,
        },
      }),
    };
    let work: CommitWork;
    if (value.kind === "groupEvolution") {
      let welcome: MlsWelcomeMessage | undefined;
      if (value.welcome) {
        if (!(value.welcome instanceof Uint8Array))
          throw new Error("Invalid pending Welcome");
        const decoded = decode(mlsMessageDecoder, value.welcome);
        if (decoded?.wireformat !== wireformats.mls_welcome)
          throw new Error("Invalid pending Welcome");
        welcome = decoded as MlsWelcomeMessage;
      }
      work = {
        kind: "groupEvolution",
        envelope: value.envelope,
        pending,
        welcome,
        actorPubkey: value.actorPubkey as string,
        welcomeRecipients: value.welcomeRecipients,
      };
    } else {
      work = { kind: "selfUpdate", envelope: value.envelope, pending };
    }
    if (
      value.acknowledged &&
      (!value.response ||
        !Object.entries(value.response).some(
          ([url, r]) => value.relays.includes(url) && r?.ok,
        ))
    )
      throw new Error("Missing retained publication acknowledgement");
    return {
      work,
      relays: value.relays,
      acknowledged: value.acknowledged,
      response: value.response,
      uncertain: !value.acknowledged,
    };
  }

  async write(record: PendingPublication): Promise<void> {
    const { work } = record;
    const pending = work.pending;
    if (!pending.parentState || !pending.commitMessage)
      throw new Error("Missing pending commit recovery state");
    if (pending.kind === "proposal")
      throw new Error("Invalid pending commit kind");
    const evidence = pending.terminalEvidence;
    const publication: PublicationRecord = {
      kind: work.kind,
      envelope: work.envelope,
      pending: {
        kind: pending.kind,
        parentState: serializeClientState(pending.parentState),
        newState: serializeClientState(pending.newState),
        commitMessage: encode(mlsMessageEncoder, pending.commitMessage),
        ...(pending.ownCommitStamp && {
          ownCommitStamp: stampToRecord(pending.ownCommitStamp),
        }),
        ...(evidence && {
          terminalEvidence: {
            commitDigest: bytesToHex(evidence.commitDigest),
            actorPubkey: evidence.actorPubkey,
            sourceEpoch: evidence.sourceEpoch,
            parentTag: evidence.parentTag,
            terminalOutcome: evidence.terminalOutcome,
          },
        }),
      },
      relays: [...record.relays],
      acknowledged: record.acknowledged,
      ...(record.response && { response: { ...record.response } }),
    };
    if (work.kind === "groupEvolution") {
      if (work.welcome)
        publication.welcome = encode(mlsMessageEncoder, work.welcome);
      publication.actorPubkey = work.actorPubkey;
      if (work.welcomeRecipients)
        publication.welcomeRecipients = work.welcomeRecipients.map(
          (recipient) => ({
            pubkey: recipient.pubkey,
            keyPackageEventId: recipient.keyPackageEventId,
            keyPackageEvent: recipient.keyPackageEvent,
          }),
        );
    }
    await this.store.update({ publication });
  }

  async clear(): Promise<void> {
    await this.store.update({ publication: null });
  }
}
