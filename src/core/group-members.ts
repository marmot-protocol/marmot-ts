/** @module @category Core - Group Members */
import {
  ClientState,
  Credential,
  defaultCredentialTypes,
  getGroupMembers as getMlsGroupMembers,
  LeafNode,
  nodeTypes,
} from "ts-mls";
import { getCredentialPubkey, isSameCredential } from "./credential.js";

function nodeToLeafIndex(nodeIndex: number): number {
  // This matches ts-mls treemath: nodeToLeafIndex(nodeIndex) = nodeIndex / 2
  // for leaf positions in the ratchet tree.
  return Math.floor(nodeIndex / 2);
}

/**
 * Gets all the nostr pubkey keys in a group.
 *
 * WR-15: a leaf whose identity is not a valid 32-byte hex key is SKIPPED, not
 * thrown on. Filtering on `credentialType` alone is not enough — a basic
 * credential can still carry a malformed identity, and `getCredentialPubkey`
 * throws for one. `marmotAuthService.validateCredential` gates identities on
 * the inbound path, but a state hydrated from a Welcome or a `ratchet_tree`
 * extension is not covered by that gate. Callers here (notably
 * `deriveStateNotifications`, run per link of an applied rewind AFTER state
 * has already advanced) treat this as an enumeration, so one unparseable leaf
 * must not abort the whole enumeration — and such a leaf is not a valid
 * Marmot member in the first place.
 */
export function getGroupMembers(state: ClientState): string[] {
  const pubkeys = new Set<string>();
  for (const leaf of getMlsGroupMembers(state)) {
    if (leaf.credential.credentialType !== defaultCredentialTypes.basic)
      continue;
    try {
      pubkeys.add(getCredentialPubkey(leaf.credential));
    } catch {
      // Not a valid Marmot account identity — skip this leaf.
    }
  }
  return Array.from(pubkeys);
}

/** Gets all leaf nodes for a given nostr pubkey in a group */
export function getPubkeyLeafNodes(
  state: ClientState,
  pubkey: string,
): LeafNode[] {
  const leaves: LeafNode[] = [];
  for (const node of state.ratchetTree) {
    if (
      !node ||
      node.nodeType !== nodeTypes.leaf ||
      node.leaf.credential.credentialType !== defaultCredentialTypes.basic
    )
      continue;
    try {
      if (getCredentialPubkey(node.leaf.credential) === pubkey)
        leaves.push(node.leaf);
    } catch {
      // Not a valid Marmot account identity — skip this leaf.
    }
  }
  return leaves;
}

/**
 * Gets all leaf node indexes for a given nostr pubkey in a group.
 *
 * @param state - The ClientState to search
 * @param pubkey - The nostr pubkey to find
 * @returns Array of leaf node indexes (numbers) for the given pubkey
 */
export function getPubkeyLeafNodeIndexes(
  state: ClientState,
  pubkey: string,
): number[] {
  const leafIndexes: number[] = [];

  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
    const node = state.ratchetTree[nodeIndex];
    if (
      node &&
      node.nodeType === nodeTypes.leaf &&
      node.leaf.credential.credentialType === defaultCredentialTypes.basic
    ) {
      try {
        if (getCredentialPubkey(node.leaf.credential) === pubkey)
          leafIndexes.push(Number(nodeToLeafIndex(nodeIndex)));
      } catch {
        // Not a valid Marmot account identity — skip this leaf.
      }
    }
  }

  return leafIndexes;
}

/**
 * Gets all leaf node indexes for a given credential in a group.
 *
 * @param state - The ClientState to search
 * @param credential - The credential to find
 * @returns Array of leaf node indexes (numbers) for the given credential
 */
export function getCredentialLeafNodeIndexes(
  state: ClientState,
  credential: Credential,
): number[] {
  const leafIndexes: number[] = [];

  for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
    const node = state.ratchetTree[nodeIndex];
    if (node && node.nodeType === nodeTypes.leaf) {
      if (isSameCredential(node.leaf.credential, credential))
        leafIndexes.push(Number(nodeToLeafIndex(nodeIndex)));
    }
  }

  return leafIndexes;
}
