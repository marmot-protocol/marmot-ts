/** @module @category Core - App Components */
import {
  appDataUpdateProposalType,
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  nodeTypes,
  type ClientState,
  type GroupContextExtension,
  type LeafIndex,
  type ProposalWithSender,
} from "ts-mls";

import { getCredentialPubkey } from "../credential.js";
import { bytesEqual } from "./bytes.js";
import {
  getAdminPolicy,
  getAppComponents,
  getGroupLifecycle,
} from "./dictionary.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
} from "./ids.js";
import { encodeAdminPolicyV1 } from "./admin-policy.js";
import { encodeComponentsList } from "./app-components-list.js";
import { encodeGroupLifecycleV1 } from "./group-lifecycle.js";

export type DisbandClassification =
  | { kind: "notDisband" }
  | { kind: "validDisband"; actorPubkey: string }
  | { kind: "validEnablement"; actorPubkey: string }
  | { kind: "violation"; detail: string };

function violation(detail: string): DisbandClassification {
  return { kind: "violation", detail };
}

function leafIndexes(state: ClientState): number[] {
  const indexes: number[] = [];
  for (
    let nodeIndex = 0;
    nodeIndex < state.ratchetTree.length;
    nodeIndex += 2
  ) {
    const node = state.ratchetTree[nodeIndex];
    if (node?.nodeType === nodeTypes.leaf) indexes.push(nodeIndex / 2);
  }
  return indexes;
}

function actorOf(state: ClientState, leafIndex: number): string | undefined {
  try {
    return getCredentialPubkey(
      getCredentialFromLeafIndex(state.ratchetTree, leafIndex as LeafIndex),
    );
  } catch {
    return undefined;
  }
}

function updateBytes(
  proposal: ProposalWithSender,
  componentId: number,
): Uint8Array | undefined {
  if (
    proposal.proposal.proposalType !== appDataUpdateProposalType ||
    !("appDataUpdate" in proposal.proposal) ||
    proposal.proposal.appDataUpdate.componentId !== componentId ||
    proposal.proposal.appDataUpdate.operation !== "update"
  )
    return undefined;
  return proposal.proposal.appDataUpdate.update;
}

/** Classifies lifecycle enablement and terminal commits against their authenticated parent. */
export function classifyDisbandCommit(args: {
  parentState: ClientState;
  resultingState: ClientState;
  proposals: readonly ProposalWithSender[];
  committerLeafIndex: number | undefined;
}): DisbandClassification {
  let parentLifecycle: ReturnType<typeof getGroupLifecycle>;
  let resultingLifecycle: ReturnType<typeof getGroupLifecycle>;
  let parentRequired: number[];
  let resultingRequired: number[];
  try {
    parentLifecycle = getGroupLifecycle(
      args.parentState.groupContext.extensions,
    );
    resultingLifecycle = getGroupLifecycle(
      args.resultingState.groupContext.extensions,
    );
    parentRequired =
      getAppComponents(args.parentState.groupContext.extensions) ?? [];
    resultingRequired =
      getAppComponents(args.resultingState.groupContext.extensions) ?? [];
  } catch {
    return violation("lifecycle or required-component state did not decode");
  }

  const parentRequires = parentRequired.includes(GROUP_LIFECYCLE_COMPONENT_ID);
  let resultRequires = resultingRequired.includes(GROUP_LIFECYCLE_COMPONENT_ID);
  // ts-mls exposes a removed receiver as a tombstone carrying the authenticated
  // parent GroupContext, not the post-Commit roster/context. The exact inline
  // proposal set below is therefore the only available resulting-state evidence
  // on that receiver; MLS acceptance has already authenticated those bytes.
  const receiverRemoved =
    args.resultingState.groupActiveState?.kind === "removedFromGroup";
  const touchesLifecycle = args.proposals.some(
    (proposal) =>
      updateBytes(proposal, GROUP_LIFECYCLE_COMPONENT_ID) !== undefined ||
      (proposal.proposal.proposalType === appDataUpdateProposalType &&
        "appDataUpdate" in proposal.proposal &&
        proposal.proposal.appDataUpdate.componentId ===
          GROUP_LIFECYCLE_COMPONENT_ID),
  );
  if (receiverRemoved && touchesLifecycle) {
    resultRequires = parentRequires;
    resultingLifecycle = "disbanded";
  }
  if (
    !touchesLifecycle &&
    parentLifecycle === resultingLifecycle &&
    parentRequires === resultRequires
  )
    return { kind: "notDisband" };

  if (args.committerLeafIndex === undefined)
    return violation(
      "lifecycle transition has no authenticated member committer",
    );
  const actorPubkey = actorOf(args.parentState, args.committerLeafIndex);
  if (!actorPubkey)
    return violation("lifecycle committer credential is invalid");
  let parentAdmins: string[];
  try {
    parentAdmins =
      getAdminPolicy(args.parentState.groupContext.extensions) ?? [];
  } catch {
    return violation("parent admin-policy component did not decode");
  }
  if (!parentAdmins.includes(actorPubkey))
    return violation("lifecycle transition committer is not a parent admin");

  if (!parentRequires) {
    if (parentLifecycle !== undefined)
      return violation("legacy lifecycle state exists without being required");
    if (resultingLifecycle !== "active" || !resultRequires)
      return violation(
        "legacy lifecycle enablement must atomically add active and required state",
      );
    if (args.proposals.length !== 2)
      return violation(
        "legacy lifecycle enablement contains an unrelated proposal",
      );
    const requiredUpdate = args.proposals.find(
      (proposal) =>
        updateBytes(proposal, APP_COMPONENTS_COMPONENT_ID) !== undefined,
    );
    const lifecycleUpdate = args.proposals.find(
      (proposal) =>
        updateBytes(proposal, GROUP_LIFECYCLE_COMPONENT_ID) !== undefined,
    );
    if (
      !requiredUpdate ||
      !lifecycleUpdate ||
      requiredUpdate.senderLeafIndex !== args.committerLeafIndex ||
      lifecycleUpdate.senderLeafIndex !== args.committerLeafIndex ||
      !bytesEqual(
        updateBytes(requiredUpdate, APP_COMPONENTS_COMPONENT_ID),
        encodeComponentsList(resultingRequired),
      ) ||
      !bytesEqual(
        updateBytes(lifecycleUpdate, GROUP_LIFECYCLE_COMPONENT_ID),
        encodeGroupLifecycleV1("active"),
      )
    )
      return violation(
        "legacy lifecycle enablement must use exact inline replacements",
      );
    for (const index of leafIndexes(args.resultingState)) {
      const node = args.resultingState.ratchetTree[index * 2];
      try {
        if (
          node?.nodeType !== nodeTypes.leaf ||
          !(
            getAppComponents(
              node.leaf.extensions as unknown as GroupContextExtension[],
            ) ?? []
          ).includes(GROUP_LIFECYCLE_COMPONENT_ID)
        )
          return violation(
            "resulting member does not advertise lifecycle support",
          );
      } catch {
        return violation("resulting member capability state did not decode");
      }
    }
    return { kind: "validEnablement", actorPubkey };
  }

  if (!resultRequires || resultingLifecycle !== "disbanded")
    return violation(
      "required lifecycle state is absorbing and may only become disbanded",
    );
  if (parentLifecycle !== "active")
    return violation("disband requires an active lifecycle parent");

  const expectedRemovals = leafIndexes(args.parentState).filter(
    (index) => index !== args.committerLeafIndex,
  );
  const removals: number[] = [];
  let lifecycleUpdates = 0;
  let adminUpdates = 0;
  for (const proposal of args.proposals) {
    if (
      proposal.proposal.proposalType === defaultProposalTypes.remove &&
      "remove" in proposal.proposal
    ) {
      removals.push(Number(proposal.proposal.remove.removed));
      continue;
    }
    const lifecycle = updateBytes(proposal, GROUP_LIFECYCLE_COMPONENT_ID);
    if (lifecycle !== undefined) {
      if (
        proposal.senderLeafIndex !== args.committerLeafIndex ||
        !bytesEqual(lifecycle, encodeGroupLifecycleV1("disbanded"))
      )
        return violation(
          "disband lifecycle replacement is not exact and inline",
        );
      lifecycleUpdates++;
      continue;
    }
    const admins = updateBytes(proposal, GROUP_ADMIN_POLICY_COMPONENT_ID);
    if (admins !== undefined) {
      if (
        proposal.senderLeafIndex !== args.committerLeafIndex ||
        !bytesEqual(admins, encodeAdminPolicyV1([actorPubkey]))
      )
        return violation(
          "disband admin-policy replacement is not exact and inline",
        );
      adminUpdates++;
      continue;
    }
    return violation("disband commit contains a forbidden proposal");
  }
  if (lifecycleUpdates !== 1 || adminUpdates !== 1)
    return violation(
      "disband requires exactly one lifecycle and admin-policy replacement",
    );
  if (
    removals.length !== expectedRemovals.length ||
    expectedRemovals.some((index) => !removals.includes(index)) ||
    new Set(removals).size !== removals.length
  )
    return violation(
      "disband must remove every parent leaf except the exact committer leaf",
    );
  try {
    const resultingAdmins = receiverRemoved
      ? [actorPubkey]
      : (getAdminPolicy(args.resultingState.groupContext.extensions) ?? []);
    if (
      resultingAdmins.length !== 1 ||
      resultingAdmins[0] !== actorPubkey ||
      (!receiverRemoved &&
        (leafIndexes(args.resultingState).length !== 1 ||
          actorOf(args.resultingState, args.committerLeafIndex) !==
            actorPubkey))
    )
      return violation(
        "disband resulting roster or admin policy is not committer-only",
      );
  } catch {
    return violation("resulting disband admin-policy component did not decode");
  }
  return { kind: "validDisband", actorPubkey };
}
