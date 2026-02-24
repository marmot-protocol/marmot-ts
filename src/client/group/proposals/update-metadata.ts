import { type ProposalGroupContextExtensions } from "ts-mls/proposal.js";
import { replaceExtension } from "../../../core/extensions.js";
import { marmotGroupDataToExtension } from "../../../core/marmot-group-data.js";
import { MarmotGroupData } from "../../../core/protocol.js";
import type { ProposalAction } from "../marmot-group.js";
import { defaultProposalTypes } from "ts-mls";
import { type GroupContextExtension } from "ts-mls";

/** Builds a proposal to update a group's marmot group data extension */
export function proposeUpdateMetadata(
  metadata: Partial<MarmotGroupData>,
): ProposalAction<ProposalGroupContextExtensions> {
  return async ({ state, groupData }) => {
    // Create updated group data, preserving existing values for unchanged fields
    const updatedGroupData: MarmotGroupData = {
      ...groupData,
      ...metadata,
    };

    // Convert to MLS extension
    const updatedExtension = marmotGroupDataToExtension(updatedGroupData);

    return {
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: {
        // Replace the marmot group data extension with the updated one
        extensions: replaceExtension(
          state.groupContext.extensions,
          updatedExtension,
        ) as GroupContextExtension[],
      },
    };
  };
}
