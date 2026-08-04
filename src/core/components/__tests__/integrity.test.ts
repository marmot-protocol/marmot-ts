/**
 * Tests for the two ported commit-legality validators (WIRE-03, CONV-01) and
 * their shared seam adapter. Fixtures are hand-built `GroupContextExtension[]`
 * arrays (via `makeAppComponentsExtension`/`componentEntry`/`appComponentsEntry`/
 * `adminPolicyEntry`) with no MLS state, except `validateCommitLegality`'s own
 * describe block, which needs minimal `ClientState`-shaped fixtures so
 * `getGroupMembers` can read `ratchetTree`.
 */
import {
  appDataUpdateProposalType,
  ClientState,
  defaultProposalTypes,
  GroupContextExtension,
  nodeTypes,
  type Proposal,
  type ProposalAppDataUpdate,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createCredential } from "../../credential.js";
import { BinaryWriter } from "../../binary.js";
import { encodeComponentsList } from "../app-components-list.js";
import {
  adminPolicyEntry,
  appComponentsEntry,
  componentEntry,
  makeAppComponentsExtension,
} from "../dictionary.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../ids.js";
import {
  type AppDataUpdateOp,
  collectAppDataUpdateOps,
  validateAdminLeafCoupling,
  validateAppComponentIntegrity,
  validateCommitLegality,
} from "../integrity.js";

// Confirmed valid x-only secp256k1 pubkeys (on-curve), matching the constants
// already used elsewhere in this test suite (e.g. group-engine.test.ts).
const ADMIN_PUBKEY = "a".repeat(64);
const MEMBER_PUBKEY = "e".repeat(64);

function dict(...entries: ReturnType<typeof componentEntry>[]) {
  return [makeAppComponentsExtension(entries)] as GroupContextExtension[];
}

function updateOp(
  componentId: number,
  data: Uint8Array,
): ProposalAppDataUpdate {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "update", update: data },
  };
}

function removeOp(componentId: number): ProposalAppDataUpdate {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "remove" },
  };
}

describe("validateAppComponentIntegrity", () => {
  it("returns a violation when current has a dictionary and resulting extensions carry none", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: [],
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when a required component (GROUP_ADMIN_POLICY_COMPONENT_ID) is present before and absent after", () => {
    const current = dict(
      componentEntry(GROUP_ADMIN_POLICY_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [GROUP_ADMIN_POLICY_COMPONENT_ID],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when APP_COMPONENTS_COMPONENT_ID is dropped even though it is not listed in requiredIds", () => {
    const current = dict(appComponentsEntry([GROUP_PROFILE_COMPONENT_ID]));
    const resulting = dict();
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when an entry's bytes change and appDataUpdateOps is empty (GroupContextExtensions-only rewrite)", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when an AppDataUpdate op exists for the id but with different resulting bytes", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([3]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined when the dictionary is byte-identical before and after", () => {
    const extensions = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: extensions,
      resultingExtensions: extensions,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns undefined when a change is backed by an AppDataUpdate op byte-equal to the resulting bytes", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([2]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns undefined when an entry is removed and backed by a Remove op, and the id is not in the protected set", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: undefined },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a violation when a protected entry is removed even though a Remove op for it is present (rule 2 runs before rule 3)", () => {
    const current = dict(
      componentEntry(GROUP_ADMIN_POLICY_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_ADMIN_POLICY_COMPONENT_ID, data: undefined },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [GROUP_ADMIN_POLICY_COMPONENT_ID],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined when a brand-new component id appears and is backed by an update op", () => {
    const current: GroupContextExtension[] = [];
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([9])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([9]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });
});

describe("collectAppDataUpdateOps", () => {
  it("maps an update proposal to {componentId, data} and a remove proposal to {componentId, data: undefined}", () => {
    const proposals: Proposal[] = [
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      removeOp(GROUP_ADMIN_POLICY_COMPONENT_ID),
    ];
    expect(collectAppDataUpdateOps(proposals)).toEqual([
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([1]) },
      { componentId: GROUP_ADMIN_POLICY_COMPONENT_ID, data: undefined },
    ]);
  });

  it("ignores non-AppDataUpdate proposals and preserves order for two ops on the same component id", () => {
    const proposals: Proposal[] = [
      { proposalType: defaultProposalTypes.remove, remove: { removed: 2 } },
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    ];
    expect(collectAppDataUpdateOps(proposals)).toEqual([
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([1]) },
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([2]) },
    ]);
  });
});

describe("validateAdminLeafCoupling", () => {
  it("returns a violation when the resulting admin-policy lists a key whose account is absent from resultingMemberAccounts", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [MEMBER_PUBKEY],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
  });

  it("returns undefined when every resulting admin key has an account in resultingMemberAccounts", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [ADMIN_PUBKEY, MEMBER_PUBKEY],
    });
    expect(violation).toBeUndefined();
  });

  it("carried-forward: resulting carries NO admin-policy entry, current does, and one current admin is absent from resultingMemberAccounts", () => {
    const current = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const resulting: GroupContextExtension[] = [];
    const violation = validateAdminLeafCoupling({
      currentExtensions: current,
      resultingExtensions: resulting,
      resultingMemberAccounts: [MEMBER_PUBKEY],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
  });

  it("returns undefined when neither current nor resulting extensions carry an admin-policy entry", () => {
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: [],
      resultingMemberAccounts: [],
    });
    expect(violation).toBeUndefined();
  });

  it("an admin account with two leaves where only one is removed still passes (D-08 account-level survival)", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    // resultingMemberAccounts is account-level: ADMIN_PUBKEY still appears once
    // because it survives via its other leaf, even though one of its two
    // leaves was removed by this commit.
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [ADMIN_PUBKEY],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a violation (not a thrown exception) when the resulting admin-policy component does not decode", () => {
    // 3 raw bytes is not a multiple of 32 -> decodeAdminPolicyV1 throws.
    const malformed = componentEntry(
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      new BinaryWriter().opaque(new Uint8Array([1, 2, 3])).build(),
    );
    const resulting = dict(malformed);
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
  });
});

describe("validateCommitLegality", () => {
  function fakeClientState(
    extensions: GroupContextExtension[],
    memberPubkeys: string[],
  ): ClientState {
    const ratchetTree = memberPubkeys.map((pk) => ({
      nodeType: nodeTypes.leaf,
      leaf: { credential: createCredential(pk) },
    }));
    return {
      groupContext: { extensions },
      ratchetTree,
    } as unknown as ClientState;
  }

  it("derives requiredIds from the PARENT state, not the resulting one (Pitfall 2 regression guard)", () => {
    // Parent: app_components only requires GROUP_PROFILE_COMPONENT_ID; the
    // retention component has state but is not (yet) required.
    const parentState = fakeClientState(
      dict(
        appComponentsEntry([GROUP_PROFILE_COMPONENT_ID]),
        componentEntry(
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
          new Uint8Array([1]),
        ),
      ),
      [ADMIN_PUBKEY],
    );

    // Resulting: this SAME commit adds retention to the required list AND
    // drops its own component entry (backed by an explicit Remove op). If
    // requiredIds were (wrongly) derived from the resulting state, retention
    // would already be "required" and rule 2 would reject this drop.
    const resultingState = fakeClientState(
      dict(
        appComponentsEntry([
          GROUP_PROFILE_COMPONENT_ID,
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
        ]),
      ),
      [ADMIN_PUBKEY],
    );

    const proposals: Proposal[] = [
      updateOp(
        APP_COMPONENTS_COMPONENT_ID,
        encodeComponentsList([
          GROUP_PROFILE_COMPONENT_ID,
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
        ]),
      ),
      removeOp(GROUP_MESSAGE_RETENTION_COMPONENT_ID),
    ];

    const violation = validateCommitLegality({
      parentState,
      resultingState,
      proposals,
    });
    expect(violation).toBeUndefined();
  });

  it("returns the integrity violation before the coupling violation when a commit violates both", () => {
    const parentState = fakeClientState(
      dict(
        adminPolicyEntry([ADMIN_PUBKEY]),
        componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      ),
      [ADMIN_PUBKEY, MEMBER_PUBKEY],
    );

    // Resulting: profile bytes rewritten with no backing AppDataUpdate op
    // (component-integrity violation) AND the admin's leaf is gone
    // (admin-leaf-coupling violation) -- both in the same commit.
    const resultingState = fakeClientState(
      dict(
        adminPolicyEntry([ADMIN_PUBKEY]),
        componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
      ),
      [MEMBER_PUBKEY],
    );

    const violation = validateCommitLegality({
      parentState,
      resultingState,
      proposals: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined for a benign commit that changes nothing in the dictionary and removes no member", () => {
    const extensions = dict(
      adminPolicyEntry([ADMIN_PUBKEY]),
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const parentState = fakeClientState(extensions, [
      ADMIN_PUBKEY,
      MEMBER_PUBKEY,
    ]);
    const resultingState = fakeClientState(extensions, [
      ADMIN_PUBKEY,
      MEMBER_PUBKEY,
    ]);

    const violation = validateCommitLegality({
      parentState,
      resultingState,
      proposals: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a typed violation instead of throwing when the PARENT app_components bytes do not decode", () => {
    // A prior commit can legally land arbitrary bytes on 0x0001 (rule 3 backs
    // the change with that commit's own op; rule 2 only checks presence). From
    // the next commit onward every seam decodes those bytes — a duplicate id
    // makes `decodeComponentsList` throw. The adapter is documented
    // non-throwing (D-01/D-02): the convergence/replay seams would otherwise
    // see the throw escape the ingest generator and skip persistence.
    const duplicateIds = new BinaryWriter()
      .vector([
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
      ])
      .build();

    const parentState = fakeClientState(
      dict(componentEntry(APP_COMPONENTS_COMPONENT_ID, duplicateIds)),
      [ADMIN_PUBKEY],
    );
    const resultingState = fakeClientState(
      dict(componentEntry(APP_COMPONENTS_COMPONENT_ID, duplicateIds)),
      [ADMIN_PUBKEY],
    );

    let violation: ReturnType<typeof validateCommitLegality>;
    expect(() => {
      violation = validateCommitLegality({
        parentState,
        resultingState,
        proposals: [],
      });
    }).not.toThrow();
    expect(violation!).toEqual({
      reason: "component-integrity",
      detail: "current app_components component did not decode",
    });
  });
});
