/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { CiphersuiteImpl, ClientState, Proposal } from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  getMarmotGroupView,
  serializeClientState,
  type MarmotGroupView,
  type SerializedClientState,
} from "../../core/client-state.js";
import type { Disposition } from "../../core/inbound.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import type {
  DispositionedIngestResult as EngineDispositionedIngestResult,
  IngestResult as EngineIngestResult,
  PendingState,
  ProposalContext,
} from "../../engine/types.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
import type {
  GroupEffects,
  GroupPublishWork,
  GroupSessionSendIntent,
} from "./group-effects.js";

export type ProcessedIngestResult = {
  kind: "processed";
  result: import("ts-mls").ProcessMessageResult;
  event: NostrEvent;
  message: import("ts-mls").MlsMessage;
};

export type RejectedIngestResult = {
  kind: "rejected";
  result: import("ts-mls").ProcessMessageResult;
  event: NostrEvent;
  message: import("ts-mls").MlsMessage;
};

export type SkippedIngestResult = {
  kind: "skipped";
  event: NostrEvent;
  message: import("ts-mls").MlsMessage;
  reason:
    | "past-epoch"
    | "wrong-wireformat"
    | "self-echo"
    | "beyond-anchor"
    | "missing-retained-anchor"
    | "invalid-app-payload";
};

export type UnreadableIngestResult = {
  kind: "unreadable";
  event: NostrEvent;
  errors: unknown[];
};

export type DeferredIngestResult = {
  kind: "deferred";
  event: NostrEvent;
  message: import("ts-mls").MlsMessage;
  reason: import("../../core/inbound.js").DeferredReason;
};

export type InvalidatedIngestResult = {
  kind: "invalidated";
  event: NostrEvent;
  message: import("ts-mls").MlsMessage;
};

export type IngestResult =
  | ProcessedIngestResult
  | RejectedIngestResult
  | SkippedIngestResult
  | DeferredIngestResult
  | InvalidatedIngestResult
  | UnreadableIngestResult;

export type DispositionedIngestResult = IngestResult & {
  disposition: Disposition;
};

export interface GroupSessionHistory {
  saveMessage(message: Uint8Array): Promise<void>;
  purgeMessages(): Promise<void>;
}

export type GroupSessionOptions<
  THistory extends GroupSessionHistory | undefined = undefined,
> = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  store: GenericKeyValueStore<SerializedClientState>;
  history?: THistory;
  onStateChanged?: (state: ClientState) => void;
  onStateSaved?: () => void;
  onApplicationMessage?: (message: Uint8Array) => void;
  onHistoryError?: (error: Error) => void;
};

export function ingestResultDisposition(result: IngestResult): Disposition {
  const { event, ...rest } = result;
  return engineIngestResultDisposition({
    ...rest,
    envelope: event,
  } as EngineIngestResult<NostrEvent>);
}

function mapEngineIngestResult(
  result: EngineDispositionedIngestResult<NostrEvent>,
): DispositionedIngestResult {
  const { envelope, disposition, ...rest } = result;
  return { ...rest, event: envelope, disposition };
}

export class GroupSession<
  THistory extends GroupSessionHistory | undefined = undefined,
> {
  readonly ciphersuite: CiphersuiteImpl;
  readonly store: GenericKeyValueStore<SerializedClientState>;
  readonly history: THistory;

  readonly #engine: MarmotGroupEngine<NostrEvent>;
  readonly #peeler: NostrGroupPeeler;
  readonly #sentEventIds = new Set<string>();

  #groupData: MarmotGroupView | null = null;
  #dirty = false;

  readonly #onStateChanged?: (state: ClientState) => void;
  readonly #onStateSaved?: () => void;
  readonly #onApplicationMessage?: (message: Uint8Array) => void;
  readonly #onHistoryError?: (error: Error) => void;

  constructor(options: GroupSessionOptions<THistory>) {
    this.ciphersuite = options.ciphersuite;
    this.store = options.store;
    this.history = options.history as THistory;
    this.#onStateChanged = options.onStateChanged;
    this.#onStateSaved = options.onStateSaved;
    this.#onApplicationMessage = options.onApplicationMessage;
    this.#onHistoryError = options.onHistoryError;

    this.#peeler = new NostrGroupPeeler(this.ciphersuite);
    this.#engine = new MarmotGroupEngine({
      state: options.state,
      ciphersuite: this.ciphersuite,
      peeler: this.#peeler,
      onStateChanged: (newState) => {
        this.#dirty = true;
        this.#groupData = null;
        this.#onStateChanged?.(newState);
      },
    });
  }

  get id(): Uint8Array {
    return this.state.groupContext.groupId;
  }

  get state(): ClientState {
    return this.#engine.state;
  }

  set state(newState: ClientState) {
    this.#engine.state = newState;
  }

  get lifecycle() {
    return this.#engine.lifecycle;
  }

  get groupData(): MarmotGroupView | null {
    if (!this.#groupData) this.#groupData = getMarmotGroupView(this.state);
    return this.#groupData;
  }

  get relays(): string[] | undefined {
    return this.groupData?.relays;
  }

  get unappliedProposals() {
    return this.state.unappliedProposals;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  async save(force = false): Promise<void> {
    if (!force && !this.#dirty) return;

    const stateBytes = serializeClientState(this.state);
    await this.store.setItem(bytesToHex(this.id), stateBytes);
    this.#dirty = false;
    this.#onStateSaved?.();
  }

  async destroyLocalState(): Promise<void> {
    await this.history?.purgeMessages();
    await this.store.removeItem(bytesToHex(this.id));
  }

  confirmPublished(pending: PendingState): void {
    this.#engine.confirmPublished(pending);
  }

  publishFailed(pending: PendingState): void {
    this.#engine.publishFailed(pending);
  }

  proposalContext(): ProposalContext {
    const groupData = this.groupData;
    if (!groupData)
      throw new Error("MarmotGroupData not found in ClientState.");
    return { state: this.state, ciphersuite: this.ciphersuite, groupData };
  }

  async send(intent: GroupSessionSendIntent): Promise<GroupEffects> {
    switch (intent.kind) {
      case "applicationMessage": {
        const sendResult = await this.#engine.send({
          kind: "applicationMessage",
          payload: intent.payload,
        });
        this.#sentEventIds.add(sendResult.envelope.id);
        await this.#saveHistory(intent.payload);
        return {
          publish: [
            { kind: "applicationMessage", envelope: sendResult.envelope },
          ],
        };
      }

      case "proposal": {
        const sendResult = await this.#engine.send({
          kind: "proposal",
          proposal: intent.proposal,
        });
        if (sendResult.kind !== "proposal") {
          throw new Error("Expected proposal result from proposal send");
        }
        return {
          publish: [
            {
              kind: "proposal",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
            },
          ],
        };
      }

      case "selfUpdate": {
        const sendResult = await this.#engine.send({ kind: "selfUpdate" });
        if (sendResult.kind !== "selfUpdate") {
          throw new Error("Expected selfUpdate result from selfUpdate send");
        }
        return {
          publish: [
            {
              kind: "selfUpdate",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
            },
          ],
        };
      }

      case "commit": {
        const sendResult = await this.#engine.send({
          kind: "commit",
          actorPubkey: intent.actorPubkey,
          extraProposals: intent.extraProposals,
          proposalRefs: intent.proposalRefs,
        });
        if (sendResult.kind !== "groupEvolution") {
          throw new Error("Expected groupEvolution result from commit send");
        }
        return {
          publish: [
            {
              kind: "groupEvolution",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
              actorPubkey: intent.actorPubkey,
              welcome: sendResult.welcome,
              welcomeRecipients: intent.welcomeRecipients,
            },
          ],
        };
      }
    }
  }

  /**
   * Builds the self-remove proposal effects for leaving the group.
   *
   * Per RFC 9420 §12.4 a member cannot *commit* a Remove targeting their own
   * leaf, so this emits self-remove proposal(s) for the next committer (e.g.
   * an admin) to apply. Modelled as a send-intent — the darkmatter engine
   * exposes the same operation as `do_send_leave` rather than letting callers
   * hand-build the proposals.
   *
   * @param ownPubkey - The leaving member's Nostr public key (hex string).
   * @returns Publishable proposal effects (one per owned leaf node).
   */
  async leave(ownPubkey: string): Promise<GroupEffects> {
    const removeProposals = await proposeLeaveGroup(ownPubkey)(
      this.proposalContext(),
    );

    const publish: GroupPublishWork[] = [];
    for (const proposal of removeProposals) {
      const sendResult = await this.#engine.send({
        kind: "proposal",
        proposal,
      });
      if (sendResult.kind !== "proposal") {
        throw new Error("Expected proposal result from leave send");
      }
      publish.push({
        kind: "proposal",
        envelope: sendResult.envelope,
        pending: sendResult.pending,
      });
    }
    return { publish };
  }

  async *ingest(
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    const selfEcho: NostrEvent[] = [];
    const rest: NostrEvent[] = [];

    for (const event of events) {
      if (this.#sentEventIds.delete(event.id)) selfEcho.push(event);
      else rest.push(event);
    }

    for (const event of selfEcho) {
      const peeled = await this.#peeler.peelGroupMessages([event], this.state);
      const message = peeled.read[0]?.message;
      if (message) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          message,
          reason: "self-echo",
        };
        yield { ...skipped, disposition: ingestResultDisposition(skipped) };
      }
    }

    for await (const result of this.#engine.ingest(rest, options)) {
      const mapped = mapEngineIngestResult(result);

      if (
        mapped.kind === "processed" &&
        mapped.result.kind === "applicationMessage"
      ) {
        await this.#saveHistory(mapped.result.message);
        this.#onApplicationMessage?.(mapped.result.message);
      }

      yield mapped;
    }

    await this.save();
  }

  async #saveHistory(message: Uint8Array): Promise<void> {
    if (!this.history) return;
    try {
      await this.history.saveMessage(message);
    } catch (err) {
      this.#onHistoryError?.(err as Error);
    }
  }
}

export type ProposalBuilder<
  Args extends unknown[],
  T extends Proposal | Proposal[],
> = (...args: Args) => import("../../engine/types.js").ProposalAction<T>;
