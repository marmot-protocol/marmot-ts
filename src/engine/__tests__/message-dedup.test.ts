import {
  appDataUpdateProposalType,
  createApplicationMessage,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { encodeAdminPolicyV1 } from "../../core/components/admin-policy.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { contentDedupId } from "../message-dedup.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";
import { memoryTreeStore } from "../../__tests__/helpers/database.js";

async function identityEngine(maxRewindCommits = 1) {
  const account = testAccount(6);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(account.pubkey),
    signer: account.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState } = await createSimpleGroup(kp, impl, "Identity", {
    adminPubkeys: [account.pubkey],
    relays: [],
  });
  type Envelope = {
    id: string;
    message: import("ts-mls").MlsMessage;
    toJSON(): { id: string };
  };
  const engine = new MarmotGroupEngine<Envelope>({
    state: clientState,
    ciphersuite: impl,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits,
      appPayloadPastEpochLimit: 1,
    },
    peeler: {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.map((envelope) => ({
            envelope,
            message: envelope.message,
          })),
          unreadable: [],
        };
      },
      async wrapGroupMessage(message) {
        const id = crypto.randomUUID();
        return { id, message, toJSON: () => ({ id }) };
      },
      idOf: (envelope) => envelope.id,
    },
  });
  engine.history.bindStore(memoryTreeStore());
  async function advance() {
    const sent = await engine.send({ kind: "selfUpdate" });
    if (sent.kind !== "selfUpdate") throw new Error("expected self-update");
    engine.confirmPublished(sent.pending);
    return sent.envelope;
  }
  async function echo(envelope: Envelope) {
    const id = crypto.randomUUID();
    const results = [];
    for await (const result of engine.ingest([
      { ...envelope, id, toJSON: () => ({ id }) },
    ]))
      results.push(result);
    return results;
  }
  return { engine, advance, echo };
}

describe("source-epoch retention of inner identities", () => {
  it("captures application, proposal and commit identity before delayed publication", async () => {
    const { engine, advance, echo } = await identityEngine();
    const app = await engine.send({
      kind: "applicationMessage",
      payload: new Uint8Array([1, 2]),
    });
    const proposal = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "update",
          update: encodeAdminPolicyV1([testAccount(6).pubkey]),
        },
      },
    });
    if (!("pending" in proposal)) throw new Error("expected proposal");
    engine.confirmPublished(proposal.pending);
    const commit = await engine.send({
      kind: "commit",
      actorPubkey: testAccount(6).pubkey,
    });
    if (!("pending" in commit) || !("envelope" in commit))
      throw new Error("expected commit");
    engine.confirmPublished(commit.pending);
    const equality = await advance();
    expect(engine.retentionIdentityCounts().sent).toBe(4);
    // Relay publication happens after these epochs advance; source coordinates remain construction-time.
    await engine.retainSettled();
    expect(engine.retentionIdentityCounts().sent).toBe(1);
    expect(await echo(equality)).toMatchObject([
      { kind: "skipped", reason: "self-echo" },
    ]);
    for (const result of [app, proposal, commit]) {
      if (!("envelope" in result)) throw new Error("expected envelope");
      expect(
        (await echo(result.envelope)).some(
          (entry) => entry.kind === "skipped" && entry.reason === "self-echo",
        ),
      ).toBe(false);
    }
  });

  it("keeps an exact content pin until release and plateaus under a finite workload", async () => {
    const { engine, advance, echo } = await identityEngine();
    const old = await advance();
    await advance();
    await engine.retainSettled(undefined, {
      contentIds: [contentDedupId(old.message)],
    });
    expect(await echo(old)).toMatchObject([
      { kind: "skipped", reason: "self-echo" },
    ]);
    await engine.retainSettled();
    expect(engine.retentionIdentityCounts().sent).toBe(1);
    for (let i = 0; i < 12; i++) {
      await engine.send({
        kind: "applicationMessage",
        payload: new Uint8Array([i]),
      });
      await advance();
      await engine.retainSettled();
      expect(engine.retentionIdentityCounts().sent).toBeLessThanOrEqual(2);
    }
  });

  it("retires an old own identity strictly below the committed floor", async () => {
    const { engine, advance, echo } = await identityEngine();
    const below = await advance();
    const equal = await advance();
    await engine.retainSettled();
    expect(await echo(equal)).toMatchObject([
      { kind: "skipped", reason: "self-echo" },
    ]);
    const results = await echo(below);
    expect(
      results.some(
        (result) => result.kind === "skipped" && result.reason === "self-echo",
      ),
    ).toBe(false);
    expect(results.some((result) => result.disposition.kind === "stale")).toBe(
      true,
    );
  });

  it("preserves historical own identities under explicit Infinity", async () => {
    const { engine, advance, echo } = await identityEngine(Infinity);
    const old = await advance();
    await advance();
    await advance();
    await engine.retainSettled();
    expect(await echo(old)).toMatchObject([
      { kind: "skipped", reason: "self-echo" },
    ]);
  });
});

describe("contentDedupId", () => {
  it("is stable for the same MLS message and distinct for different ones", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const admin = testAccount(6);
    const kp = await generateKeyPackage({
      credential: createCredential(admin.pubkey),
      signer: admin.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [admin.pubkey],
      relays: [],
    });

    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const first = await createApplicationMessage({
      context: ctx,
      state: clientState,
      message: new TextEncoder().encode("hello"),
    });
    const second = await createApplicationMessage({
      context: ctx,
      state: first.newState,
      message: new TextEncoder().encode("hello"),
    });

    const id = contentDedupId(first.message);
    expect(id).toMatch(/^[0-9a-f]{64}$/); // lowercase-hex SHA-256, no prefix
    expect(contentDedupId(first.message)).toBe(id); // deterministic
    // Same plaintext, different ratchet generation ⇒ distinct content id.
    expect(contentDedupId(second.message)).not.toBe(id);
  });
});
