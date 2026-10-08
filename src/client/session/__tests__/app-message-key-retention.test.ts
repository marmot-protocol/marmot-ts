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
import { GroupSession } from "../group-session.js";

// Receiver-side MLS secret retention. Both rows were seen live against an MDK
// (wn) sender: a message sent five commits before the marmot-ts member read
// it failed with "Cannot process message, epoch too old", and a 30-message
// burst fetched newest-first lost 19 messages to "Desired gen in the past".
// MDK delivers both (max_past_epochs 5, out_of_order_tolerance 100).

const ADMIN_ACCOUNT = testAccount(6);
const MEMBER_ACCOUNT = testAccount(9);
const ADMIN = ADMIN_ACCOUNT.pubkey;
const MEMBER = MEMBER_ACCOUNT.pubkey;

function chat(content: string): Uint8Array {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey: MEMBER,
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

async function advanceEpochs(admin: GroupSession, count: number) {
  for (let i = 0; i < count; i++) {
    const effects = await admin.send({
      kind: "commit",
      actorPubkey: ADMIN,
      extraProposals: [],
    });
    const work = effects.publish[0];
    if (work.kind !== "groupEvolution") throw new Error("expected commit");
    admin.confirmPublished(work.pending);
  }
}

async function ingestAll(
  session: GroupSession,
  envelopes: Parameters<GroupSession["ingest"]>[0],
) {
  const results = [];
  for await (const result of session.ingest(envelopes)) results.push(result);
  return results;
}

describe("app-message key retention", () => {
  it("delivers a message from app_payload_past_epoch_limit (5) epochs back", async () => {
    const { admin, member } = await setup();
    const sent = await member.send({
      kind: "applicationMessage",
      payload: chat("sent at the old epoch"),
    });

    await advanceEpochs(admin, 5);

    const results = await ingestAll(admin, [sent.publish[0].envelope]);
    expect(results.map((r) => r.kind)).toEqual(["processed"]);
  });

  it("delivers a 30-message burst fetched newest-first", async () => {
    const { admin, member } = await setup();
    const envelopes = [];
    for (let i = 0; i < 30; i++) {
      const sent = await member.send({
        kind: "applicationMessage",
        payload: chat(`burst ${i}`),
      });
      envelopes.push(sent.publish[0].envelope);
    }
    envelopes.reverse();

    const results = [];
    for (const envelope of envelopes)
      results.push(...(await ingestAll(admin, [envelope])));
    expect(results.filter((r) => r.kind === "processed")).toHaveLength(30);
  });
});
