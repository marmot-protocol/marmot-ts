# Codebase Concerns

**Analysis Date:** 2026-07-07

This audit reflects the `dark-matter` branch mid-milestone state. The library completed its
darkmatter migration baseline (B1–B7, M1–M8, encrypted-media wire format) but the darkmatter
spec submodule has advanced ~59 commits and several single-device conformance gaps remain open
(tracked in `.planning/ROADMAP.md` / `.planning/REQUIREMENTS.md`). Concerns below combine
confirmed code-level findings with the planned closure backlog.

## Tech Debt

**Client tag parsing incomplete (NIP-89):**
- Issue: Key-package / protocol client tag is only partially parsed; the rest of the tag fields are dropped.
- Files: `src/core/key-package-event-decode.ts:105`, `src/core/protocol.ts:56` (both carry explicit `// TODO`)
- Impact: Downstream apps cannot read full client-attribution metadata; potential round-trip loss on re-encode.
- Fix approach: Complete the NIP-89 client tag parser and preserve all fields through decode/encode.

**Stale/legacy dead code from wire-format migration:**
- Issue: `core/group-message-classify.ts` is PrivateMessage-only and superseded by the PublicMessage handshake path (per project memory "Handshake Wire-Format Mismatch — safe to retire").
- Files: `src/core/group-message-classify.ts`
- Impact: Dead code invites accidental use of the wrong classifier; confuses new contributors.
- Fix approach: Delete the module and confirm no imports remain (`grep -rn group-message-classify src/`).

**Very large engine module:**
- Issue: `MarmotGroupEngine` is 1704 lines — ingest, send, fork recovery, lifecycle, and admin policy all in one class.
- Files: `src/engine/group-engine.ts` (1704 lines), `src/engine/ingest.ts` (812 lines)
- Impact: High cognitive load; hard to test units in isolation; merge-conflict hotspot.
- Fix approach: Extract cohesive responsibilities (fork recovery driver, lifecycle transitions, send staging) behind the existing helper modules already present in `src/engine/`.

## Known Bugs

**Cross-epoch media decryption failure (M9 / MEDIA-01, MEDIA-02):**
- Symptoms: Media sent at epoch N cannot be decrypted once the group advances to epoch N+2.
- Files: `src/core/media/crypto.ts` (derives the file key from `clientState.keySchedule.exporterSecret` of a single epoch), `src/engine/group-engine.ts` (does not expose retained per-epoch exporter secrets)
- Trigger: Send media, advance state twice via commits, then attempt decrypt — the current tip's exporter secret no longer matches the source epoch.
- Workaround: None in-tree. Requires the engine to expose a `getRetainedStates()` / epoch→exporterSecret accessor (MEDIA-01) and the media service to decrypt with the source-epoch secret (MEDIA-02).

**Convergence apply-gating under PendingPublish (CONV-01):**
- Symptoms: An inbound commit arriving while a local commit is staged may advance canonical state instead of being deferred.
- Files: `src/engine/ingest.ts`, `src/engine/group-engine.ts` (lifecycle FSM), `src/core/convergence.ts`
- Trigger: Receive a competing inbound commit during `PendingPublish` before the local commit is acknowledged.
- Workaround: None; closure requires gating inbound apply through `mayApplyRetainedInbound()` and returning `deferred`.

## Security Considerations

**No Nostr signature verification before decryption (SEC-01 / m9):**
- Risk: kind-445 group messages are decrypted (ChaCha20-Poly1305) before the Nostr event id/signature is verified, exposing the AEAD path to unauthenticated/forged inputs.
- Files: `src/engine/ingest.ts` (only `verifyApplicationRumorAuthorship` at line 231, applied post-decrypt; no `verifyEvent`/signature check on the kind-445 envelope), `src/client/group/nostr-peeler.ts`
- Current mitigation: Application-rumor authorship is verified after decryption; MLS framing authenticates content, but the outer Nostr event signature is not checked first.
- Recommendations: Verify the Nostr event id + signature before any decryption; route failures to `unreadable` / `invalid_signature` disposition (SEC-01).

**Welcome recipient/author binding not enforced (SEC-02 / m8):**
- Risk: A Welcome not addressed to the local account identity, or authored by a non-admin, may be processed by `joinGroup()`.
- Files: `src/core/welcome-join.ts`, `src/core/welcome-event.ts`, `src/client/invite-manager.ts`
- Current mitigation: Partial; explicit recipient binding and active-admin author validation are outstanding.
- Recommendations: Reject welcomes not addressed to this account pubkey before `joinGroup()`, and validate the welcome author is an active admin (SEC-02).

**Broad catch-and-continue in codec/crypto paths:**
- Risk: Silent `catch {}` blocks may mask decode/crypto failures and make malformed input indistinguishable from benign skips.
- Files: `src/core/group-message-crypto.ts` (lines 38, 94, 198, 210), `src/core/client-state.ts` (222, 238, 276, 407), `src/client/marmot-client.ts` (257, 278, 302, 320), `src/core/credential.ts:25`
- Current mitigation: Most map to intentional `unreadable`/`skipped` dispositions in the ingest pipeline.
- Recommendations: Audit each swallow site; ensure security-relevant failures are surfaced (logged via `debug` and/or emitted as an audit event), not silently dropped.

## Performance Bottlenecks

**Ingestion pool retry as tree grows:**
- Problem: Undecryptable envelopes are re-tried against the history tree as it grows; unbounded retention could cause repeated re-processing.
- Files: `src/engine/ingestion-pool.ts`, `src/engine/history-tree.ts` (621 lines)
- Cause: Fork-aware history requires holding envelopes until a matching branch appears.
- Improvement path: Confirm the rollback horizon (`maxRewindCommits` / quiescence window in `DEFAULT_CONVERGENCE_POLICY`) bounds pool size; add metrics/tests for pool growth under sustained forks.

## Fragile Areas

**Fork recovery / convergence branch selection:**
- Files: `src/engine/fork-recovery.ts` (366 lines), `src/core/convergence.ts` (315 lines), `src/engine/retained-store.ts`, `src/engine/history-tree.ts`
- Why fragile: Correctness depends on canonical (transport-order-free) ordering; any leakage of relay-delivery order into the comparator causes two peers to diverge (CONV-02). The convergence gate can be deliberately bypassed (documented in project memory "Forker Example App").
- Safe modification: Never introduce arrival-order or timestamp-of-receipt into fork choice; keep the comparator a pure function of canonical fields. Add dual-ordering tests (two in-memory instances, opposite delivery order → same branch).
- Test coverage: Engine has 10 test files for 15 source files; convergence-specific dual-ordering coverage is a Phase 2 deliverable (CONV-02).

**QUIC VarInt canonicality (WIRE-01):**
- Files: `src/core/binary.ts` (419 lines), `src/core/components/dictionary.ts`, `src/core/components/encrypted-media.ts`
- Why fragile: Non-shortest-prefix (over-long) VarInt encodings may currently be silently accepted rather than rejected, breaking byte-for-byte darkmatter interop.
- Safe modification: Reject non-canonical length prefixes with an encoding error across all component codecs; add a test that encodes an over-long VarInt and asserts the decoder throws.

**Public message classifiers vs. real wire format (API-01):**
- Files: engine PublicMessage emit path in `src/engine/group-engine.ts`; `isCommitMessage` / `isProposalMessage` helpers
- Why fragile: Classifiers must guard on the `mls_public_message` wireformat the engine actually emits; a mismatch makes them return `false` for real engine output.
- Test coverage: Requires a test asserting `true` for real PublicMessage engine output (API-01).

## Scaling Limits

**Single-threaded async-generator ingest:**
- Current capacity: All group state is per-instance and processed on a single-threaded ESM event loop; `ingest()` is an `AsyncGenerator` that callers must drain fully before the next batch.
- Limit: No worker-thread parallelism; large fork trees or high message volume are processed serially per group.
- Scaling path: Out of scope for this milestone (single-device wire-complete). Multi-device (MIP-06) is explicitly deferred.

## Dependencies at Risk

**`ts-mls` local workspace pre-release:**
- Risk: `ts-mls` is a local workspace package (`./ts-mls`, v2.0.0-rc.14) rather than a published npm release; it must be built before the library, and it tracks a moving darkmatter spec.
- Impact: Build ordering fragility (`pnpm --filter ts-mls build` must precede library build); API churn from RC versions.
- Migration plan: Track ts-mls toward a stable 2.0.0 release; pin and lock once the wire format stabilizes against darkmatter.

**darkmatter reference is a moving target:**
- Risk: The Rust `darkmatter` spec submodule has advanced ~59 commits ahead of the last gap analysis; byte-exact interop is defined against a shifting source of truth.
- Impact: Conformance gaps accumulate silently between audits.
- Migration plan: Phase 1 (Exhaustive Gap Audit) re-verifies every gap against the current submodule; Phase 4 cross-checks each closure against `darkmatter/crates/` output.

## Missing Critical Features

**NIP-40 expiration + routing-rotation subscription (WIRE-03, WIRE-04):**
- Problem: NIP-40 expiration tags may not be emitted where the spec requires; routing-rotation subscription handling is unconfirmed.
- Blocks: Full spec conformance; pending Phase 1 audit to confirm applicability or record as not-applicable.

**blossom-image (0x8002) unsupported:**
- Problem: blossom-image component is not supported; avatar-url (0x8007) is the supported alternative.
- Blocks: Nothing for this milestone — must be formally documented as unsupported in source and docs (DOC-01, Phase 3).

**Deferred tracks (explicitly out of scope):**
- Multi-device (MIP-06) and push (MIP-05) and the QUIC data plane are cataloged and deferred. The library advertises the agent-text-stream-QUIC `receive` capability (0xf2d1) as an honest marker only — there is no QUIC data plane behind it (project memory "KeyPackage Role Capabilities").

## Test Coverage Gaps

**Audit and extra subsystems thinly tested:**
- What's not tested: `src/audit/` has 1 test file for 7 source files; `src/extra/` has 2 tests for 6 files; `src/utils/` has 2 tests for 8 files.
- Files: `src/audit/*`, `src/extra/audit/node.ts` (209 lines), `src/extra/encrypted-key-value-store.ts`
- Risk: Audit sink failures are caught and silenced by design (`AuditEmitter.emit()`); regressions could go unnoticed. Encrypted store crypto errors are surfaced only through `catch` blocks (lines 144, 152, 193).
- Priority: Medium — audit is opt-in and non-protocol, but the encrypted store handles secret material.

**Convergence / media / security closure tests outstanding:**
- What's not tested: Cross-epoch media decrypt (MEDIA-02), dual-ordering convergence (CONV-02), sig-before-decrypt routing (SEC-01), PublicMessage classifier output (API-01), non-canonical VarInt rejection (WIRE-01), duplicate kind-30443 tag rejection (WIRE-02).
- Files: `src/core/media/crypto.ts`, `src/core/convergence.ts`, `src/engine/ingest.ts`, `src/core/binary.ts`, `src/core/key-package-event-decode.ts`
- Risk: These are the exact behaviors that guarantee byte-for-byte darkmatter interop; without tests, regressions are invisible until interop breaks.
- Priority: High — these are the Phase 2/3 milestone deliverables.

---

*Concerns audit: 2026-07-07*
