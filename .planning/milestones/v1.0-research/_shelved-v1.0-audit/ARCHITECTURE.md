# Architecture Research

**Domain:** Marmot (MLS over Nostr) TypeScript client library — layer-to-Rust-crate mapping
**Researched:** 2026-07-01
**Confidence:** HIGH (all findings derived from live source in this repo: `src/`, `darkmatter/`, `darkmatter/spec/`)

## TS Layer ↔ Rust Crate Correspondence

| TS Layer / File                                             | Primary Rust Crate(s)                                                                                | Role Match                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ts-mls` (submodule)                                        | `openMLS` (Rust lib, used by `cgka-engine`)                                                          | Both are the raw MLS engine — RFC 9420 state transitions                               |
| `src/core/` (protocol/crypto primitives)                    | `cgka-traits` (`crates/traits/`)                                                                     | Shared type vocabulary, app-component codecs, engine/peeler interfaces                 |
| `src/core/components/`                                      | `cgka-traits/src/app_components/`                                                                    | App-component codecs (encrypted-media, avatar-url, admin-policy, routing)              |
| `src/engine/group-engine.ts` (`MarmotGroupEngine`)          | `cgka-engine/src/engine.rs` (`Engine<S>`)                                                            | Transport-agnostic state machine; both implement the same CgkaEngine/engine contract   |
| `src/engine/epoch-manager` (implicit in engine)             | `cgka-engine/src/epoch_manager.rs` (`EpochManager`)                                                  | Sole owner of lifecycle-state transitions (`Stable/PendingPublish/Merging/Recovering`) |
| `src/engine/fork-recovery.ts` (`ForkRecovery`)              | `cgka-engine/src/fork_recovery.rs`                                                                   | Deterministic same-epoch commit ordering + rollback-to-winner                          |
| `src/engine/retained-store.ts` (`RetainedHistoryStore`)     | `cgka-engine` retained snapshots + `StorageProvider`                                                 | In-memory bounded window of `ClientState` per retained epoch                           |
| `src/engine/history-tree.ts` (`GroupHistoryTree`)           | `cgka-engine` stored-message store + `cgka-engine/src/openmls_projection.rs`                         | Full-fork DAG / commit persistence                                                     |
| `src/engine/ingestion-pool.ts` (`IngestionPool`)            | `cgka-engine/src/message_processor/store.rs` (retryable stored messages)                             | Holds undecryptable or deferred messages for retry                                     |
| `src/engine/ingest.ts` (`ingestEnvelopes`)                  | `cgka-engine/src/message_processor/ingest.rs` (`ingest_group_message`)                               | Inbound peel → classify → apply pipeline                                               |
| `src/engine/admin-policy.ts`                                | `cgka-engine/src/message_processor/send.rs` (MIP-03 guards)                                          | Admin-commit authorization policy                                                      |
| `src/engine/convergence.ts` (via `src/core/convergence.ts`) | `cgka-engine/src/convergence.rs` + `distributed_convergence.rs`                                      | Candidate-branch scoring and selection                                                 |
| `src/core/convergence.ts`                                   | `cgka-engine/src/canonicalization.rs`                                                                | Branch-score algorithm (depth, witness quorum, tip priority/committer/digest)          |
| `src/core/group-lifecycle.ts` (`GroupLifecycleState`)       | `cgka-traits/src/engine_state.rs` + `cgka-engine/src/epoch_manager.rs`                               | Lifecycle FSM and legal transition enforcement                                         |
| `src/core/group-message-crypto.ts`                          | `cgka-engine/src/group_context_view.rs` (`exporter_secret`) + `transport-nostr-peeler/src/peeler.rs` | Kind-445 ChaCha20-Poly1305 seal/unseal via MLS exporter                                |
| `src/core/account-identity-proof.ts`                        | `cgka-engine/src/account_identity_proof.rs`                                                          | LeafNode extension binding account pubkey to MLS signing key                           |
| `src/client/group/nostr-peeler.ts` (`NostrGroupPeeler`)     | `transport-nostr-peeler/src/peeler.rs`                                                               | `TransportPeeler` / `GroupPeeler<NostrEvent>` impl; kind-445 wrap/peel                 |
| `src/client/session/group-session.ts` (`GroupSession`)      | `cgka-session` (wires engine into session lifecycle)                                                 | Wires engine + peeler; translates engine results to transport types                    |
| `src/client/runtime/group-runtime.ts` (`GroupRuntime`)      | `marmot-account/src/runtime.rs` (`AccountDeviceRuntime`)                                             | Drives publish effects; confirm/rollback pending obligations                           |
| `src/client/group/marmot-group.ts` (`MarmotGroup`)          | `marmot-account` + `marmot-app` app facade                                                           | Top-level group API composing session + runtime                                        |
| `src/client/transport/nostr/welcome-delivery.ts`            | `transport-nostr-adapter` (NIP-59 gift-wrap) + `marmot-account/src/key_package.rs`                   | NIP-59 welcome wrap/peel + inbox-relay delivery                                        |
| `src/core/welcome-join.ts`                                  | `cgka-engine/src/group_lifecycle.rs` (`do_join_welcome`)                                             | MLS Welcome processing → `ts-mls::joinGroup` / `OpenMLS::process_message`              |
| `src/extra/` (store impls)                                  | `storage-sqlite` / `cgka-traits/src/storage.rs`                                                      | `StorageProvider` / `GenericKeyValueStore` implementations                             |
| `src/audit/` (`AuditSink`)                                  | `marmot-forensics` (JSONL audit schema)                                                              | Optional forensic audit log                                                            |

**Structural note on layering:**

- In the Rust stack, `cgka-traits` is the boundary crate (shared types) with zero MLS-engine dependency — analogous to `src/core` (no I/O) plus `src/engine/types.ts`.
- `cgka-engine` is the full engine crate — analogous to `src/engine/` as a whole (including history tree and fork recovery which Rust keeps inside the engine crate).
- `transport-nostr-peeler` is the single Nostr crypto-boundary crate — analogous to `src/client/group/nostr-peeler.ts` + `src/core/group-message-crypto.ts` combined.
- `cgka-session` + `marmot-account` split the TS `GroupSession` + `GroupRuntime` + `MarmotGroup` responsibilities. TS collapses these into one layer; Rust separates session lifecycle (`cgka-session`) from account/routing orchestration (`marmot-account`).

---

## Data Flows for Interop-Critical Paths

### 1. Inbound Processing

```
Nostr relay → caller (app)
    │
    ▼
MarmotGroup.ingest(NostrEvent[])         [src/client/group/marmot-group.ts]
    │
    ▼
GroupSession.ingest()                    [src/client/session/group-session.ts]
    │  • strips own-echo by Nostr event id
    ▼
MarmotGroupEngine.ingest(envelopes)      [src/engine/group-engine.ts]
    │
    ▼
ingestEnvelopes()                        [src/engine/ingest.ts]
    │
    ├── NostrGroupPeeler.peelGroupMessages()   [src/client/group/nostr-peeler.ts]
    │       └── decryptGroupMessages()          [src/core/group-message.ts]
    │               └── ChaCha20-Poly1305 decrypt using MLS exporter(tip epoch)
    │
    ├── classify: commit / proposal / application / malformed
    │
    ├── ts-mls processMessage()  (MLS RFC 9420 state transition)
    │
    ├── fork-shaped commit? → ForkRecovery.resolveFork()   [src/engine/fork-recovery.ts]
    │
    └── undecryptable? → IngestionPool.hold()  [src/engine/ingestion-pool.ts]
            (retry on tip advance or retained-fork-node sweep)
```

**Rust parallel:** `Engine::ingest` → `do_ingest` → `ingest_group_message` (in `cgka-engine/src/message_processor/ingest.rs`) → peel via `TransportPeeler` (in `transport-nostr-peeler`) → `openmls_projection` + `convergence_ingest_outcome`.

**Key difference from Rust:** Rust's `ingest_group_message` explicitly tries peel against retained-epoch snapshots when the canonical-epoch peel fails (`try_peel_group_message_from_available_snapshots`). TS `IngestionPool` holds the undecryptable envelope and retries on each tip advance — a functionally equivalent strategy but with a different retry point.

---

### 2. Convergence and Fork Resolution

```
ingestEnvelopes() detects fork-shaped commit
    │
    ▼
ForkRecovery.resolveFork()               [src/engine/fork-recovery.ts]
    │
    ├── builds candidate branches from GroupHistoryTree  [src/engine/history-tree.ts]
    │       (retained MLS bytes replayed per RetainedHistoryStore)
    │
    ├── selectCanonicalBranch()           [src/core/convergence.ts]
    │       implements scoring: effective_commit_depth → witness_quorum →
    │       raw_commit_depth → app_witness_score → tip_priority →
    │       tip_committer → tip_digest (SHA-256 of MLS bytes)
    │
    └── applyForkResolution()
            • rolls back to pre-fork RetainedHistoryStore state
            • replays winning branch commits
            • emits invalidated dispositions for losing-branch app payloads
            • advances lifecycle: Recovering → Stable
```

**Lifecycle FSM (`src/core/group-lifecycle.ts`):**

```
Stable → PendingPublish → Merging → Stable
Stable → Recovering → Stable | Unrecoverable
```

Convergence status (`src/core/convergence-status.ts`): `Syncing | Resolving | Settled | Blocked` — derived, not authoritative. Outbound work gates on `Settled`.

**Rust parallel:** `cgka-engine/src/fork_recovery.rs` (deterministic ordering key) + `cgka-engine/src/convergence.rs` (branch scoring) + `cgka-engine/src/distributed_convergence.rs` (stored-message replay) + `cgka-engine/src/epoch_manager.rs` (state transitions). The TS `GroupHistoryTree` corresponds to Rust's stored-message persistence in `cgka-engine/src/message_processor/store.rs` + the SQLite snapshot store.

---

### 3. Retained History and Epoch-Secret Retention

```
On each accepted canonical commit:
    GroupHistoryTree.recordCommit()      [src/engine/history-tree.ts]   (persisted)
    RetainedHistoryStore.record()        [src/engine/retained-store.ts]  (in-memory)
        • stores ClientState at tip epoch
        • stores applied MlsMessage for that source epoch
        • prunes states older than tip - max_rewind_commits (= 5)

Cross-epoch app-payload decrypt:
    ingestEnvelopes() calls IngestionPool.states()
        → iterates retained ClientState objects
        → tries NostrGroupPeeler.peelGroupMessages() against each
        → accepts the first epoch that successfully decrypts
```

**Where exporter secrets live in TS:** Inside `ClientState.keySchedule.exporterSecret` (a field of `ts-mls` `ClientState`). Each `RetainedHistoryStore` entry holds a full `ClientState`, so each has its own exporter secret.

**Rust parallel:** `cgka-engine/src/group_context_view.rs` `GroupContextView::exporter_secret(label, length)` caches the exporter per epoch. Rust retains MLS group snapshots (via `StorageProvider::snapshot`) and can call `export_secret` on any retained `MlsGroup` state.

**M9 gap location (source-epoch media-secret retention):** The media-key derivation call lives in `src/core/media/crypto.ts`. It currently derives the key from a single `ClientState` (the tip). The retained exporter secrets needed for cross-epoch media decrypt are available via `RetainedHistoryStore.states()` (each holds a full `ClientState` with its own `keySchedule.exporterSecret`), but the media service plumbing to iterate over them is missing. The fix: pass `RetainedHistoryStore` (or an iterable of exporter secrets keyed by epoch) into the media decrypt path so it can try each retained epoch.

---

### 4. Media Encrypt/Decrypt (encrypted-media-v1, relevant to M9)

```
Encrypt (outbound):
    app → MarmotGroup.send({ kind: MediaSend, ... })
        → engine derives media key from tip ClientState via src/core/media/crypto.ts
        → mlsExporter(exporterSecret, label="marmot-media", context=..., 32 bytes)
        → ChaCha20-Poly1305 seal of plaintext

Decrypt (inbound):
    app receives accepted ApplicationMessage
        → src/core/media/crypto.ts: derive key from SINGLE ClientState (tip)
        → ChaCha20-Poly1305 unseal

PROBLEM (M9): Media from an older epoch uses a different exporter secret.
Current code only tries the tip-epoch ClientState.
Fix seam: src/core/media/crypto.ts + caller in client layer that
          provides retained epoch states from RetainedHistoryStore.
```

**Rust parallel:** `cgka-engine/src/group_context_view.rs` stores the exporter secret per-snapshot. An app calling `GroupContextView::exporter_secret` after commit confirmation retrieves the per-epoch secret. The Rust app layer has the key available per epoch via the retained snapshots without extra wiring.

**Key derivation label:** `src/core/group-message-crypto.ts` uses `label="marmot"`, `context=encode("group-event")`. Confirm the media path uses the correct label per spec (`group-encrypted-media-v1` app-component section) — this is an audit checkpoint.

---

### 5. Welcome / Join Flow

```
Invitee receives kind-1059 (NIP-59 gift-wrap):
    InviteManager.watchInvites()         [src/client/invite-manager.ts]
        → NIP-59 unwrap → kind-444 rumor
        → NostrWelcomeDelivery or welcome event decode
        → getWelcome(rumor)              [src/core/welcome-event.ts]
            • decodes MLSMessage (mls_welcome wire format)
            • checks 'e' tag (KeyPackage event id) and 'relays' tag

    MarmotClient.joinGroup(welcome, keyPackage)
        → joinGroupFromWelcome()         [src/core/welcome-join.ts]
            → ts-mls joinGroup()
                • validates GroupInfo ratchet_tree extension
                • validates all leaf credentials / identity proofs
                • returns ClientState

    Post-join:
        → MarmotGroupView validation     [src/core/client-state.ts]
        → store state + routing info
        → schedule self-update commit
```

**m8 gap location (welcome recipient binding):** The spec (`joining.md` step 1–2) requires: (1) verify Welcome is addressed to this account identity, and (2) verify referenced KeyPackage belongs to this account/device. Step 2 is covered by `ts-mls joinGroup()` consuming the private key material. Step 1 (account-identity binding check — "reject welcome not addressed to my account") is what `src/core/welcome.ts` (`src/core/welcome-join.ts`) may not be enforcing explicitly before calling `joinGroup`. The audit needs to confirm whether `joinGroupFromWelcome` in `src/core/welcome-join.ts` checks the Welcome author's MLS-authenticated identity against the invitee's account pubkey before completing.

**Rust parallel:** `cgka-engine/src/group_lifecycle.rs::do_join_welcome()` enforces full spec flow including dedup via `seen_message_ids` (Sm4 fix). Welcome dedup added in darkmatter audit correction Sm4.

**Admin check (spec step 8):** The joining spec requires the Welcome author to be an active admin in the resulting group state. TS needs to verify this post-`joinGroup` — check `src/core/welcome-join.ts` for this validation step.

---

### 6. Publish Lifecycle

```
Local commit intent (e.g., invite, group-profile update):
    MarmotGroup.send(intent)             [src/client/group/marmot-group.ts]
        → GroupSession.send()
        → MarmotGroupEngine.send(intent)
            → ts-mls createCommit()
            → NostrGroupPeeler.wrapGroupMessage()  (produce kind-445 envelope)
            → engine transitions: Stable → PendingPublish
            → returns (pending: PendingState, envelope: NostrEvent)

    GroupRuntime.publishCommit()         [src/client/runtime/group-runtime.ts]
        → NostrNetworkInterface.publish(envelope)
        → relay ACK → engine.confirmPublished(pending)
                            → ts-mls merge_pending_commit()
                            → Merging → Stable
                            → record in RetainedHistoryStore + GroupHistoryTree
        → relay NACK → engine.publishFailed(pending)
                            → ts-mls clear_pending_commit()
                            → PendingPublish → Stable (revert)

    Welcome delivery (after commit ACK):
        GroupRuntime picks up welcome from commit result
        → NostrWelcomeDelivery.deliver() [src/client/transport/nostr/welcome-delivery.ts]
            → NIP-59 gift-wrap → publish to invitee inbox
```

**Rust parallel:** `cgka-engine/src/publish.rs` (`do_confirm_published` / `do_publish_failed`) + `EpochManager` (atomic state transitions). TS `engine.confirmPublished()` matches `CgkaEngine::confirm_published`. Rust enforces welcome-after-commit-ACK at the session layer (`cgka-session`, `marmot-account::runtime`).

---

## Component Boundaries

| Boundary           | TS Side                                                    | Rust Side                                              | Protocol-defined seam                                                                   |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Transport / Engine | `GroupPeeler<TEnvelope>` interface (`src/engine/types.ts`) | `TransportPeeler` trait (`cgka-traits/src/peeler.rs`)  | spec: transport owns outer envelope; protocol-core owns when MLS bytes become canonical |
| Engine / MLS       | `ts-mls` `ClientState`, `processMessage`                   | OpenMLS `MlsGroup`, `process_message`                  | RFC 9420 MLS state transition                                                           |
| Engine / Storage   | `GenericKeyValueStore<V>` (`src/utils/key-value.ts`)       | `StorageProvider` trait (`cgka-traits/src/storage.rs`) | Local contract; not wire-visible                                                        |
| Core / Client      | `src/core/` has zero I/O                                   | `cgka-traits` + `cgka-engine` have no Nostr deps       | No Nostr types in engine or core                                                        |
| Publish obligation | `PendingState` (`src/engine/types.ts`)                     | `PendingStateRef` (`cgka-traits`)                      | spec: pending ref is local; not a wire type                                             |

---

## Seams for Known Open Items

### M9 — Source-epoch media-secret retention

**Where the gap lives:** `src/core/media/crypto.ts` (key derivation) called from the client media decrypt path. The retained secrets per epoch are available in `RetainedHistoryStore` (each entry is a full `ClientState` with `keySchedule.exporterSecret`), but the media decrypt caller does not iterate them.

**Fix surface:**

1. `src/core/media/crypto.ts` — extend the key-derivation API to accept an iterable of exporter secrets (or epoch → exporter secret map) rather than a single `ClientState`.
2. Caller in `src/client/` — thread `retainedStore.states()` into the media decrypt call so cross-epoch media can try each retained epoch's secret in reverse order until one succeeds.
3. Pruning pin — the spec requires not pruning states still needed to decrypt app payloads inside `app_payload_past_epoch_limit` (5 epochs). Confirm `RetainedHistoryStore.prune()` respects this window for media as well as commit replay.

**Rust comparison (HIGH confidence):** Rust does not have this gap because `GroupContextView::exporter_secret` is available per snapshot and the media layer calls it with the source epoch directly.

---

### m9 — kind-445 sig-before-decrypt

**Where the gap lives:** `NostrGroupPeeler.peelGroupMessages()` (`src/client/group/nostr-peeler.ts`) → `decryptGroupMessages()` (`src/core/group-message.ts`). Neither function verifies the Nostr event `id` (SHA-256 of serialized event) or `sig` (Schnorr over `id`) before attempting ChaCha20-Poly1305 decryption.

**Implications:** A malformed or tampered kind-445 event whose `id`/`sig` are invalid will be attempted for decryption before being rejected at the MLS layer (which validates MLS-level authenticity internally). This is defense-in-depth: MLS validation will reject garbage data, but it is cleaner and cheaper to fail-fast at the Nostr event boundary.

**Fix surface:** Add `verifyEvent(event)` (from applesauce-core or a NIP-01 validator) to `NostrGroupPeeler.peelGroupMessages()` before the decrypt call, and route failures to the `unreadable` result bucket. Alternatively, verify in `GroupSession.ingest()` before dispatch to the engine, treating invalid-sig events as `stale` with `invalidSignature` category.

**Rust comparison:** `transport-nostr-peeler/src/peeler.rs` documentation notes "per-event ephemeral signing" — the Rust peeler owns sig-before-decrypt at its boundary. The TS equivalent must add this at `NostrGroupPeeler`.

---

### m8 — Welcome recipient binding

**Where the gap lives:** `src/core/welcome-join.ts`. The spec (`joining.md` steps 1–2, 6, 8) requires:

- Step 1: Welcome addressed to this account identity.
- Step 2: Referenced KeyPackage belongs to this account/device.
- Step 6: Welcome author identified from MLS GroupInfo signer leaf + account identity validated.
- Step 8: Welcome author is an active admin in the resulting group state.

Step 2 is handled by `ts-mls joinGroup()` (private key material match). Steps 1, 6, 8 require post-`joinGroup` checks against the resulting `ClientState`. The audit must confirm these are enforced in `src/core/welcome-join.ts` or `src/client/invite-manager.ts` before the Welcome is accepted.

**Fix surface:** `src/core/welcome-join.ts` (or a validation wrapper) — after `joinGroup()` returns a `ClientState`, extract the Welcome-author leaf from the `ratchet_tree`, verify its `AccountIdentityProof`, confirm the author's account pubkey appears in the `admin-policy.v1` admin set of the resulting group state.

---

## Audit Ordering by Architectural Dependency

The dependency direction in both TS and Rust is strict and should drive audit order:

```
1. Foundation (encoding, identity, KeyPackage framing, error vocabulary)
        ↓ feeds
2. Core / traits (app-component codecs, lifecycle FSM, convergence policy)
        ↓ feeds
3. Engine (ingest pipeline, fork recovery, retained history, publish lifecycle)
        ↓ feeds
4. Transport peeler (Nostr kind-445 wrap/peel, NIP-59 welcome)
        ↓ feeds
5. Client / session / runtime (Nostr network, publish obligation, welcome delivery)
        ↓ feeds
6. App-component features (encrypted-media-v1, avatar-url, agent-text-stream)
```

**Recommended audit pass order:**

1. **Transport wire format** — kind-445 framing, sig-before-decrypt (m9), MLSMessage wire format (PublicMessage). Rust ref: `transport-nostr-peeler`.
2. **Welcome / join flow** — recipient binding (m8), admin check, KeyPackage rotation, ratchet_tree requirement. Rust ref: `cgka-engine/src/group_lifecycle.rs`.
3. **Retained history + epoch secrets** — pruning pin rule, app-payload window, M9 media-secret retention. Rust ref: `cgka-engine/src/group_context_view.rs`.
4. **Inbound processing** — deferred/stale classification, dedup, disposition vocabulary parity. Rust ref: `cgka-engine/src/message_processor/ingest.rs`.
5. **Convergence** — branch scoring algorithm, settlement quiescence, `Resolving` vs `Settled` distinction (Rust Sm2 fix). Rust ref: `cgka-engine/src/convergence.rs` + `canonicalization.rs`.
6. **Publish lifecycle** — PendingPublish gates, Welcome-after-commit-ACK ordering. Rust ref: `cgka-engine/src/publish.rs`.
7. **App components** — encrypted-media URL normalization (m7), avatar-url 0x8007 vs blossom-image 0x8002 (m3), admin-policy codec parity. Rust ref: `cgka-traits/src/app_components/`.

---

## Anti-Patterns

### Importing engine types via client barrel

Using `@internet-privacy/marmot-ts` root import for `MarmotGroupEngine` collapses the transport-agnostic boundary. Use `@internet-privacy/marmot-ts/engine` for engine-level access.

### Retrying a half-drained ingest generator

`MarmotGroupEngine.ingest()` returns an `AsyncGenerator`. Partial iteration skips convergence settlement, pool sweeps, and auto-commit steps. Always drain to completion with `for await ... of`.

### Reusing a staged commit after convergence

A staged commit created before `selectCanonicalBranch` MUST NOT be reused after convergence changes the canonical state. The engine's lifecycle gate (`mayPrepareLocalCommit`) enforces this, but callers must not cache the pending state reference across a `Recovering → Stable` transition.

---

## Sources

- `darkmatter/spec/protocol-core/inbound-processing.md` — inbound pipeline spec
- `darkmatter/spec/protocol-core/convergence.md` — branch scoring, eligibility, policy constants
- `darkmatter/spec/protocol-core/retained-history.md` — anchor, app-payload window, pruning
- `darkmatter/spec/protocol-core/publish-lifecycle.md` — publish-before-apply rule
- `darkmatter/spec/protocol-core/joining.md` — Welcome receiving flow (steps 1–13)
- `darkmatter/spec/protocol-core/group-state.md` — lifecycle states and legal transitions
- `darkmatter/spec/implementation-model.md` — darkmatter name mapping (`CgkaEngine`, `PendingStateRef`, etc.)
- `darkmatter/crates/cgka-engine/AGENTS.md` — full subsystem map + audit corrections (B1–B3, Sm1–Sm7, H1)
- `darkmatter/crates/traits/AGENTS.md` — shared trait/type boundaries
- `darkmatter/crates/transport-nostr-peeler/AGENTS.md` — Nostr kind-445 peel/wrap boundary
- `darkmatter/crates/cgka-session/AGENTS.md` — session lifecycle wiring
- `darkmatter/crates/marmot-account/AGENTS.md` — account/runtime orchestration
- `darkmatter/spec/app-components/group-encrypted-media-v1.md` — media policy wire format (M9)
- `.planning/codebase/ARCHITECTURE.md` — TS architecture baseline (current state)
- `src/engine/group-engine.ts`, `src/engine/retained-store.ts`, `src/engine/fork-recovery.ts`
- `src/client/group/nostr-peeler.ts`, `src/core/group-message-crypto.ts`
- `src/core/welcome-join.ts`, `src/core/retained-history.ts`

---

_Architecture research for: Marmot (MLS over Nostr) TypeScript client — gap audit layer mapping_
_Researched: 2026-07-01_
