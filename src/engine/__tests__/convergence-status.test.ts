/**
 * Engine-level wiring for the convergence-status quiescence window (B5): a
 * deferred (future-epoch) commit is convergence-relevant AND unresolved, so once
 * the quiescence window elapses the engine reports `Resolving` rather than
 * `Settled`. A future-epoch commit can only be peeled with a mock peeler (a real
 * receiver lacks the future epoch's exporter), so this lives at the engine layer.
 */
import debug from "debug";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  type MlsMessage,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { marmotAuthService } from "../../core/auth-service.js";
import { convergenceStatuses } from "../../core/convergence-status.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

type Envelope = { id: string };

const QUIESCENCE_MS = 1_000;

describe("MarmotGroupEngine convergence status (B5)", () => {
  it("reports Resolving after the window when a deferred commit is outstanding", async () => {
    const adminPubkey = "a".repeat(64);
    const impl: CiphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const kp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: [],
    });

    // Capture a real commit whose source epoch is 2 (more than one ahead of a
    // receiver pinned at epoch 0 -> deferred missing_parent).
    let state = clientState;
    let futureCommit: MlsMessage | undefined;
    for (let epoch = 0; epoch <= 2; epoch++) {
      const res = await createCommit({
        context: { cipherSuite: impl, authService: marmotAuthService },
        state,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
      state = res.newState;
      if (epoch === 2) futureCommit = res.commit;
    }
    if (!futureCommit) throw new Error("expected a source-epoch-2 commit");

    const envelope: Envelope = { id: "future01" };
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        if (envelopes.includes(envelope))
          return {
            read: [{ envelope, message: futureCommit! }],
            unreadable: [],
          };
        return { read: [], unreadable: [...envelopes] };
      },
      wrapGroupMessage() {
        throw new Error("not used");
      },
      idOf(envelope) {
        return envelope.id;
      },
    };

    let t = 100_000;
    const engine = new MarmotGroupEngine<Envelope>({
      state: clientState,
      ciphersuite: impl,
      peeler,
      now: () => t,
      settlementQuiescenceMs: QUIESCENCE_MS,
    });

    // Fresh engine, no convergence input yet -> Settled.
    expect(engine.convergenceStatus).toBe(convergenceStatuses.settled);

    const kinds: string[] = [];
    for await (const r of engine.ingest([envelope])) kinds.push(r.kind);
    expect(kinds).toContain("deferred");

    // The deferred commit reset the window (convergence-relevant) and left input
    // unresolved: Syncing inside the window, Resolving once it elapses.
    expect(engine.convergenceStatus).toBe(convergenceStatuses.syncing);
    t += QUIESCENCE_MS;
    expect(engine.convergenceStatus).toBe(convergenceStatuses.resolving);
  });
});
