/** @module @category Core - Encrypted Media */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClientState } from "ts-mls";

/** Public identity of an MLS source state; contains no exporter material. */
export function mediaSourceStateToken(state: ClientState): string {
  const { groupContext, confirmationTag } = state;
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "marmot/group-parent/v1",
          bytesToHex(groupContext.groupId),
          groupContext.epoch.toString(),
          bytesToHex(confirmationTag),
          bytesToHex(groupContext.treeHash),
          bytesToHex(groupContext.confirmedTranscriptHash),
        ]),
      ),
    ),
  );
}

/** Preparation must be repeated with a fresh nonce after the source changes. */
export class StaleMediaPreparationError extends Error {
  constructor() {
    super(
      "Media source state changed; prepare and upload the attachment again",
    );
    this.name = "StaleMediaPreparationError";
  }
}
