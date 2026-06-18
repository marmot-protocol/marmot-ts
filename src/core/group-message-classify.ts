/** @module @category Core - Group Messages */
import {
  contentTypes,
  encode,
  mlsMessageEncoder,
  type MlsMessage,
  wireformats,
} from "ts-mls";
import {
  commitDigest,
  compareCommitOrderingKeys,
  type CommitOrderingKey,
} from "./convergence.js";
import type { GroupMessagePair } from "./group-message-crypto.js";

/**
 * Orders group commits by the content-derived convergence key
 * (`protocol-core/convergence.md`): by MLS source epoch ascending, then by the
 * lower `commit_digest = SHA-256(MLS message bytes)`. For a same-epoch race the
 * lowest commit digest wins.
 *
 * Transport arrival order, transport timestamps (`created_at`), and outer event
 * ids MUST NOT participate in this ordering — every member computes the same
 * order from the same MLS bytes, which is what makes convergence deterministic
 * across implementations.
 *
 * @param commits - Array of commit message pairs to order
 * @returns A new array ordered by the convergence key
 */
export function sortGroupCommits(
  commits: GroupMessagePair[],
): GroupMessagePair[] {
  const keyed = commits.map((pair) => {
    const sourceEpoch =
      pair.message.wireformat === wireformats.mls_private_message
        ? Number(pair.message.privateMessage.epoch)
        : 0;
    const key: CommitOrderingKey = {
      sourceEpoch,
      // commit_digest is over the serialized MLS message bytes; ts-mls TLS
      // encoding is canonical, so this matches the transmitted commit bytes.
      commitDigest: commitDigest(encode(mlsMessageEncoder, pair.message)),
    };
    return { pair, key };
  });
  keyed.sort((a, b) => compareCommitOrderingKeys(a.key, b.key));
  return keyed.map((entry) => entry.pair);
}

/**
 * Checks if a message is an application message (not a proposal or commit).
 */
export function isApplicationMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  if (pair.message.wireformat !== wireformats.mls_private_message) return false;
  return pair.message.privateMessage.contentType === contentTypes.application;
}

/**
 * Checks if a message is a commit message.
 */
export function isCommitMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  if (pair.message.wireformat !== wireformats.mls_private_message) return false;
  return pair.message.privateMessage.contentType === contentTypes.commit;
}

/**
 * Checks if a message is a proposal message.
 */
export function isProposalMessage(
  pair: GroupMessagePair,
): pair is GroupMessagePair & {
  message: MlsMessage & { wireformat: typeof wireformats.mls_private_message };
} {
  if (pair.message.wireformat !== wireformats.mls_private_message) return false;
  return pair.message.privateMessage.contentType === contentTypes.proposal;
}
