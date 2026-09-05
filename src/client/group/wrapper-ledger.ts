import type { GenericKeyValueStore } from "../../utils/key-value.js";

export type TerminalWrapperOutcome =
  | "accepted"
  | "stale"
  | "invalidated";

type StoredTerminalWrapperV1 = {
  version: 1;
  outcome: TerminalWrapperOutcome;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Durable, group-scoped record of verified transport wrappers handled terminally. */
export class TerminalWrapperLedger {
  constructor(
    readonly store: GenericKeyValueStore<Uint8Array>,
    readonly groupId: string,
  ) {}

  #key(eventId: string): string {
    return `${this.groupId}/ingest/wrapper/v1/${eventId}`;
  }

  async get(eventId: string): Promise<TerminalWrapperOutcome | undefined> {
    const bytes = await this.store.getItem(this.#key(eventId));
    if (!bytes) return undefined;
    try {
      const value = JSON.parse(decoder.decode(bytes)) as StoredTerminalWrapperV1;
      if (
        value.version === 1 &&
        (value.outcome === "accepted" ||
          value.outcome === "stale" ||
          value.outcome === "invalidated")
      )
        return value.outcome;
    } catch {
      // Corrupt evidence is ignored; the verified wrapper remains processable.
    }
    return undefined;
  }

  async record(eventId: string, outcome: TerminalWrapperOutcome): Promise<void> {
    const value: StoredTerminalWrapperV1 = { version: 1, outcome };
    await this.store.setItem(this.#key(eventId), encoder.encode(JSON.stringify(value)));
  }
}
