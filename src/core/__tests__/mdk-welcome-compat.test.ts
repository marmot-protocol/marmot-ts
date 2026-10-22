import {
  appDataUpdateProposalType,
  createCommit,
  createGroup,
  defaultCryptoProvider,
  defaultExtensionTypes,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroupWithExtensions,
} from "ts-mls";
import { describe, expect, it } from "vitest";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { marmotAuthService } from "../auth-service.js";
import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { validateWelcomeGroup } from "../welcome-join.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  adminPolicyEntry,
  appComponentsEntry,
  groupLifecycleEntry,
  makeAppComponentsExtension,
  encryptedMediaEntry,
  encryptedMediaBlossomDefault,
} from "../components/index.js";

describe("MDK current-profile Welcome admission", () => {
  // Build signed MLS Welcomes using the MDK protocol baseline, rather than
  // marmot-ts creation defaults. Older valid groups need not have lifecycle
  // or profile state, and self_remove is an optional feature registration.
  async function welcome(
    lifecycle: "absent" | "active" | "disbanded" | "missing",
    media?: { required: boolean; malformed: boolean },
  ) {
    const suite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const admin = testAccount(0);
    const invitee = testAccount(1);
    const makePackage = (account: typeof admin) =>
      generateKeyPackage({
        credential: createCredential(account.pubkey),
        signer: account.signer,
        ciphersuiteImpl: suite,
      });
    const creator = await makePackage(admin);
    const recipient = await makePackage(invitee);
    const required = [
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    ];
    if (lifecycle !== "absent") required.push(GROUP_LIFECYCLE_COMPONENT_ID);
    if (media?.required) required.push(0x800b);
    const context = {
      cipherSuite: suite,
      authService: marmotAuthService,
      externalPsks: {},
    };
    const state = await createGroup({
      context,
      groupId: new Uint8Array(16).fill(1),
      keyPackage: creator.publicPackage,
      privateKeyPackage: creator.privatePackage,
      extensions: [
        {
          extensionType: defaultExtensionTypes.required_capabilities,
          extensionData: {
            extensionTypes: [6],
            proposalTypes: [appDataUpdateProposalType],
            credentialTypes: [],
          },
        },
        makeAppComponentsExtension([
          appComponentsEntry(required),
          adminPolicyEntry([admin.pubkey]),
          ...(media
            ? [
                media.malformed
                  ? { componentId: 0x800b, data: Uint8Array.of(0) }
                  : encryptedMediaEntry(
                      encryptedMediaBlossomDefault([
                        "http://192.168.1.1/blobs",
                      ]),
                    ),
              ]
            : []),
          ...(lifecycle === "active" || lifecycle === "disbanded"
            ? [groupLifecycleEntry(lifecycle)]
            : []),
        ]),
      ],
    });
    const add = await createCommit({
      context,
      state,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: recipient.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const joined = await joinGroupWithExtensions({
      context,
      welcome: add.welcome!.welcome,
      keyPackage: recipient.publicPackage,
      privateKeys: recipient.privatePackage,
    });
    return { ...joined, admin };
  }

  it.each(["absent", "active"] as const)(
    "joins an MDK baseline group with %s lifecycle and no self_remove requirement or profile",
    async (lifecycle) => {
      const { state, groupInfo, admin } = await welcome(lifecycle);
      expect(validateWelcomeGroup(state, groupInfo)).toBe(admin.pubkey);
    },
  );

  it("rejects lifecycle state missing from a group that requires it", async () => {
    const { state, groupInfo } = await welcome("missing");
    expect(() => validateWelcomeGroup(state, groupInfo)).toThrow(/no state/);
  });

  it("rejects a disbanded Welcome", async () => {
    const { state, groupInfo } = await welcome("disbanded");
    expect(() => validateWelcomeGroup(state, groupInfo)).toThrow(/not active/);
  });
  it.each([true, false])(
    "accepts canonical v2 policy and rejects malformed state even when optional (required=%s)",
    async (required) => {
      const valid = await welcome("active", { required, malformed: false });
      expect(validateWelcomeGroup(valid.state, valid.groupInfo)).toBe(
        valid.admin.pubkey,
      );
      const invalid = await welcome("active", { required, malformed: true });
      expect(() =>
        validateWelcomeGroup(invalid.state, invalid.groupInfo),
      ).toThrow(/media v2 policy/);
    },
  );
});
