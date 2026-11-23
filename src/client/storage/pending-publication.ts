/** Durable exact-byte recovery for acknowledgement-uncertain commits. */
import {
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from "ts-mls";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { defaultVerifyEvent, safeVerifyEvent } from "../verify.js";
import type { GroupMetaStore } from "./database/group-batch.js";
import { decodeRecord, encodeRecord } from "./record-codec.js";
import { groupKeys } from "./storage-keys.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { GroupPublishWork } from "../session/group-effects.js";

type CommitWork = Extract<
  GroupPublishWork,
  { kind: "groupEvolution" | "selfUpdate" }
>;
/** Group-database meta key of the pending commit publication. */
export const PENDING_PUBLICATION_KEY = groupKeys.publication;

export interface PendingPublication {
  work: CommitWork;
  relays: string[];
  acknowledged: boolean;
  uncertain?: boolean;
  response?: Record<string, PublishResponse>;
}

/** Local storage is trusted to the same extent as the canonical MLS state store. */
export class PendingPublicationStore {
  readonly #key = PENDING_PUBLICATION_KEY;
  constructor(readonly store: GroupMetaStore) {}
  async read(): Promise<PendingPublication | undefined> {
    const bytes = await this.store.get(this.#key);
    if (!bytes) return undefined;
    const value = decodeRecord<any>(bytes);
    if (
      value.version !== 1 ||
      !["groupEvolution", "selfUpdate"].includes(value.work?.kind) ||
      !Array.isArray(value.relays) ||
      !value.relays.length ||
      !value.relays.every((r: unknown) => typeof r === "string") ||
      typeof value.acknowledged !== "boolean"
    )
      throw new Error("Invalid pending publication record");
    const { work } = value;
    work.pending.newState = deserializeClientState(work.pending.newState);
    work.pending.parentState = deserializeClientState(work.pending.parentState);
    const message = decode(mlsMessageDecoder, work.pending.commitMessage);
    if (
      !message ||
      !work.envelope?.id ||
      !safeVerifyEvent(defaultVerifyEvent, work.envelope)
    )
      throw new Error("Invalid pending publication bytes");
    work.pending.commitMessage = message;
    if (work.welcome) {
      work.welcome = decode(mlsMessageDecoder, work.welcome);
      if (work.welcome?.wireformat !== wireformats.mls_welcome)
        throw new Error("Invalid pending Welcome");
    }
    if (
      value.acknowledged &&
      (!value.response ||
        !Object.entries(value.response).some(
          ([url, r]) => value.relays.includes(url) && (r as PublishResponse).ok,
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
    if (!work.pending.parentState || !work.pending.commitMessage)
      throw new Error("Missing pending commit recovery state");
    const stored = {
      version: 1,
      ...record,
      work: {
        ...work,
        signal: undefined,
        welcome:
          "welcome" in work && work.welcome
            ? encode(mlsMessageEncoder, work.welcome)
            : undefined,
        pending: {
          ...work.pending,
          parentState: serializeClientState(work.pending.parentState),
          newState: serializeClientState(work.pending.newState),
          commitMessage: encode(mlsMessageEncoder, work.pending.commitMessage),
        },
      },
    };
    await this.store.set(this.#key, encodeRecord(stored));
  }
  async clear(): Promise<void> {
    await this.store.delete(this.#key);
  }
}
