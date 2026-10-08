import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "applesauce-core/helpers/event";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { serializeApplicationRumor } from "../../../core/group-message.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra";
import { proposeUpdateMetadata } from "../../group/proposals/update-metadata.js";
import { GroupSession } from "../group-session.js";

// transports/nostr.md "Message expiration": when the source epoch enables
// message-retention.v1, the kind-445 carrying an application message SHOULD
// have a NIP-40 `expiration` tag equal to created_at + disappearing_message_secs;
// commits and proposals MUST NOT carry one. MDK does this
// (transport-nostr-peeler `wrap_group_message_inner`); marmot-ts never did.

const ADMIN_ACCOUNT = testAccount(6);
const ADMIN = ADMIN_ACCOUNT.pubkey;

function chat(createdAt: number): Uint8Array {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey: ADMIN,
    created_at: createdAt,
    content: "hi",
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return serializeApplicationRumor(rumor);
}

async function adminSession() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(ADMIN),
    ciphersuiteImpl: impl,
    signer: ADMIN_ACCOUNT.signer,
  });
  const { clientState } = await createSimpleGroup(kp, impl, "Test", {
    adminPubkeys: [ADMIN],
    relays: ["wss://relay.test"],
  });
  return new GroupSession({
    state: clientState,
    ciphersuite: impl,
    store: new InMemoryKeyValueStore<SerializedClientState>(),
  });
}

async function setRetention(session: GroupSession, seconds: number | bigint) {
  const proposals = await proposeUpdateMetadata({ messageRetention: seconds })(
    session.proposalContext(),
  );
  const effects = await session.send({
    kind: "commit",
    actorPubkey: ADMIN,
    extraProposals: proposals,
  });
  const work = effects.publish[0];
  if (work.kind !== "groupEvolution") throw new Error("expected commit");
  session.confirmPublished(work.pending);
  return work.envelope as NostrEvent;
}

async function sendChat(session: GroupSession, createdAt: number) {
  const effects = await session.send({
    kind: "applicationMessage",
    payload: chat(createdAt),
  });
  return effects.publish[0].envelope as NostrEvent;
}

const expirationTags = (event: NostrEvent) =>
  event.tags.filter((tag) => tag[0] === "expiration");

describe("kind-445 expiration tag", () => {
  it("tags an application message with created_at + retention", async () => {
    const session = await adminSession();
    const commit = await setRetention(session, 3600);
    expect(expirationTags(commit)).toEqual([]);

    const event = await sendChat(session, 1_700_000_000);
    expect(expirationTags(event)).toEqual([["expiration", "1700003600"]]);
    expect(event.tags.map((tag) => tag[0]).sort()).toEqual(["expiration", "h"]);
  });

  it("omits the tag when retention is absent or disabled", async () => {
    const session = await adminSession();
    expect(expirationTags(await sendChat(session, 1_700_000_000))).toEqual([]);

    await setRetention(session, 0);
    expect(expirationTags(await sendChat(session, 1_700_000_000))).toEqual([]);
  });

  it("omits the tag when the sum does not fit in uint64", async () => {
    const session = await adminSession();
    await setRetention(session, (1n << 64n) - 1n);
    expect(expirationTags(await sendChat(session, 1_700_000_000))).toEqual([]);
  });

  it("never tags a commit, even with retention enabled", async () => {
    const session = await adminSession();
    await setRetention(session, 3600);
    const effects = await session.send({ kind: "selfUpdate" });
    expect(expirationTags(effects.publish[0].envelope as NostrEvent)).toEqual(
      [],
    );
  });
});
