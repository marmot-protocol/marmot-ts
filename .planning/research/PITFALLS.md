# Pitfalls Research

**Domain:** Marmot v2 (MLS over Nostr) TypeScript client — dark-matter migration audit and closure
**Researched:** 2026-07-01
**Confidence:** HIGH — derived from spec text, Rust reference, existing codebase, and prior gap analysis

---

## Critical Pitfalls

### Pitfall 1: Source-Epoch Media Secret Not Threaded — Silent Decrypt Failure

**What goes wrong:**
`GroupMediaService` passes the live-tip `ClientState` into `deriveMediaEncryptionKey` even when the media attachment was
encrypted under an older epoch. The current code (`group-media-service.ts:168-179`) calls `#candidateStates()` which
always includes the live state first. `decryptMediaFileWithKeys` tries candidate keys in order until one authenticates
the ChaCha20-Poly1305 AEAD tag — but if only the correct source-epoch key is ever supplied, any attachment from an
epoch older than the live tip silently fails with "ciphertext did not authenticate under any retained epoch key"
rather than a distinguishable "source epoch unavailable" error. The wire format is correct; only the receive-side
plumbing is broken.

**Why it happens:**
`deriveMediaEncryptionKey` already accepts a `ClientState` and is correctly written — it calls the MLS exporter on
whatever state it receives. The gap is that `GroupMediaService` has no path to get retained per-epoch `ClientState`
objects from the engine. `GroupSession` / `MarmotGroupEngine` has no `getRetainedStates()` accessor, so the service
cannot iterate retained epochs. The multi-key decrypt API (`decryptMediaFileWithKeys`) exists and is correct; it just
never receives more than the current-tip key.

**How to avoid:**
1. Add a `getRetainedExporterSecrets(): Map<bigint, Uint8Array>` (or equivalent `ClientState[]` array) accessor to
   `MarmotGroupEngine` / `GroupSession` that surfaces retained states inside `RetainedHistoryStore`.
2. Pass these into `GroupMediaService` at construction time or via a callback.
3. Pass ALL retained `ClientState` objects to `decryptMediaFileWithKeys`, current epoch first.
4. Add a cross-epoch decrypt test: send media at epoch N, advance group to N+2, verify decrypt still works.

**Warning signs:**
- Any test that sends a media attachment then advances the group epoch produces a decrypt failure.
- `group-media-service.test.ts` only covers same-epoch decrypt; adding a cross-epoch test will expose the gap
  immediately.

**Phase to address:** Phase 2 (M9 close — the last open single-device BLOCKER)

---

### Pitfall 2: kind-445 Nostr Signature Not Verified Before Decrypt (m9)

**What goes wrong:**
The spec (`darkmatter/spec/transports/nostr.md`) says: "Receivers MUST verify the kind-445 event id and Nostr
signature before attempting to decrypt its content." The TS path does the opposite: `NostrGroupPeeler.peelGroupMessages`
calls `decryptGroupMessages`, which calls `decryptGroupMessageEvent`, which attempts AEAD decryption with no prior
id/sig check. A forged event with a valid-looking base64 content field and an invalid Schnorr signature will trigger
the ChaCha20-Poly1305 decryption attempt first.

**Why it happens:**
The MLS AEAD layer will reject a non-authentic ciphertext anyway, so the *security outcome* is the same: a forged event
never produces a valid MLS message. But the *order* matters for spec conformance and for a clean dispose path: the
transport envelope (Nostr event id + sig) must be validated as the outermost gate, before any cryptographic work on the
MLS payload. Transport metadata that fails the envelope check must be discarded at the transport layer, not at the MLS
layer.

**How to avoid:**
Add a Nostr event id + Schnorr signature verification step in `NostrGroupPeeler.peelGroupMessages` (or in the ingest
path in `GroupsManager`) before passing events to `decryptGroupMessages`. The check: `SHA-256(serialized fields) ==
event.id` and `schnorrVerify(event.sig, event.id, event.pubkey)`. Use `@noble/curves/secp256k1` (already a transitive
dep). Any event failing this check gets disposition `invalid_signature` and is never passed to the decryption layer.
Cross-check whether `applesauce-core` already verifies signatures upstream in the relay subscription path; if it does,
document that and close m9 with a comment. If not, the check must be explicit.

**Warning signs:**
- A test that constructs a kind-445 event with a corrupted `sig` field and verifies it is rejected with
  `invalid_signature` before decryption is attempted will catch this.
- If no such test exists, the gap is invisible in CI.

**Phase to address:** Phase 2 (m9 closure — security hardening)

---

### Pitfall 3: Welcome Recipient Binding Is Structural, Not Explicit (m8)

**What goes wrong:**
`src/core/welcome-join.ts` does not check that the received Welcome is addressed to the local account's pubkey.
`src/client/marmot-client.ts:230` does match on `KeyPackageRef` — which is a strong structural binding — but the
spec-required explicit check ("reject welcome not addressed to my account", `foundation/welcome-v1.md` §Validation)
via pubkey comparison is absent.

**Why it happens:**
The `KeyPackageRef` match is tight enough that a mis-addressed Welcome will almost certainly fail the structural check
too, so the bug is effectively low-probability. But spec conformance requires the pubkey check to run first, before the
MLS join attempt. An attacker who can forge a Welcome that passes `KeyPackageRef` matching but targets a different
account identity would pass the current gate.

**How to avoid:**
In `welcome-join.ts` or `welcome-event.ts`, before calling `joinGroup`, extract the intended recipient pubkey from the
Welcome (via the `GroupInfo` `app_data` or the git-wrapped Rumor's `pubkey`) and verify it equals the local account
identity. Add a negative test: construct a Welcome addressed to `account-B` and deliver it to `account-A`; verify
`wrong_recipient` disposition before any MLS work is attempted.

**Warning signs:**
- No test in `invite-manager.test.ts` that delivers a Welcome for a different pubkey and verifies rejection.
- The existing test suite only verifies acceptance paths.

**Phase to address:** Phase 2 (m8 closure — security hardening)

---

### Pitfall 4: QUIC Variable-Length Prefix Non-Canonical Encoding Accepted

**What goes wrong:**
`darkmatter/spec/foundation/canonical-encoding.md` ("QUIC length prefixes") mandates: "Canonical Marmot encoders MUST
use the shortest prefix size that can hold the length. Canonical Marmot decoders MUST reject a longer prefix for the
same value." For example, encoding a 7-byte field as `40 07` (2-byte prefix) instead of `07` (1-byte prefix) is
non-canonical and MUST be rejected. If the TS decoder accepts over-long QUIC prefixes, it will accept component state
bytes that the Rust decoder rejects — a commit containing such bytes would be accepted by TS but rejected by Rust,
forking the group.

**Why it happens:**
QUIC VarInt parsing is easy to write as "decode whatever prefix is indicated by the high bits" without adding a
re-encode-and-compare canonicality check. The ts-mls library parses MLS VarInts for MLS-owned structures; Marmot
component bytes (app_data_dictionary payloads) use Marmot's own binary profile and are typically parsed in TS code.

**How to avoid:**
Wherever Marmot-owned binary structures are decoded (component bytes in `src/core/components/*.ts`, any custom TLS
parsing), after reading a QUIC VarInt, verify `decoded_length` can only be represented by that prefix width (e.g.,
values 0–63 MUST use a 1-byte prefix). Add a canonicality round-trip test: encode a known structure, inject an
over-long length prefix, verify decoding throws `invalid_encoding`. Compare the `bytes.ts` codec against the spec table.

**Warning signs:**
- No test for over-long QUIC prefix rejection in `src/core/components/__tests__/`.
- A cross-impl vector test where the TS encoder produces bytes that the Rust decoder reads shows non-canonical length.

**Phase to address:** Phase 1 (gap audit) to identify affected decoders; Phase 2 (closure) to add rejection + tests.

---

### Pitfall 5: URL Normalization Divergence (WHATWG vs Rust `url` crate) on Exotic Inputs (m7)

**What goes wrong:**
`avatar-url` (0x8007) and `encrypted-media` (0x8008) component decoders re-run WHATWG parse-and-serialize and reject
URLs that are not byte-equal to the serializer's output. Both the WHATWG URL Standard and the Rust `url` crate
implement the same spec, so for ordinary ASCII URLs they produce identical output. But exotic inputs — IDNA hostnames
with Unicode characters, non-ASCII percent-encoding sequences, unusual path normalizations, query-string edge cases —
can diverge. If a URL stored by a Rust peer normalizes to `X` (Rust `url` crate output) but the TS WHATWG serializer
produces `Y`, the TS decoder will reject the commit containing `X` as non-canonical, and the group forks.

**Why it happens:**
The spec (`group-avatar-url-v1.md`) says normalization is producer-side and decoders must reject non-canonical bytes.
Both sides claim WHATWG compliance, but IDNA and percent-encoding edge cases have historically diverged between
implementations. The spec notes "the WHATWG standard is the normative definition" but IDNA encoding (punycode for
non-ASCII hostnames) has subtle Unicode version and compatibility-mode differences.

**How to avoid:**
Add conformance vectors that cover: (a) Unicode hostname (e.g. `https://münchen.de/`) → punycode,
(b) uppercase percent-encoding (`%2F` vs `%2f`), (c) default port elision (`https://example.com:443/`),
(d) empty path serialization (`https://example.com` → `https://example.com/`),
(e) query strings with special characters. Run these vectors through both the TS validator and the Rust `url` crate (or
a known-good WHATWG reference) and compare output bytes. Extract the Rust reference's actual test vectors from
`darkmatter/crates/` URL-handling code if available.

**Warning signs:**
- No test vector for IDNA / Unicode hostname in `src/core/components/__tests__/`.
- The comment in `src/core/components/url.ts` acknowledges "query strings are accepted and preserved (#374)" — meaning a
  prior divergence was already found. More may exist.

**Phase to address:** Phase 2 (m7 conformance vector addition)

---

### Pitfall 6: `isCommitMessage` / `isProposalMessage` Return `false` for All Engine Output

**What goes wrong:**
`src/core/group-message-classify.ts` predicates (`isCommitMessage`, `isProposalMessage`, `isApplicationMessage`,
`sortGroupCommits`) guard on `mls_private_message` wireformat. The engine now uses `mls_public_message` for all
commits and proposals. Any downstream caller importing these from the public `./core` entrypoint receives silently
wrong `false` results. `sortGroupCommits` also computes `sourceEpoch` as `0` for PublicMessage commits, producing
incorrect sort order.

**Why it happens:**
These functions predate the darkmatter migration and were not updated when the engine switched wireformats. They are
still exported from the `./core` public entrypoint, so external code may depend on them.

**How to avoid:**
Either (a) update the predicates to use `framedContentType()` / `framedEpoch()` from `src/engine/wire-format.ts`
(re-exporting from `./core`), or (b) mark them `@deprecated` and expose `framedContentType` as the replacement.
Add a round-trip integration test that calls `isCommitMessage` on the output of a real `MarmotGroupEngine.send()`
commit and asserts it returns `true`.

**Warning signs:**
- Existing test in `ingest-commit-race.test.ts` uses synthetic `mls_private_message` objects — it does not exercise
  real engine output, so the bug is invisible in CI.
- Any code path branching on `isCommitMessage()` result will produce wrong behavior silently.

**Phase to address:** Phase 2 (cleanup / public API correctness)

---

### Pitfall 7: Ingest Apply-Gating Not Called During `PendingPublish`

**What goes wrong:**
`mayApplyRetainedInbound()` in `src/core/group-lifecycle.ts` correctly returns `false` when the group is in
`PendingPublish` or `Merging` state — an inbound commit arriving while a local commit is staged should not advance
the canonical tip, per `inbound-processing.md` ("Deferred input"). But `ingestEnvelopes` in `src/engine/ingest.ts`
never calls this predicate. An inbound commit can therefore advance the canonical tip underneath a staged local commit,
leaving the engine in an inconsistent lifecycle state.

**Why it happens:**
The `m4` pruning fix (pinning source epoch on `PendingPublish` entry) makes the data safe (the source epoch state
is not pruned), but the apply-gate predicate is still unused. The pin and the gate are separate concerns — pin protects
retention, gate protects apply ordering.

**How to avoid:**
Add a `mayApply: () => boolean` guard in `ingestEnvelopes` before calling `processCommit`, returning `deferred`
disposition when the check fails. Test: put the engine into `PendingPublish`, deliver an inbound commit, verify the
inbound is deferred (not applied), confirm the canonical tip has not advanced, then confirm the inbound is
re-processed after `confirmPublished` resolves.

**Warning signs:**
- No test for `PendingPublish` + concurrent inbound commit in `ingest-commit-race.test.ts`.
- The CONCERNS doc explicitly notes "No dedicated tests for apply-gating behavior during `PendingPublish`."

**Phase to address:** Phase 2 (convergence hardening)

---

### Pitfall 8: Convergence Branch Selection Must Not Use Transport Order

**What goes wrong:**
The spec (`convergence.md`, "Branch selection") is explicit: "Transport arrival order, transport timestamps, outer
transport event ids, and local receive order MUST NOT participate in branch selection." If any part of the branch
selection code uses `.sort()` on a JS array of received events (which is insertion-ordered) without producing a
deterministic authenticated key, the selection outcome becomes non-deterministic across clients that receive commits
in different relay delivery order, silently breaking convergence.

**Why it happens:**
JavaScript `Array.prototype.sort()` is a stable sort but the ordering guarantee depends entirely on what the comparator
returns. An implementation that sorts by `tip_digest` (correct) but then falls back to JavaScript object insertion order
for ties (incorrect) will produce different results on two peers that receive the same commits in different order.

**How to avoid:**
Audit `src/engine/fork-recovery.ts` (or wherever `resolveFork` / branch selection lives) to verify all tie-breakers
bottom out on authenticated bytes — `tip_committer` (account identity from MLS credential) then `tip_digest`
(SHA-256 of MLS commit bytes) — and never on array index, `Map` iteration order, or event `created_at` / relay URL.
Write a test that delivers the same two competing commits in opposite order to two separate engine instances and
asserts both select the same branch.

**Warning signs:**
- Test with two competing commits where commit-A arrives before commit-B on instance-1 and commit-B arrives before
  commit-A on instance-2; if selected tips differ, the comparator leaks arrival order.

**Phase to address:** Phase 1 (gap audit — verify comparator) and Phase 2 (add non-determinism test)

---

### Pitfall 9: `EncryptedKeyValueStore` Is Cryptographically Unsafe and Must Not Be Used in Production

**What goes wrong:**
`src/extra/encrypted-key-value-store.ts` uses AES-CBC (no auth tag, malleable), PBKDF2-SHA-256 with 10,000 iterations
(well below the NIST 2023 minimum of 210,000 for SHA-256), and a constant plaintext oracle value. The `unlock()`
method also has a timing side-channel between "first setup" and "wrong password" paths.

**Why it happens:**
The class was written as a convenience/prototype; it has a JSDoc `WARNING: THIS IS NOT SECURE AND SHOULD NOT BE USED
IN PRODUCTION` note. The issue is that it is exported under `./extra` and downstream apps may import it without reading
the warning.

**How to avoid:**
Replace with AES-256-GCM (or ChaCha20-Poly1305, matching `group-message-crypto.ts`) at PBKDF2 ≥210,000 iterations or
Argon2id. Until replaced, enforce at build time (via eslint rule or barrel re-export restriction) that `extra` is
only imported by example/demo code, never by the library core or recommended app patterns.

**Warning signs:**
- Any code outside `examples/` that imports from `@internet-privacy/marmot-ts/extra`.

**Phase to address:** Phase 2 (security hardening — either fix or clearly gate-off)

---

### Pitfall 10: `GroupHistoryTree` Light Index Grows Without Bound in Long-Running Nodes

**What goes wrong:**
`GroupHistoryTree` (`src/engine/history-tree.ts`) retains `#nodes` (light metadata per observed state) without pruning.
Every state ever seen — canonical and every fork branch — is retained in memory for the engine's lifetime. A
long-running node receiving adversarial or high-volume traffic accumulates this indefinitely.

**Why it happens:**
Pruning is explicitly deferred in the current implementation. The `#nodes` map stores only metadata (not full states),
so the individual entries are small, making the growth less visible until the set is large.

**How to avoid:**
After convergence settles and canonical branch is selected, prune `#nodes` for epochs older than
`tip - maxRewindCommits` that have no live fork descendant. Coordinate with `RetainedHistoryStore` pruning.
The safe moment for pruning is post-settlement (after the quiescence timer fires and `convergenceStatus` moves to
`Settled`).

**Warning signs:**
- Memory profiling under load shows `GroupHistoryTree.#nodes` growing monotonically without leveling off.

**Phase to address:** Phase 3 (performance hardening — not blocking single-device wire interop)

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `decryptGroupMessages` silently swallows decrypt errors and emits `unreadable` | Tolerates epochs we don't have state for | Genuine bugs (bad nonce, wrong group) are indistinguishable from stale-epoch failures | Acceptable only until per-epoch error discrimination is added |
| In-memory `#seenContentIds` / `#sentContentIds` Sets with no eviction | Simple dedup logic | Grows unbounded under replay attacks; resets on restart so durable dedup (Rust reference behavior) is missing | Acceptable for now; Rust reference also has a durable layer, but content-derived epoch checks cover the restart case for commits |
| `KeyValueStoreBackend` deprecated alias still exported | No disruption for existing callers | Locks API surface; blocks tree-shaking | Remove after confirming no external usage; never add new code using the alias |
| `deserializeApplicationRumor` deprecated alias still exported | Same | Same | Same |
| `group-message-classify.ts` exported as-is with wrong wireformat assumption | No breaking change for current callers | Silent `false` returns for all real engine output; downstream logic silently breaks | Never acceptable in new code — use `framedContentType` instead |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| ts-mls `mlsExporter` | Passing wrong context bytes (string vs. `Uint8Array`) | Always `new TextEncoder().encode("context-label")`, never raw string; compare against Rust exporter context bytes |
| `@noble/ciphers chacha20poly1305` | Reusing the same nonce for two encryptions under the same key | Use `randomBytes(12)` per encrypt call; the group-event key is per-epoch so nonce budget is bounded |
| WHATWG `URL.toString()` | Assuming `new URL(raw).toString()` is canonical when the input already looks normalized | The WHATWG serializer may still change trailing slashes, default ports, or percent-encoding; always store `url.toString()` not `raw` |
| Nostr relay subscriptions (applesauce) | Assuming relay delivers events in creation order | Relays re-order, duplicate, and omit events; all convergence logic must be arrival-order-independent |
| `ts-mls` `joinGroup` | Calling `joinGroup` without checking Welcome recipient pubkey first | Extract and compare recipient identity before passing to `joinGroup` to avoid wasted MLS work on mis-addressed Welcomes |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `#seenContentIds` Set grows unbounded | Memory creep in long-running nodes after replay attacks | Add LRU max-size cap; or rely on `RetainedHistoryStore` epoch checks for commits post-restart | After ~100k unique event-ids in a high-traffic or replayed group |
| `GroupsManager.#connectGroup()` per-subscription `seen` Set | Memory growth per group per subscription | Replace with engine-level dedup gate; or add eviction | After ~50k events on a subscribed group without reconnect |
| `IngestionPool` default 1,000-entry cap + adversarial flooding | Oldest legitimate deferred commit silently evicted | Tune `maxSize` per group; log evictions at WARN | 1,001 undecryptable kind-445 events in one batch |
| `decryptMediaFileWithKeys` linear key search | O(retained epochs) per media attachment decrypt | Already efficient for the small `maxRewindCommits=5` window; no action needed unless window grows | Only if retained epochs window is increased to 50+ |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Using event `created_at` or relay URL in branch selection | Attacker controls relay; can choose which commit wins by manipulating timestamps | Never let unauthenticated transport metadata enter the `CommitOrderingKey` comparator |
| Logging media exporter secret | Key material leaks to disk/console | The spec forbids it; add a lint rule that `mediaSecret` variable is never passed to any logger |
| Accepting a mis-addressed Welcome (m8) | Attacker sends a malformed Welcome to probe key package material | Add explicit pubkey check before `joinGroup` as described in Pitfall 3 |
| Decrypting before verifying Nostr event id/sig (m9) | Attacker causes unnecessary AEAD work; spec non-conformance | Add sig-check gate in `NostrGroupPeeler` before decrypt as described in Pitfall 2 |
| `EncryptedKeyValueStore` AES-CBC with low iteration PBKDF2 | Malleable ciphertext; offline dictionary attack on stored keys | Replace with AES-256-GCM + Argon2id or block export from `./extra` until fixed |
| Host-safety check only against literals, not resolved IPs | SSRF via DNS rebinding (URL contains a legitimate-looking hostname that resolves to `10.0.0.1`) | The spec requires checking resolved IPs; the TS implementation checks literals only — add runtime DNS resolution check for blossom-v1 locators on platforms that support it |

---

## "Looks Done But Isn't" Checklist

- [ ] **M9 media source-epoch plumbing:** `decryptMediaFileWithKeys` exists and is correct, but is only ever called
  with the live-tip key. Verify by running a test that sends media at epoch N, advances to N+2, and decrypts — failure
  here means the plumbing is missing.
- [ ] **m9 sig-before-decrypt:** `peelGroupMessages` runs decrypt before sig-check. Verify by delivering a valid
  base64 content with an invalid Schnorr `sig` and asserting `invalid_signature` disposition without triggering AEAD.
- [ ] **m8 welcome recipient binding:** No pubkey check before `joinGroup`. Verify with a Welcome addressed to a
  different pubkey and assert `wrong_recipient` before MLS work.
- [ ] **m7 URL normalization vectors:** No IDNA or percent-encoding round-trip test. Verify by running the Unicode
  hostname vector `münchen.de` through both TS and Rust normalization and comparing bytes.
- [ ] **Convergence comparator arrival-order independence:** Verify by delivering same two competing commits in both
  orderings to two engine instances and asserting identical selected tip.
- [ ] **`isCommitMessage` on real engine output:** Verify that calling `isCommitMessage()` on a commit produced by
  a live engine returns `true` (currently returns `false` for `mls_public_message`).
- [ ] **Ingest apply-gate during `PendingPublish`:** Verify inbound commit is deferred, not applied, while local
  commit is staged.
- [ ] **QUIC VarInt canonicality rejection:** Verify that decoding a component payload with an over-long QUIC length
  prefix throws `invalid_encoding`.
- [ ] **Pruning respects active `PendingPublish` pin:** Verify that a `RetainedHistoryStore` prune pass does not
  remove the source epoch needed by a staged local commit.
- [ ] **Cross-runtime dedup Set behavior:** `#seenContentIds` is a JS `Set<string>`; verify that hex encoding from
  `bytesToHex` produces the same byte string across Node 20/22/24, Deno 2, and Bun 1.1.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Source-epoch media keys missing (M9) | MEDIUM | Add `getRetainedStates()` to engine, thread into `GroupMediaService`, add cross-epoch decrypt test |
| Group forked due to non-canonical QUIC encoding | HIGH | Identify which component decoder accepts non-canonical bytes; add reject + test; affected groups may need re-creation |
| Convergence non-determinism from transport order | HIGH | Audit comparator, add determinism test, re-check all tie-breaker paths in `resolveFork` |
| Welcome mis-accepted (m8) | LOW | Add pubkey check; the `KeyPackageRef` structural guard makes actual exploitation unlikely |
| `EncryptedKeyValueStore` data at rest compromised | HIGH (if used in prod) | Replace with AES-256-GCM; rotate all stored key material |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| M9 source-epoch media secret | Phase 2 (M9 close) | Cross-epoch media decrypt test passes on all runtimes |
| m9 sig-before-decrypt | Phase 2 (m9 close) | Invalid-sig event gets `invalid_signature` before AEAD attempt |
| m8 welcome recipient binding | Phase 2 (m8 close) | Mis-addressed Welcome gets `wrong_recipient`; no MLS work performed |
| QUIC VarInt non-canonical acceptance | Phase 1 (audit) + Phase 2 (close) | Over-long prefix test throws `invalid_encoding` |
| m7 URL normalization divergence | Phase 2 (m7 conformance vectors) | IDNA and percent-encoding vectors pass; TS output matches Rust reference |
| `isCommitMessage` wrong wireformat | Phase 2 (cleanup) | Round-trip test on real engine output returns `true` |
| `PendingPublish` apply-gating absent | Phase 2 (convergence hardening) | Inbound commit is deferred during `PendingPublish` |
| Convergence comparator leaks transport order | Phase 1 (audit) + Phase 2 (test) | Two-instance dual-ordering test selects identical branch |
| `EncryptedKeyValueStore` unsafe | Phase 2 (security hardening) | Either replaced or blocked from non-demo use |
| `GroupHistoryTree` unbounded growth | Phase 3 (performance) | Memory profile under 10k events is stable |

---

## Sources

- `darkmatter/spec/foundation/canonical-encoding.md` — QUIC VarInt prefix canonicality rules (HIGH confidence)
- `darkmatter/spec/foundation/host-safety.md` — unsafe host set specification (HIGH confidence)
- `darkmatter/spec/foundation/errors.md` — disposition vocabulary; `wrong_recipient`, `invalid_signature` (HIGH confidence)
- `darkmatter/spec/protocol-core/convergence.md` — branch selection order and transport-order prohibition (HIGH confidence)
- `darkmatter/spec/protocol-core/retained-history.md` — pruning safety rules, `PendingPublish` pin (HIGH confidence)
- `darkmatter/spec/protocol-core/inbound-processing.md` — deferred input rules, `PendingPublish` gate (HIGH confidence)
- `darkmatter/spec/protocol-core/publish-lifecycle.md` — publish-before-apply shape (HIGH confidence)
- `darkmatter/spec/transports/nostr.md` — "Receivers MUST verify the kind-445 event id and Nostr signature before
  attempting to decrypt" (HIGH confidence)
- `darkmatter/spec/features/encrypted-media.md` — source-epoch key derivation, MIME canonicalization, validation rules
  (HIGH confidence)
- `darkmatter/spec/app-components/group-avatar-url-v1.md` — WHATWG URL normalization as producer-side rule, decoder
  must reject non-canonical bytes (HIGH confidence)
- `darkmatter/spec/app-components/group-encrypted-media-v1.md` — QUIC list encoding, uniqueness, order semantics
  (HIGH confidence)
- `SPEC_GAP_REVIEW.md` (repo root, 2026-06-19 snapshot) — prior gap analysis m1–M9, completed baseline (HIGH confidence)
- `.planning/codebase/CONCERNS.md` (2026-07-01) — known bugs, fragile areas, test coverage gaps (HIGH confidence)
- `src/core/components/host-safety.ts` — TS reimplementation of Rust host-safety classifier; missing CGNAT/benchmarking
  ranges vs. spec table (MEDIUM confidence — cross-check against `host-safety.md` spec table needed)
- `src/core/media/crypto.ts` — `decryptMediaFileWithKeys` multi-key API exists and is correct; wire layer done (HIGH confidence)
- `src/client/group/nostr-peeler.ts` — confirms no sig-check before decrypt (HIGH confidence from direct code read)

---

*Pitfalls research for: Marmot v2 dark-matter migration — wire interop audit and closure*
*Researched: 2026-07-01*
