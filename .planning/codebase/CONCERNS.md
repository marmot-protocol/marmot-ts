# Codebase Concerns

**Analysis Date:** 2026-07-01

---

## Tech Debt

**`group-message-classify.ts` — PrivateMessage-only API now exported but engine-dead:**
- Issue: `sortGroupCommits`, `isApplicationMessage`, `isCommitMessage`, `isProposalMessage` in `src/core/group-message-classify.ts` all guard on `mls_private_message` wireformat. The engine now sends commits as `PublicMessage`; these predicates return incorrect results for commits and proposals (always `false`). The engine's own hot-path uses `framedContentType()` from `src/engine/wire-format.ts` directly, never these classify helpers.
- Files: `src/core/group-message-classify.ts`, `src/core/group-message.ts` (re-exports them), `src/engine/wire-format.ts` (correct replacement)
- Impact: Any downstream caller relying on `isCommitMessage` or `isProposalMessage` from the public API will get `false` for all PublicMessage commits/proposals. `sortGroupCommits` computes `sourceEpoch` as 0 for PublicMessage commits, producing incorrect sort order.
- Fix approach: Either update the classify functions to use `framedContentType`/`framedEpoch` (mirroring `wire-format.ts`), or mark the three predicate functions `@deprecated` and document `framedContentType` as the replacement. Remove re-export from public `src/core/group-message.ts` once callers migrate.

**`KeyValueStoreBackend` deprecated type alias still in public API:**
- Issue: `src/utils/key-value.ts:19-20` exports `KeyValueStoreBackend<I>` as a `@deprecated` alias for `GenericKeyValueStore<I>`. The alias is still part of the `./utils` entrypoint.
- Files: `src/utils/key-value.ts`
- Impact: Downstream code may still import the deprecated name and lock the API surface to the alias.
- Fix approach: Remove `KeyValueStoreBackend` after a deprecation cycle; check external usage and add a changelog note.

**`deserializeApplicationRumor` deprecated alias still exported:**
- Issue: `src/core/application-rumor.ts:128-129` exports `deserializeApplicationRumor` as a `@deprecated` alias for `deserializeApplicationData`. The name propagates through `src/core/group-message.ts` into the `./core` entrypoint.
- Files: `src/core/application-rumor.ts`
- Impact: Clutters the public API and breaks tree-shaking for users that import the alias.
- Fix approach: Remove after next major version bump.

**TODO: partial NIP-89 client tag parsing:**
- Issue: `getKeyPackageClient()` in `src/core/key-package-event-decode.ts:99-108` only reads `tag[1]` (the name field). All additional NIP-89 client-tag fields are dropped silently. The `KeyPackageClient` type (`src/core/protocol.ts:54-57`) is a stub with a single `name` field.
- Files: `src/core/key-package-event-decode.ts`, `src/core/protocol.ts`
- Impact: Downstream tooling relying on client metadata (version, URL, pubkey) cannot read it.
- Fix approach: Extend `KeyPackageClient` with the full NIP-89 client-tag field set and update the decoder.

---

## Known Bugs

**`isApplicationMessage`, `isCommitMessage`, `isProposalMessage` always return `false` for engine-produced commits/proposals:**
- Symptoms: Calling any of these three functions on a `GroupMessagePair` whose `.message.wireformat` is `mls_public_message` always returns `false`, regardless of content type.
- Files: `src/core/group-message-classify.ts:53-83`
- Trigger: Any code path that calls these public helpers on the output of `group.ingest()` after the engine migrated to PublicMessage for commits/proposals.
- Workaround: Use `framedContentType(message)` from `src/engine/wire-format.ts` directly (not exported from the public entrypoint).

---

## Security Considerations

**`EncryptedKeyValueStore` is NOT production-safe — explicit class-level warning:**
- Risk: Uses AES-CBC (no authentication tag — malleable ciphertext), PBKDF2-SHA-256 with only 10,000 iterations (below NIST 2023 minimum of 210,000 for SHA-256), and a constant byte string (`"decryption test value"`) as a CBC oracle. The `unlock()` method's timing difference between "first setup" and "wrong password" paths could leak unlock status. The class has an explicit `WARNING: THIS IS NOT SECURE AND SHOULD NOT BE USED IN PRODUCTION` JSDoc comment.
- Files: `src/extra/encrypted-key-value-store.ts:63`, `src/extra/encrypted-key-value-store.ts:83`, `src/extra/encrypted-key-value-store.ts:100-101`
- Current mitigation: Warning comment in JSDoc; class exported under `./extra` not the main entrypoint.
- Recommendations: Replace with AES-256-GCM (or ChaCha20-Poly1305, matching the group-message crypto already used in `src/core/group-message-crypto.ts`). Raise PBKDF2 to ≥210,000 iterations or switch to Argon2id. Add an explicit authentication tag. Until rewritten, enforce that this class is only used in demo/development builds.

**m8 — Missing explicit welcome recipient binding:**
- Risk: `src/core/welcome-join.ts` does not check that a received welcome is addressed to the local account. The KeyPackageRef match in `src/client/marmot-client.ts:230` is a stronger structural check, but the spec-required "reject welcome not addressed to my account" explicit pubkey check is absent.
- Files: `src/core/welcome-join.ts`, `src/core/welcome-event.ts`
- Current mitigation: KeyPackageRef match acts as implicit recipient binding.
- Recommendations: Add explicit pubkey-based recipient check before attempting MLS welcome processing, per `foundation/welcome-v1.md` §Validation (tracked as m8 in `SPEC_GAP_REVIEW.md`).

**m9 (minor) — kind-445 Nostr event signature not verified before decryption:**
- Risk: `decryptGroupMessageEvent` in `src/core/group-message-crypto.ts` attempts decryption before verifying the Nostr event id or signature. A forged or corrupted event body may trigger the MLS AEAD layer before the envelope is authenticated at the transport layer.
- Files: `src/core/group-message-crypto.ts:165-176`
- Current mitigation: MLS AEAD (`chacha20poly1305`) will reject non-authentic ciphertexts; convergence-layer canonical checks provide a second gate. The spec cross-check (m9 in `SPEC_GAP_REVIEW.md`) is still open.
- Recommendations: Verify Nostr event `id` (SHA-256 of serialized fields) and Schnorr `sig` in the `NostrGroupPeeler.peelGroupMessages` path (`src/client/group/nostr-peeler.ts`) before passing events to `decryptGroupMessages`.

---

## Performance Bottlenecks

**`GroupHistoryTree` light index (`#nodes`) grows without bound:**
- Problem: `GroupHistoryTree` (`src/engine/history-tree.ts:108`) explicitly performs no pruning on the node metadata map `#nodes`. Every state ever observed — canonical and every fork branch — is retained in memory for the lifetime of the engine.
- Files: `src/engine/history-tree.ts:125-126` (`readonly #nodes = new Map<string, MutableNode>()`)
- Cause: Pruning is deferred to a future implementation; the heavy LRU cache is bounded but the light index is not.
- Improvement path: Add a pruning pass that drops nodes whose epoch is older than `maxRewindCommits` below the canonical tip AND that have no live fork descendants. Coordinate with `RetainedHistoryStore` pruning to avoid invalidating states still needed for convergence.

**`#seenContentIds` / `#sentContentIds` grow without eviction:**
- Problem: Both dedup Sets in `MarmotGroupEngine` (`src/engine/group-engine.ts:218,225`) are process-lifetime with no max-size cap and no eviction. Long-running nodes that see high message volumes (especially replay attacks with unique content ids) will accumulate entries indefinitely.
- Files: `src/engine/group-engine.ts:218-225`
- Cause: Design choice (noted in `SPEC_GAP_REVIEW.md` m6 — Rust reference has a durable storage-backed layer with natural LRU). The current in-memory form has no eviction.
- Improvement path: Add a max-size cap with LRU eviction. The Rust reference also persists these sets across restarts; the TS version re-delivers duplicate messages after a process restart.

**`GroupsManager.#connectGroup()` per-subscription `seen` Set grows without bound:**
- Problem: `src/client/groups-manager.ts:450-453` — a `Set<string>` accumulates every event id seen on a group subscription for the lifetime of the subscription. A high-traffic group or a subscription that is never torn down will grow this Set indefinitely.
- Files: `src/client/groups-manager.ts:450`
- Cause: Simple dedup to prevent double-delivery within a subscription batch; no eviction.
- Improvement path: Replace with an LRU-capped string Set or rely solely on the engine's own `#seenContentIds` dedup, removing the redundant outer gate.

---

## Fragile Areas

**M9 — Media decryption silently falls back to live epoch instead of source epoch:**
- Files: `src/client/group/group-media-service.ts:168-179`
- Why fragile: `#candidateStates()` tries retained states but always includes the live state first. If retained per-epoch exporter secrets are not plumbed from the engine (the gap noted in `SPEC_GAP_REVIEW.md` M9), media from any epoch older than the live tip silently fails to decrypt with no distinguishable error. The media layer has no way to report "decryption failed because source-epoch secret is unavailable" vs "decryption failed because the message is corrupt."
- Safe modification: Do not change `#candidateStates()` ordering until source-epoch plumbing is wired in. Adding a `getRetainedStates` accessor to `GroupSession` / `MarmotGroupEngine` and passing it into `GroupMediaService` is the intended fix path (see `SPEC_GAP_REVIEW.md` M9).
- Test coverage: `src/client/group/__tests__/group-media-service.test.ts` covers decrypt-on-current-epoch but not cross-epoch decrypt.

**Ingest apply-gating gap (`mayApplyRetainedInbound` is defined but never called in ingest):**
- Files: `src/core/group-lifecycle.ts:74` (predicate defined), `src/engine/ingest.ts` (not called)
- Why fragile: `mayApplyRetainedInbound()` returns `false` for `PendingPublish`/`Merging` states, preventing inbound commits from advancing canonical state while a local commit is staged. The ingest pipeline (`ingestEnvelopes`) does not call this predicate, so an inbound commit can advance the canonical tip underneath a staged local commit. The pinning in `RetainedHistoryStore` (`SPEC_GAP_REVIEW.md` m4) prevents the source epoch from being pruned, but the apply-gating gap means the engine may enter an inconsistent lifecycle state.
- Safe modification: Add a `mayApply: () => boolean` check in `ingestEnvelopes` (`src/engine/ingest.ts`) before applying a commit, returning `deferred` when the check fails. This is tracked as an open gap in `SPEC_GAP_REVIEW.md` m4 note.
- Test coverage: No dedicated tests for apply-gating behavior during `PendingPublish`.

**`group-message-classify.ts` — stale wireformat assumption exposed on public API:**
- Files: `src/core/group-message-classify.ts`, `src/core/group-message.ts`
- Why fragile: Because these functions are re-exported from the public `./core` entrypoint, external downstream callers may use them and receive silently wrong results. There are no runtime errors — just silent `false` returns for valid engine output.
- Safe modification: Do not rely on `isCommitMessage` / `isProposalMessage` / `sortGroupCommits` in new code. Use `framedContentType` / `framedEpoch` from `src/engine/wire-format.ts` (currently not re-exported from any public entrypoint — only accessible internally).
- Test coverage: Integration test in `src/__tests__/integration/ingest-commit-race.test.ts:139-140` calls `sortGroupCommits` but uses test-constructed `mls_private_message` messages, not real engine output.

---

## Scaling Limits

**`RetainedHistoryStore` bounded to `maxRewindCommits` (default 5):**
- Current capacity: Retains up to `maxRewindCommits + 1` canonical states and commit messages in memory per group.
- Limit: Fork recovery and convergence branch selection cannot reach commits/states older than `tip - maxRewindCommits`. Groups with sustained high-volume concurrent writes from many members may require a larger window.
- Scaling path: Increase `DEFAULT_CONVERGENCE_POLICY.maxRewindCommits` (`src/core/convergence.ts:60`) and the matching `maxWitnessOverrideDepth`.

**`IngestionPool` default 1,000-entry cap per group:**
- Current capacity: `DEFAULT_MAX_SIZE = 1000` entries; default eviction at 256 epochs (`DEFAULT_MAX_EPOCH_AGE`) per group.
- Files: `src/engine/ingestion-pool.ts:30-32`
- Limit: Adversarial flooding with 1,001 unique undecryptable kind-445 envelopes silently evicts the oldest legitimate deferred entry, which is then never retried.
- Scaling path: Tune `IngestionPoolOptions.maxSize` on `MarmotGroup` construction for high-traffic groups.

---

## Dependencies at Risk

**None currently at risk.** The dependency chain (ts-mls, applesauce-core, @noble/*) is under active development by the same or aligned teams.

---

## Missing Critical Features

**Multi-device support (MIP-06) entirely absent:**
- Problem: Extension `0xf2f0` (multi-device), External-Commit carve-out, join-PSK exporter, and pairing payload are not implemented.
- Blocks: A user cannot participate in the same Marmot group from two devices. Any app requiring multi-device will need a custom workaround.

**Blossom-image component (0x8002) has no wire codec:**
- Problem: `GROUP_BLOSSOM_IMAGE_COMPONENT_ID` (`0x8002`) is registered in `src/core/components/ids.ts:27` but excluded from `SUPPORTED_APP_COMPONENT_IDS` (`:69`) and has no codec file. A group that _requires_ this component (`required_capabilities`) cannot be joined by this client.
- Files: `src/core/components/ids.ts:66-77`
- Decision needed: Implement the codec per `app-components/group-blossom-image-v1.md`, or formally document 0x8002 as unsupported and keep it excluded (tracked as m3 in `SPEC_GAP_REVIEW.md`).

---

## Test Coverage Gaps

**`isApplicationMessage`, `isCommitMessage`, `isProposalMessage` — no round-trip tests against real engine output:**
- What's not tested: These public API functions are only called in `src/__tests__/exports.test.ts` (shape test) and `src/__tests__/integration/ingest-commit-race.test.ts` with synthetic `mls_private_message` objects. No test exercises them against `mls_public_message` output from a real `MarmotGroupEngine`.
- Files: `src/core/group-message-classify.ts`, `src/__tests__/integration/ingest-commit-race.test.ts`
- Risk: The silent `false` return for PublicMessage inputs would not be caught by existing tests.
- Priority: High — these are in the public API and the bug is invisible without a cross-format test.

**Welcome recipient binding — no negative test for non-addressed welcome:**
- What's not tested: No test delivers a gift-wrapped welcome addressed to a different pubkey to verify it is rejected.
- Files: `src/core/welcome-join.ts`, `src/client/__tests__/invite-manager.test.ts`
- Risk: Acceptance of a mis-addressed welcome (low probability due to KeyPackageRef guard, but spec non-conformant).
- Priority: Medium.

**URL normalization edge-cases (`avatar-url`, `encrypted-media`):**
- What's not tested: No test vectors cover exotic percent-encoding, Unicode hostnames (IDNA), or non-standard schemes for `src/core/components/avatar-url.ts` and `src/core/components/encrypted-media.ts`.
- Files: `src/core/components/avatar-url.ts`, `src/core/components/encrypted-media.ts`, `src/core/components/__tests__/components.test.ts`
- Risk: Cross-implementation URL normalization drift causes a URL stored by one client to be rejected as non-canonical by another (tracked as m7 in `SPEC_GAP_REVIEW.md`).
- Priority: Medium.

**`GroupMediaService` cross-epoch decrypt — no test:**
- What's not tested: Decrypt of a media attachment encrypted under an older epoch when the group has advanced several epochs.
- Files: `src/client/group/group-media-service.ts`, `src/client/group/__tests__/group-media-service.test.ts`
- Risk: The M9 source-epoch plumbing gap goes undetected in CI.
- Priority: High (follows M9 fix).

**Ingest apply-gate during `PendingPublish` — no test:**
- What's not tested: Delivery of an inbound commit while a local commit is in `PendingPublish` state to verify the inbound is deferred and not applied.
- Files: `src/engine/ingest.ts`, `src/engine/group-engine.ts`
- Risk: The apply-gating gap (noted in `SPEC_GAP_REVIEW.md` m4) means this scenario produces unexpected state advances that are currently invisible in CI.
- Priority: High.

---

*Concerns audit: 2026-07-01*
