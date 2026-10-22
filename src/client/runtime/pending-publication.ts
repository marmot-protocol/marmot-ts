/** Durable exact-byte recovery for acknowledgement-uncertain commits. */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
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
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import type { PublishResponse } from "../nostr-interface.js";
import type { GroupPublishWork } from "../session/group-effects.js";

type CommitWork = Extract<
  GroupPublishWork,
  { kind: "groupEvolution" | "selfUpdate" }
>;
export function pendingPublicationKey(groupId: string): string {
  return `${groupId}/pending-publication/v1`;
}

export interface PendingPublication {
  work: CommitWork;
  relays: string[];
  acknowledged: boolean;
  uncertain?: boolean;
  response?: Record<string, PublishResponse>;
}

/** Local storage is trusted to the same extent as the canonical MLS state store. */
export class PendingPublicationStore {
  readonly #key: string;
  constructor(
    readonly store: GenericKeyValueStore<Uint8Array>,
    groupId: string,
  ) {
    this.#key = pendingPublicationKey(groupId);
  }
  async read(): Promise<PendingPublication | undefined> {
    const bytes = await this.store.getItem(this.#key);
    if (!bytes) return undefined;
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      (_key, item) =>
        item &&
        typeof item === "object" &&
        Object.keys(item).length === 1 &&
        typeof item.$bytes === "string"
          ? hexToBytes(item.$bytes)
          : item,
    );
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
    await this.store.setItem(
      this.#key,
      new TextEncoder().encode(
        JSON.stringify(stored, (_key, item) =>
          item instanceof Uint8Array ? { $bytes: bytesToHex(item) } : item,
        ),
      ),
    );
  }
  async clear(): Promise<void> {
    await this.store.removeItem(this.#key);
  }
}
