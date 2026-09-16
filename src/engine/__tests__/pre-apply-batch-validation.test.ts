/**
 * CR-01: `validatePreApplyProposals` must be a faithful port of MDK's
 * `validate_app_data_update_batch_against`, not only its "update decodes" half.
 *
 * Each row below is an MDK vector: a proposal batch the Rust reference
 * accepts or rejects, asserted against the TypeScript validator. A divergence
 * here is a deterministic network partition — marmot-ts would apply a commit
 * every conformant peer refuses (or refuse one they all apply).
 *
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs
 *   `validate_app_data_update_batch_against` (:1698), `validate_app_component_remove_against` (:1748),
 *   `validate_app_component_bytes` (:1629)
 */
import { appDataUpdateProposalType, type Proposal } from "ts-mls";
import { describe, expect, it } from "vitest";

import { decodeComponentsList } from "../../core/components/app-components-list.js";
import { encodeComponentsList } from "../../core/components/app-components-list.js";
import { decodeGroupLifecycleV1 } from "../../core/components/group-lifecycle.js";
import { encodeGroupLifecycleV1 } from "../../core/components/group-lifecycle.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  type AppComponentId,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_AVATAR_URL_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
} from "../../core/components/ids.js";
import { validatePreApplyProposals } from "../admin-policy.js";

/** No Add proposals appear in these batches, so the ciphersuite id is inert. */
const CIPHERSUITE = 1;

/** A component id outside `COMPONENT_PAYLOAD_DECODERS` — opaque to the library. */
const OPAQUE_COMPONENT_ID: AppComponentId = 0xbeef;

function update(componentId: AppComponentId, bytes: Uint8Array): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "update", update: bytes },
  };
}

function remove(componentId: AppComponentId): Proposal {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "remove" },
  };
}

/**
 * Bytes that are NOT a valid encoding for any component this library decodes.
 * The precondition is asserted (not assumed) below, so a codec change that
 * makes these decodable fails the suite loudly instead of silently voiding
 * every "does not decode" row.
 */
const UNDECODABLE = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);

describe("validatePreApplyProposals: MDK AppDataUpdate batch parity (CR-01)", () => {
  it("precondition: the shared undecodable fixture really does not decode", () => {
    expect(() => decodeComponentsList(UNDECODABLE)).toThrow();
    expect(() => decodeGroupLifecycleV1(UNDECODABLE)).toThrow();
  });

  describe("duplicate operations for one component id (MDK `seen` set)", () => {
    it("rejects two updates for the same component id", () => {
      const violation = validatePreApplyProposals(
        [
          update(
            GROUP_LIFECYCLE_COMPONENT_ID,
            encodeGroupLifecycleV1("active"),
          ),
          update(
            GROUP_LIFECYCLE_COMPONENT_ID,
            encodeGroupLifecycleV1("disbanded"),
          ),
        ],
        CIPHERSUITE,
      );
      expect(violation).toMatchObject({ reason: "component-integrity" });
      expect(violation?.detail).toContain("multiple AppDataUpdate operations");
    });

    it("rejects an update and a remove for the same component id", () => {
      expect(
        validatePreApplyProposals(
          [
            update(GROUP_AVATAR_URL_COMPONENT_ID, UNDECODABLE),
            remove(GROUP_AVATAR_URL_COMPONENT_ID),
          ],
          CIPHERSUITE,
        ),
      ).toMatchObject({ reason: "component-integrity" });
    });

    it("accepts one operation each for two different component ids", () => {
      expect(
        validatePreApplyProposals(
          [
            update(
              GROUP_LIFECYCLE_COMPONENT_ID,
              encodeGroupLifecycleV1("active"),
            ),
            remove(GROUP_AVATAR_URL_COMPONENT_ID),
          ],
          CIPHERSUITE,
        ),
      ).toBeUndefined();
    });
  });

  describe("Remove legality (MDK `validate_app_component_remove_against`)", () => {
    it.each([
      ["app_components 0x1", APP_COMPONENTS_COMPONENT_ID],
      ["safe_aad 0x2", SAFE_AAD_COMPONENT_ID],
      ["group.lifecycle 0x800c", GROUP_LIFECYCLE_COMPONENT_ID],
    ])("rejects an unconditional Remove of %s", (_label, componentId) => {
      const violation = validatePreApplyProposals(
        [remove(componentId)],
        CIPHERSUITE,
      );
      expect(violation).toMatchObject({ reason: "component-integrity" });
      expect(violation?.detail).toContain("cannot be removed");
    });

    it("rejects a Remove of a component the parent epoch still requires", () => {
      const violation = validatePreApplyProposals(
        [remove(GROUP_PROFILE_COMPONENT_ID)],
        CIPHERSUITE,
        [GROUP_PROFILE_COMPONENT_ID, GROUP_ADMIN_POLICY_COMPONENT_ID],
      );
      expect(violation).toMatchObject({ reason: "component-integrity" });
      expect(violation?.detail).toContain("required app component");
    });

    it("accepts a Remove of a component that is neither protected nor required", () => {
      expect(
        validatePreApplyProposals(
          [remove(GROUP_AVATAR_URL_COMPONENT_ID)],
          CIPHERSUITE,
          [GROUP_PROFILE_COMPONENT_ID],
        ),
      ).toBeUndefined();
    });

    it("accepts the atomic un-require-and-remove: the batch's own 0x1 update decides", () => {
      // MDK measures removal against the RESULTING required list, so dropping
      // 0x8005 from app_components and removing its state in one commit is legal.
      expect(
        validatePreApplyProposals(
          [
            update(
              APP_COMPONENTS_COMPONENT_ID,
              encodeComponentsList([GROUP_PROFILE_COMPONENT_ID]),
            ),
            remove(GROUP_MESSAGE_RETENTION_COMPONENT_ID),
          ],
          CIPHERSUITE,
          [GROUP_PROFILE_COMPONENT_ID, GROUP_MESSAGE_RETENTION_COMPONENT_ID],
        ),
      ).toBeUndefined();
    });

    it("still rejects a Remove when the batch's own 0x1 update keeps the id required", () => {
      expect(
        validatePreApplyProposals(
          [
            update(
              APP_COMPONENTS_COMPONENT_ID,
              encodeComponentsList([
                GROUP_PROFILE_COMPONENT_ID,
                GROUP_MESSAGE_RETENTION_COMPONENT_ID,
              ]),
            ),
            remove(GROUP_MESSAGE_RETENTION_COMPONENT_ID),
          ],
          CIPHERSUITE,
          // Parent did not require it; the batch's own update makes it required.
          [GROUP_PROFILE_COMPONENT_ID],
        ),
      ).toMatchObject({ reason: "component-integrity" });
    });
  });

  describe("update legality (MDK `validate_app_component_bytes`)", () => {
    it.each([
      ["safe_aad 0x2", SAFE_AAD_COMPONENT_ID],
      ["account-identity-proof 0x8009", ACCOUNT_IDENTITY_PROOF_COMPONENT_ID],
    ])(
      "rejects any update to %s, which is never GroupContext state",
      (_label, componentId) => {
        // Rejected on its own merits, NOT because the payload fails to decode:
        // neither id has a decoder, so the pre-CR-01 table `continue`d past both.
        expect(
          validatePreApplyProposals(
            [update(componentId, new Uint8Array([0x00]))],
            CIPHERSUITE,
          ),
        ).toMatchObject({ reason: "component-integrity" });
      },
    );

    it("rejects an undecodable payload for a known component id", () => {
      expect(
        validatePreApplyProposals(
          [update(GROUP_LIFECYCLE_COMPONENT_ID, UNDECODABLE)],
          CIPHERSUITE,
        ),
      ).toMatchObject({ reason: "component-integrity" });
    });

    it("rejects an undecodable app_components (0x1) payload", () => {
      expect(
        validatePreApplyProposals(
          [update(APP_COMPONENTS_COMPONENT_ID, UNDECODABLE)],
          CIPHERSUITE,
        ),
      ).toMatchObject({ reason: "component-integrity" });
    });

    it("accepts an opaque payload for a component id the library does not decode", () => {
      expect(
        validatePreApplyProposals(
          [update(OPAQUE_COMPONENT_ID, UNDECODABLE)],
          CIPHERSUITE,
        ),
      ).toBeUndefined();
    });
  });

  it("accepts a batch with no AppDataUpdate proposals at all", () => {
    expect(validatePreApplyProposals([], CIPHERSUITE)).toBeUndefined();
  });

  it("omitting requiredIds reproduces MDK's standalone-proposal semantics", () => {
    // `validate_standalone_app_data_update` passes an empty set, so a lone
    // Remove of a non-protected id is admissible; the commit that bundles it
    // re-runs this validator with the group's real required list.
    expect(
      validatePreApplyProposals(
        [remove(GROUP_PROFILE_COMPONENT_ID)],
        CIPHERSUITE,
      ),
    ).toBeUndefined();
    expect(
      validatePreApplyProposals(
        [remove(GROUP_PROFILE_COMPONENT_ID)],
        CIPHERSUITE,
        [GROUP_PROFILE_COMPONENT_ID],
      ),
    ).toMatchObject({ reason: "component-integrity" });
  });
});
