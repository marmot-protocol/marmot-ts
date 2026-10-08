import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra";
import { proposeRemoveUser } from "../../group/proposals/remove-member.js";
import { GroupSession } from "../group-session.js";

// The sender of an application message is identified by its leaf in the
// ratchet tree of the epoch it was sent in. When the receiver applies a commit
// removing that member first (commits sort before other messages in an ingest
// batch, and a relay can return them together), the leaf is blank in the
// current tree. MDK delivers such a message (OpenMLS keeps the credential of
// past-epoch senders); marmot-ts dropped it as invalid-app-payload.

const ADMIN_ACCOUNT = testAccount(6);
const MEMBER_ACCOUNT = testAccount(9);
const ADMIN = ADMIN_ACCOUNT.pubkey;
const MEMBER = MEMBER_ACCOUNT.pubkey;

function chat(content: string, pubkey = MEMBER): Uint8Array {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey,
    created_at: 1000,
    content,
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return serializeApplicationRumor(rumor);
}

async function setup() {
  const impl: CiphersuiteImpl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const adminKp = await generateKeyPackage({
    credential: createCredential(ADMIN),
    ciphersuiteImpl: impl,
    signer: ADMIN_ACCOUNT.signer,
  });
  const { clientState } = await createSimpleGroup(adminKp, impl, "Test", {
    adminPubkeys: [ADMIN],
    relays: ["wss://relay.test"],
  });
  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER),
    ciphersuiteImpl: impl,
    signer: MEMBER_ACCOUNT.signer,
  });
  const { newState: adminState, welcome } = await createCommit({
    context: {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    },
    state: clientState,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const memberState = await joinGroup({
    context: {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    },
    welcome: welcome!.welcome,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  const session = (state: typeof adminState) =>
    new GroupSession({
      state,
      ciphersuite: impl,
      store: new InMemoryKeyValueStore<SerializedClientState>(),
    });
  return { admin: session(adminState), member: session(memberState) };
}

async function ingestAll(
  session: GroupSession,
  envelopes: Parameters<GroupSession["ingest"]>[0],
) {
  const results = [];
  for await (const result of session.ingest(envelopes)) results.push(result);
  return results;
}

async function removeMember(admin: GroupSession) {
  const proposals = await proposeRemoveUser(MEMBER)(admin.proposalContext());
  const effects = await admin.send({
    kind: "commit",
    actorPubkey: ADMIN,
    extraProposals: proposals,
  });
  const work = effects.publish[0];
  if (work.kind !== "groupEvolution") throw new Error("expected commit");
  admin.confirmPublished(work.pending);
}

describe("app message from a since-removed sender", () => {
  it("is delivered when read after the removal commit", async () => {
    const { admin, member } = await setup();
    const sent = await member.send({
      kind: "applicationMessage",
      payload: chat("last words"),
    });

    await removeMember(admin);

    const results = await ingestAll(admin, [sent.publish[0].envelope]);
    expect(results.map((r) => r.kind)).toEqual(["processed"]);
  });

  it("still rejects a past-epoch message whose author is not the sender", async () => {
    const { admin, member } = await setup();
    const sent = await member.send({
      kind: "applicationMessage",
      payload: chat("forged", ADMIN),
    });

    await removeMember(admin);

    const results = await ingestAll(admin, [sent.publish[0].envelope]);
    expect(
      results.map((r) => [r.kind, "reason" in r ? r.reason : undefined]),
    ).toEqual([["skipped", "invalid-app-payload"]]);
  });
});
