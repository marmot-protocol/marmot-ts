# Pitfalls Research — Account Identity Proof v2 Cutover (0x8009)

**Domain:** MLS-over-Nostr protocol wire-format migration (marmot-ts, single-device, byte-exact MDK interop)
**Researched:** 2026-09-12
**Confidence:** HIGH (primary sources: adopted spec text, MDK Rust source + 4 review-feedback commit diffs, v1.0
phase review artifacts documenting 3 rounds of the *exact same defect class* on this codebase)

Phases referenced below use the milestone's five-phase shape: **P1 primitive** (shared `MarmotAuthorizationProof`
envelope) → **P2 proof class + clean cut** (0x8009 class, `0xf2f1` removed) → **P3 group profile/seams + self-update**
→ **P4 founding create via Welcome** → **P5 parity/QA**.

## Critical Pitfalls

### Pitfall 1: Tag encoding regression — porting the `0xf2f1` decimal-tag shape onto `0x8009`

**What goes wrong:**
The adopted `0x8009` signing event is **not** the same tag shape as the legacy `0xf2f1` event marmot-ts already
ships. Old (legacy, `foundation/account-identity-proof-v1.md` lineage, what v1.0 Phase 1 built):
`d`, `extension`, `version`, `ciphersuite` (decimal string), `signature_scheme` (decimal string), `mls_signature_key`,
`content = ""`, `created_at = 0`. New (`app-components/account-identity-proof-v2.md`): `d`, `component`,
`ciphersuite` (`0x` + 4 lowercase hex digits), `signature_scheme` (`0x` + 4 lowercase hex digits),
`mls_signature_key`, `content = "Authorize this MLS leaf key for my Marmot account"`, `created_at` = real Unix time.
Six differences at once: tag count (6→5, no `extension`/`version` tags, new `component` tag), ciphersuite/scheme
encoding (decimal→`0x`-hex-4-digit), content string (empty→fixed phrase), and `created_at` (fixed 0→real time). A
naive migration that just "bumps the version" or renames constants will silently keep the old tag builder and
produce an event id that byte-differs from every MDK peer, cross-verifying with nothing.

**Why it happens:**
Both proofs share the name "account-identity-proof.v2" in different eras of this project's own history (the
project's own `0xf2f1` proof was internally called "v2" in v1.0, see `.planning/milestones/v1.0-research/PROOF-V2.md`
— that document describes the *previous* migration, v1→"v2" *within* `0xf2f1*`, which is a different event entirely
from this milestone's `0xf2f1`→`0x8009` cutover). Anyone skimming project history or grepping for "v2" will find the
wrong reference implementation.

**How to avoid:**
Do not touch `src/core/account-identity-proof.ts`'s existing tag builder in place — write the `0x8009` class as a new
function/module against the spec's exact signing-test-vector (see spec `## Signing test vector`:
`signer_pubkey=f9308a01...`, `created_at=1700000000`, `ciphersuite=0x0001`, `signature_scheme=0x0807`,
expects `event_id=b7e9a15d...`, `signature=c5315d3c...`, 104-byte component
`f9308a01...c5315d3c...`). Reproduce that exact vector byte-for-byte in a unit test before wiring anything else. Grep
the new module for the string `"extension"` or `"version"` tag kinds — their presence means the old builder leaked
in.

**Warning signs:**
A "clean cut" PR diff that is small (just renames `f2f1`→`8009` and bumps a version byte) is a red flag — the tag
array literally cannot be a find/replace, it has a different arity and different value encodings.

**Phase to address:** P2 (0x8009 proof class + clean cut)

---

### Pitfall 2: `created_at` handling — accepting `0`, missing the `2^53-1` ceiling, or losing precision through a `number`

**What goes wrong:**
The envelope's `created_at` is `uint64` on the wire but `foundation/authorization-proofs.md` deliberately bounds it
to `1..=2^53-1` specifically "so the value is represented exactly by interoperable JSON implementations" — i.e. it
fits in an IEEE-754 double / JS safe integer by design. A decoder that reads the 8-byte big-endian field with a naive
`DataView.getBigUint64` and then does unchecked `Number(bigintValue)` will silently produce `Infinity`/wrong values
for a malicious value above `2^53-1` before the range check runs (if the range check runs on the `Number` after
truncation, it can never see the value that should have failed). Separately: the *old* `0xf2f1` proof hard-codes
`created_at = 0` (see MDK `account_identity_proof.rs:76`, `Timestamp::zero()`, and marmot-ts's existing implementation
which the v1.0 fixture explicitly built around `created_at=0`) — reusing that "always zero" assumption for `0x8009`
violates the spec's explicit floor (`created_at MUST be at least 1`).

**Why it happens:**
The legacy proof's `created_at=0` was a deliberate simplification the whole codebase and its fixtures are built
around (05-02 dossier fixture literally can't vary `created_at` because it was always zero). New code paths (tests,
fixture generators, mock signers) copy-paste that `0` default without re-checking it's now a floor violation.
Precision loss is subtle because 1700000000 (spec vector) and any real Unix timestamp fit safely in a JS number —
the bug only appears with a malformed/adversarial high value, so it will not show up under normal interop testing.

**How to avoid:**
Decode `created_at` as a `bigint` (via `DataView.getBigUint64` or manual 8-byte accumulation), range-check the
`bigint` against `1n` and `(1n << 53n) - 1n` **before** any conversion to `Number`, and only convert to `Number`
after the range check passes (safe by construction at that point). Never accept `0` as valid for the new class. Add
an explicit rejection test for `created_at = 0` and for `created_at = 2^53` (one past the ceiling) and for the
maximum accepted value `2^53 - 1`.

**Warning signs:** any `Number(...)` conversion of the 8-byte field that isn't immediately preceded by a bigint range
check; a mock/test signer that emits `Date.now() / 1000 | 0` without also testing the boundary values.

**Phase to address:** P1 (primitive envelope codec)

---

### Pitfall 3: Ciphersuite used for reconstruction — group/engine suite instead of the specific KeyPackage's own suite

**What goes wrong:**
MDK shipped `d3375e9e` with account-proof validation taking a single ambient `ciphersuite: Ciphersuite` parameter
(the engine's configured suite) and reused it everywhere a leaf's proof needed reconstructing — including for Add
proposals and staged commits where the *KeyPackage being validated* is the authoritative source of truth for its own
ciphersuite. Two dedicated review-feedback commits fixed exactly this: `516a4828` ("use KeyPackage suites across
revalidation" — changed `validate_leaf_account_identity_proof(leaf, ciphersuite)` call sites in
`capability_manager.rs::cache_from_key_packages`, `cache_from_staged_commit`, and `group_lifecycle.rs` to use
`kp.ciphersuite()` instead of the passed-in engine suite, and deleted the now-redundant `ciphersuite: Ciphersuite`
parameters from those functions entirely) and `4daeffe3` (`validate_standalone_proposal_account_identity_proof`'s Add
arm still used the ambient `ciphersuite` parameter for `key_package.ciphersuite()`'s own leaf — same bug, missed in
the first pass, found by "strict cutover review"). If marmot-ts's port of `verifyLeafAccountIdentityProof`/its
successor takes a single ciphersuite argument threaded from "the group" or "the engine" rather than reading it off
the specific KeyPackage/leaf under validation, the same class of bug reappears: a proof reconstructed with the
*wrong* suite produces a different `signature_scheme` tag value and a different event id, so the signature check
either false-rejects a valid cross-suite KeyPackage or (worse, if the mismatch is silently absorbed) validates
against the wrong context.

**Why it happens:** it is natural to write "verify this leaf against the group's ciphersuite" as a single function
signature, and it is *usually* correct because most groups are ciphersuite-homogeneous — until a multi-ciphersuite
KeyPackage cache, capability revalidation pass, or reopened-legacy-group path (MDK's own regression test,
`current_configured_engine_reopens_and_uses_a_legacy_group`, added in `516a4828`, asserts a current-profile engine
correctly continues operating a legacy group) iterates several KeyPackages/leaves that don't all share one suite.

**How to avoid:** every function that reconstructs the `0x8009` signing event from a LeafNode/KeyPackage MUST take
`leaf.ciphersuite` / `keyPackage.ciphersuite` (never a caller-supplied "current" or "group" ciphersuite) as the
source for both the `ciphersuite` and `signature_scheme` tag values. Grep the new code for any function that accepts
a bare `ciphersuite: number` parameter alongside a leaf/KeyPackage argument — that's the shape the MDK fix eliminated
entirely (parameters removed, not just reordered). Add a test with two KeyPackages of different ciphersuites in one
batch validation pass and assert each validates against its own suite independently.

**Warning signs:** a shared "admin/verification callback" or "capability cache populate" function built once per
batch/session and reused across multiple leaves (this is also v1.0's WR-11 pattern — see Pitfall 9 below; the same
"build once, reuse across heterogeneous inputs" mistake recurs for ciphersuite the same way it did for the admin
snapshot).

**Phase to address:** P2 (0x8009 proof class), re-verify at P3 (group profile/seams — every revalidation seam) and
P5 (parity dossiers should include a mixed/atypical-ciphersuite fixture if the test matrix allows).

**Cited:** MDK `516a4828` ("use KeyPackage suites across revalidation"), `4daeffe3` ("address strict cutover review
findings" — the Add-proposal-arm remainder of the same bug), `crates/cgka-engine/src/account_identity_proof.rs:568-577`
(current `validate_staged_commit_account_identity_proofs` reads `key_package.ciphersuite()` per-Add, not a shared
suite).

---

### Pitfall 4: Strict 104-byte decode — trailing bytes, no version field, and reusing the legacy decoder's shape

**What goes wrong:**
`foundation/authorization-proofs.md` is explicit: "decodes exactly one 104-byte `MarmotAuthorizationProof`, rejecting
truncation or trailing bytes" and "The envelope therefore has no generic version field" (the *component id* `0x8009`
is itself the version marker — unlike the legacy `0xf2f1` payload, which carries its own `uint8 version` byte inside
the extension). The existing `decodeAccountIdentityProof` in `src/core/account-identity-proof.ts:263-287` reads a
leading `uint8` version byte, then `ciphersuite`/`signatureScheme` u16 fields, then a variable-length
`mlsSignaturePublicKey` (length-prefixed). None of that shape survives into the `0x8009` envelope: it is
`signer_pubkey[32] | created_at u64 BE | signature[64]` — fixed, three fields, no length prefixes, no version byte,
and the MLS signature key is *not* part of the encoded envelope at all (it's a signed-over tag value, reconstructed
from the LeafNode's own `signature_key`, not carried in the 104 bytes). Reusing the legacy `BinaryReader`/`reader.end()`
pattern is fine as an approach (it already does strict trailing-byte rejection correctly), but copy-adapting the old
field list instead of the new one is the likely failure mode.

**Why it happens:** the old decoder is the nearest working example in the codebase and "strict trailing-byte
rejection" is exactly the right pattern to reuse — but the *fields* being decoded are different, and it's easy to
adapt the wrapper (`reader.end()` call, error messages) while accidentally carrying over the old field list because
the two decoders will look structurally almost identical in a diff.

**How to avoid:** write the 104-byte decoder as three fixed reads with no length prefixes and no version byte:
`signerPubkey = reader.bytes(32)`, `createdAt = reader.uint64be()` (bigint), `signature = reader.bytes(64)`, then
`reader.end()` to reject trailing bytes. Assert `encodeAccountIdentityProof` output is always exactly 104 bytes
(the spec is explicit that this is fixed, not "at most"). Test decode of 103-byte and 105-byte inputs both fail.

**Warning signs:** any decoder for the new class that reads more than 3 fields, or that has a `uint16` length-prefix
read anywhere in it.

**Phase to address:** P1 (primitive envelope codec)

---

### Pitfall 5: x-only pubkey validity gap — accepting a `signer_pubkey` / credential identity that isn't a valid secp256k1 x-only point

**What goes wrong:**
The spec requires rejecting "a `signer_pubkey` that is not a valid x-only secp256k1 public key" and separately
"the credential identity is not a valid x-only secp256k1 public key" as two *distinct* validation rules (envelope
validity vs. credential validity — see `authorization-proofs.md` step 2 and `account-identity-proof-v2.md`
`## Validation`). A shortcut that only checks "is this 32 bytes" (length, not curve-point validity) passes through
values that will later throw deep inside `schnorr.verify`/`Point.fromHex` with a much less diagnosable error, or —
worse — silently coerce to a different accepted point depending on the crypto library's leniency. v1.0's own review
(01-REVIEW.md, WR-02) already found exactly this class of defect once in this codebase: `hexToBytes32` used
`parseInt(...) `, which turns invalid hex into `NaN`→coerced to `0` **without throwing**, silently producing a
plausible-but-wrong key instead of failing loudly.

**Why it happens:** "32 bytes" and "valid curve point" are conflated because both are usually true together for
honestly-generated keys; the gap only shows up for adversarial or malformed input, which normal interop testing
against a well-behaved MDK peer never generates.

**How to avoid:** validate x-only-point validity with the same library already used for BIP-340 verification
(`@noble/curves`'s schnorr/secp256k1 helpers reject invalid points on `Point.fromHex`/lift-x internally) — do not
hand-roll a length-only check, and do not reuse or reintroduce a bespoke hex-to-bytes coercion helper (delete rather
than adapt `hexToBytes32`-shaped code; use the existing length-validating `hexToBytes` from `@noble/hashes/utils.js`
per the WR-02 fix already applied). Write both rejection tests explicitly: 32 zero bytes (not a valid x-only point in
general) and a value with the high bit implying an invalid coordinate.

**Phase to address:** P1 (primitive envelope codec) for the raw `signer_pubkey` field; P2/P3 for the credential
identity comparison (`proof.signer_pubkey` MUST equal `BasicCredential.identity` byte-for-byte, and the identity
itself must independently be a valid x-only key before that comparison is meaningful).

**Cited:** v1.0 `01-REVIEW.md` WR-02 (`hexToBytes32` silent-`NaN`-coercion finding on the *existing* proof code).

---

### Pitfall 6: Accepting external-signer substitutions instead of recomputing and comparing

**What goes wrong:**
`authorization-proofs.md`'s "Producing a proof" section is explicit: "The producer MUST NOT accept an external
signer's substitutions, additional tags, alternate content, or stale response" — before extracting the envelope, the
producer must verify the *returned* event's `pubkey`, `created_at`, `kind`, `tags`, `content` exactly equal the
*requested* values, and that the returned event id equals the recomputed NIP-01 id. A shortcut implementation might
trust the external signer's returned event wholesale (e.g. extract `created_at` from the returned event rather than
the originally-requested value, or skip re-verifying `tags`/`content` and only check the signature), which lets a
compromised or buggy external signer (NIP-46 remote signer, hardware wallet) substitute a different `created_at`,
extra tags, or altered content while still producing a signature that verifies for *that* substituted event.

**Why it happens:** it's tempting to treat "the signature verifies" as sufficient, since a valid signature does prove
the signer's private key was involved — but it says nothing about whether the signer signed the *requested* content
or something else it was tricked/allowed to sign instead.

**How to avoid:** marmot-ts's existing `accountIdentityProofSignatureFromSignedEvent`
(`src/core/account-identity-proof.ts:221-238`) already implements the correct pattern for the legacy proof: it
recomputes `expectedId` from the *request* (not the returned event's claimed fields) and compares
`event.id.toLowerCase() !== expectedId`, plus checks `event.pubkey` matches the request's account identity — an id
match is sufficient to guarantee the full canonical serialization (kind, tags, content, created_at) matched, since
NIP-01 event ids are a hash over all of them. **Preserve this exact pattern for the `0x8009` external-signer path —
do not "simplify" it into reading individual fields off the returned event.** This is the one place in the existing
codebase that is already spec-compliant for the new class's requirements; the risk is regression during the rewrite,
not a net-new gap.

**Phase to address:** P1/P2 (primitive + proof class) — carry the pattern forward, add a regression test that an
external-signer mock returning a tampered `tags` array or a different `created_at` (but a self-consistent id/sig for
its own tampered content) is rejected.

**Cited:** `foundation/authorization-proofs.md` § "Producing a proof"; existing `src/core/account-identity-proof.ts:221-238`.

---

### Pitfall 7: Support-list vs dictionary-entry confusion

**What goes wrong:**
The spec draws a sharp line: "Every Marmot KeyPackage and every current Marmot member LeafNode MUST: advertise
component id `0x8009` in its LeafNode `app_components` support list; **and** contain exactly one `0x8009` component
data entry in that LeafNode's `app_data_dictionary`. **A support list entry does not substitute for the required
proof data entry.**" These are two independent, both-required conditions on two different structures (a component-id
*list* at `0x0001`/`APP_COMPONENTS_COMPONENT_ID`, vs. an actual 104-byte *dictionary entry* keyed by `0x8009`). A
common shortcut is to treat "component is supported" (present in the ids list) as implying "component data is
present" and skip the second check, or vice versa — check the dictionary entry exists but forget to also require the
id in the advertised support list (which is what a peer's negotiation/capability code actually reads to decide
whether to include you in a `0x8009`-required group at all).

**Why it happens:** both facts are usually true together for honest peers, so a validator that only checks one of
the two conditions will pass every normal interop test and only fail against a deliberately malformed or
partially-negotiated leaf.

**How to avoid:** validate both independently and explicitly, matching the spec's own two bullets:
(1) `0x8009 ∈ decode_components_list(leaf.app_data_dictionary[0x0001])`, and (2) `leaf.app_data_dictionary` has
exactly one entry for key `0x8009`. MDK's `validate_leaf_account_identity_proof` does exactly this
(`account_identity_proof.rs:351-358`: after finding the `0x8009` dictionary entry, it separately calls
`app_components_of_leaf(leaf)` and checks `advertised.contains(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)`, erroring
distinctly — `"current proof component 0x8009 is not advertised in leaf app_components"` — if the support-list half
is missing even though the dictionary entry is present).

**Phase to address:** P2 (0x8009 proof class validation), P3 (re-verify identically across every legality seam).

**Cited:** `app-components/account-identity-proof-v2.md` § "Negotiation and presence"; MDK
`crates/cgka-engine/src/account_identity_proof.rs:351-358`.

---

### Pitfall 8: Duplicate dictionary entries not rejected

**What goes wrong:** the spec requires rejecting a LeafNode that "has no `0x8009` component data entry **or has more
than one such dictionary entry**." A `Map`/dictionary-based decode that simply does `dict.get(0x8009)` will silently
collapse duplicate keys to "last write wins" (or "first write wins," depending on decode order) rather than
detecting and rejecting the duplicate — this is a decode-time structural check, not a semantic one, and it is easy
to lose if the underlying TLV/dictionary decoder used for `app_data_dictionary` doesn't itself preserve or expose
duplicate-key information once decoded into a `Map`.

**How to avoid:** check for duplicates during raw entry-list decode (before or instead of building a `Map`), or
verify the decoded entry count for the target component id against the raw wire entry count. Add a targeted test:
two `0x8009` entries in one LeafNode's `app_data_dictionary` → reject, distinct from the "entry present but doesn't
decode as a valid 104-byte proof" case.

**Phase to address:** P1 (if the shared dictionary decoder is being touched/reused) or P2 (0x8009-specific check if
the generic decoder can't structurally detect duplicates).

---

### Pitfall 9: 0x8009 leaking into GroupContext dictionary builders / `AppDataUpdate`

**What goes wrong:** `account-identity-proof-v2.md` states plainly: "The component data is created as part of a new
or replacement LeafNode. It is not GroupContext state and MUST NOT be created, replaced, or removed with
`AppDataUpdate`." The component id `0x8009` legitimately appears in the GroupContext's `app_components`
**required-component-id list** (component `0x0001`) — but must **never** appear as a keyed *data* entry in the
GroupContext's own `app_data_dictionary`. A group-creation or `AppDataUpdate` code path that builds "the full set of
required components with their data" generically (e.g. iterating every required component id and writing an entry
for each) will, if not special-cased, try to write a `0x8009` data entry into GroupContext — which is invalid by
construction (there is no group-level proof to write; the data only ever exists per-leaf).

**How to avoid:** MDK's `app_data_dictionary_extension_for_group` (`crates/cgka-engine/src/app_components.rs:98-129`)
writes `APP_COMPONENTS_COMPONENT_ID` (the required-ids *list*, which correctly includes `0x8009`) but has **no
branch at all** for writing `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` data — it is structurally absent from the group
dictionary builder, unlike `GROUP_PROFILE_COMPONENT_ID`/`GROUP_ADMIN_POLICY_COMPONENT_ID`, which do get data entries.
Separately, MDK's generic `AppDataUpdate` validator explicitly fails closed:
`ACCOUNT_IDENTITY_PROOF_COMPONENT_ID => Err(EngineError::Other("account identity proof is LeafNode-only and cannot
be updated in GroupContext"))` (`app_components.rs:1640-1642`), and it is separately listed in
`CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS` as a named, checkable constant. Port both: the group-dictionary builder
must have no code path capable of writing `0x8009` data, and any `AppDataUpdate`/GroupContext-component validator
must explicitly reject `0x8009` as a named case, not merely "not implemented" (an explicit reject is a permanent
regression guard; an accidental omission is not).

**Phase to address:** P3 (group profile requirement — this is precisely where a generic "write every required
component's data" refactor would introduce the leak) with a permanent unit test asserting `0x8009` is unconstructible
as GroupContext dictionary state and that an inbound/local `AppDataUpdate` targeting `0x8009` is rejected on every
seam.

**Cited:** `app-components/account-identity-proof-v2.md` § "Lifecycle, authorization, and removal"; MDK
`crates/cgka-engine/src/app_components.rs:40-49` (`CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS`), `:98-129`
(`app_data_dictionary_extension_for_group` — no 0x8009 branch), `:1640-1642` (explicit `AppDataUpdate` rejection).

---

### Pitfall 10: Mixed-profile states — accepting a group/leaf that is legacy in one place and current in another

**What goes wrong:** MDK's temporary transitional design (which marmot-ts is *not* adopting — see below) still had
to define and reject "mixed profile" explicitly: a LeafNode carrying **both** `0xf2f1` and `0x8009` data
(`account_identity_proof.rs:338-342`, `"LeafNode mixes legacy proof extension 0xf2f1 with current proof component
0x8009"`), a LeafNode carrying **neither** (`:343-346`), a GroupContext requiring **both**
(`protocol_profile_of_group_extensions:509-520`, `"group mixes legacy proof requirement 0xf2f1 with current proof
requirement 0x8009"`), and a GroupContext requiring **neither**. Because marmot-ts's decision is a **clean cut** (no
legacy fallback, `0xf2f1` rejected everywhere, per `PROJECT.md` Key Decisions), marmot-ts does not need
`ProtocolProfile::Legacy` as a *supported* state the way MDK's transitional path does — but it still must positively
**detect and reject** every one of those same malformed/mixed inputs, because an attacker or a stale peer can still
construct them on the wire. A shortcut that only checks "does `0x8009` data exist and validate" without also
independently checking "and `0xf2f1` is absent" lets a hybrid leaf slip through as valid.

**Why it happens:** "clean cut, no legacy fallback" is easy to read as "we don't need Legacy-profile *code* at all,"
which is true for the *happy path* builder/reader, but the *rejection* path still needs an explicit `0xf2f1`-presence
check precisely because the decision is to always reject it, never to silently ignore it as "an unknown extension."

**How to avoid:** every validation entry point for a leaf/KeyPackage/GroupContext must explicitly check for `0xf2f1`
presence and hard-reject it (not merely "not require `0x8009`, so it happens to fail some other check") — the spec's
own migration section is explicit: "There is no mixed v1/v2 fallback... A v2 client: rejects a v1-only KeyPackage or
LeafNode... treats a group that still requires `0xf2f1` but does not require `0x8009` as a legacy group outside this
profile." Add tests: a leaf with only `0xf2f1`, a leaf with both `0xf2f1` and `0x8009`, a group whose GroupContext
requires `0xf2f1` but not `0x8009`, and a group requiring both — all four must be rejected with an explicit,
attributable reason, not merely "any old failure."

**Note the deliberate divergence from MDK:** MDK's `capabilities.rs` review-feedback fix (`5fe0c8f7`) documents that
*legacy* leaf capabilities remain runtime-supported specifically "so existing legacy groups remain usable after the
strict cutover" — MDK keeps a `ProtocolProfile::Legacy` variant permanently reachable via join/reopen even though new
creation is `Current`-only. marmot-ts's `PROJECT.md` records this as a **recorded, deliberate divergence**: no
legacy-group-joining path at all. Do not "helpfully" restore MDK's dual-profile join/reopen behavior while porting
this logic — that would silently re-widen scope this milestone explicitly closed.

**Phase to address:** P2 (clean-cut rejection at the leaf/KeyPackage level) and P3 (GroupContext-level rejection on
every seam — see Pitfall 11, since this is exactly the kind of check that must be identical across seams).

**Cited:** MDK `account_identity_proof.rs:338-346` (mixed/absent leaf rejection), `:509-520` (mixed/absent group
rejection), `5fe0c8f7` diff on `capabilities.rs` (legacy-join divergence marmot-ts is *not* adopting); `PROJECT.md`
Key Decisions ("v2.0 clean cut... diverges deliberately from MDK's temporary explicit-legacy path").

---

### Pitfall 11: Seam asymmetry — the guard lands on send/inbound but not convergence/replay/welcome-join (mdk#707 class)

**What goes wrong:** this is the single most expensive defect class in this project's own history. v1.0 Phase 3
("commit-integrity-convergence-parity") set out to make exactly one property hold: that a legality guard applied on
one seam (send/staging) is applied *identically* on inbound, on convergence/replay (fork resolution), and on
tree-reconvergence-from-disk. **Three review rounds each found the guard present on some seams and silently absent
or differently-scoped on others** (round 1: 7 criticals, round 2: 4 criticals — including two *new* criticals
introduced by the round-1 fix itself — round 3 replanned as an inserted phase, 03.1, with 15 more closures). Concrete
recurring shapes worth naming for this milestone specifically:
- CR-03/WR-17 (round 1/2): `send({kind:"selfUpdate"})` produced a real commit but ran **none** of the same
  legality/admin-coupling checks `case "commit"` ran — an operation the client is told to call right after joining
  from a Welcome shipped with zero enforcement of exactly the invariants this milestone's proof/profile checks exist
  to guarantee. **Directly relevant**: this milestone's self-update binding requirement ("a replacement leaf keeps
  the same account identity with a fresh valid proof") is new legality logic that must run on the `selfUpdate` seam,
  not only wherever `case "commit"` happens to already call it.
- CR-11 (round 2, still PARTIAL after a dedicated fix attempt): the CONV-04 "known next state" fast-path bypassed the
  MIP-03 admin-policy callback entirely while the sibling `#treeResolution` path re-ran it — "two seams, same
  persisted-edge input, opposite policies... which seam happens to run first decides whether the group converges."
- WR-11 (both rounds, never fully closed): the three seams bind their admin-verification callback at **four
  different moments** — inbound builds it once before a multi-commit batch loop (stale for commit 2+ in the batch),
  pool-replay and tree-reconvergence bind it at the *current tip* and apply it to candidate states at *earlier*
  epochs, only the sweep path rebuilds it per-node correctly. **This is the same shape as Pitfall 3's ciphersuite
  bug** — a callback/parameter captured once and reused across a batch of heterogeneous inputs (different epochs,
  different leaves, potentially different ciphersuites) is the recurring root cause across this whole review.
- Phase 4's reference findings (`04-REFERENCE-FINDINGS.md`) concluded that three incremental fix rounds *still*
  didn't close CR-08/CR-11, and the actual fix was structural (porting MDK's `OwnCommitConvergenceStamp`, which
  stamps the authorization verdict once at confirm time so there is nothing for two seams to *disagree about* later)
  — not another guard added to the seam that happened to be missing it this round.

**Why it happens:** `MarmotGroupEngine` has at least four places a commit/proposal/leaf gets legality-checked
(send/staging, inbound ingest, fork-recovery/convergence replay, tree-reconvergence-from-disk on load) plus a
"known-state fast path" that is tempting to treat as "already validated, skip re-checking" — and each was added at a
different time by a different plan, so each independently decided what to check and when to build its verification
context, rather than sharing one code path.

**How to avoid, specific to this milestone:** every one of the new checks this milestone introduces — `0x8009`
presence/uniqueness/location validity, GroupContext `app_components` requiring `0x8009`, the self-update identity/
proof binding rule, rejection of `0xf2f1` — must be written as **one shared function** called from all of: send
(building a new leaf/commit), inbound ingest, convergence/fork-replay, tree-reconvergence-from-disk, and Welcome-join
(joining a founding or existing group). Do not add "the `0x8009` check" to `validateCommitLegality` (the send/inbound
shared validator from Phase 3) and assume that's sufficient — Phase 3's own review found that validator itself is
*not* uniformly reached by every seam (CR-02: it could throw and the convergence/replay seams didn't catch it; fixed,
but only after being found). Explicitly write a parity test matrix for this milestone's proof/profile checks: same
malformed input (missing `0x8009`, duplicate `0x8009`, `0xf2f1` present) run through send, inbound, convergence
replay, and Welcome-join, asserting identical rejection on all four. Prefer, if time allows, the structural fix Phase
4 already validated works (stamp the verdict once at the point it's cheapest to check — commit creation / leaf
construction — rather than re-deriving it independently on every later seam) over another per-seam guard.

**Warning signs:** a PR that adds "if `0x8009` missing, reject" in exactly one file/function; a new engine-level
`send({kind:"selfUpdate"|...})` branch that doesn't call the same helper `case "commit"` calls; any admin/verification
"callback" or "context" object built once outside a loop that iterates multiple leaves/epochs.

**Phase to address:** P3 (group profile/seams + self-update) is precisely the phase this pitfall targets by name;
budget for a review-fix cycle here specifically because this project's own history shows this defect class survives
a first fix attempt more often than not. P5 should include a scenario-per-seam parity dossier, not just a
happy-path MDK byte-fixture.

**Cited:** v1.0 `03-REVIEW-round1.md` CR-03; `03-REVIEW-round2.md` CR-11, WR-17 (carried open); `04-REFERENCE-FINDINGS.md`
§1 (structural fix); MDK `crates/cgka-engine/CLAUDE.md` § "Mirror every ingest invariant on every inbound seam...
a guard that exists on one seam only is a bug (see mdk#707)".

---

### Pitfall 12: Self-update identity change treated as an ordinary self-update

**What goes wrong:** `account-identity-proof-v2.md` states: "A change of account identity is not a self-update; it
requires removing the old membership and separately authorizing a new membership." If the self-update binding logic
this milestone adds only re-validates "does the new leaf have *a* valid `0x8009` proof" without also asserting
"`replacementLeaf.credential.identity === priorLeaf.credential.identity`" (byte-exact), a self-update that silently
swaps the account identity would pass proof validation (the new proof is internally consistent — it just proves a
*different* account authorized a *different* key) while violating the membership model (an existing leaf slot
appearing to change *who* it represents without going through Remove+Add).

**How to avoid:** the self-update validator must independently assert credential-identity equality between the
outgoing and incoming leaf, in addition to (not instead of) validating the incoming leaf's `0x8009` proof in
isolation. Spec: "The replacement leaf's `BasicCredential.identity` MUST equal the member's prior account identity."
Test: a self-update that changes only the signature key (valid) vs. one that changes the credential identity too
(must be rejected, distinctly from "invalid proof").

**Phase to address:** P3 (self-update binding).

---

### Pitfall 13: Proof reuse across a changed signing key/ciphersuite (stale proof carried over on self-update)

**What goes wrong:** "The same proof MAY be reused only while all signed inputs remain byte-for-byte identical. In
particular, a new MLS signature public key, ciphersuite, signature scheme, or account identity requires a new
proof." A self-update necessarily rotates the leaf's signature key (that's the entire point of a self-update) — so
the *old* leaf's `0x8009` proof, which signed over the *old* signature key, is now stale by construction and MUST NOT
be copied forward onto the replacement leaf. An implementation that treats "the account identity didn't change, so
reuse the account's cached proof material" as an optimization will attach a proof that cryptographically fails
`the signed MLS signature key is not exactly the signature key in that LeafNode` validation the moment any peer
checks it — a defect that is *easy to miss locally* if the same process/session that generated the stale proof also
skips revalidating its own just-built leaf before publishing.

**How to avoid:** every self-update (and every new-leaf construction generally) must mint a **fresh** `0x8009`
proof bound to the new signature key, with a fresh `created_at`. Do not cache/memoize account-proof material keyed
only on account identity; key it on `(accountIdentity, mlsSignatureKey, ciphersuite, signatureScheme)` if caching at
all, or simply don't cache it (MDK's own `identity.rs` review-feedback comment, `5fe0c8f7`, documents this exact
tradeoff: "Current-profile proofs bind a fresh `created_at`, so they are rebuilt whenever an `Identity` is
constructed even when the persisted MLS signer is reused. Callers must not treat these bytes as durable across
account-device session restarts").

**Phase to address:** P3 (self-update binding) — pair directly with Pitfall 12's test (identity-preserved,
key-rotated self-update must carry a *new* proof, not a copied one).

**Cited:** `app-components/account-identity-proof-v2.md` § "Production and reuse"; MDK `5fe0c8f7` diff on
`crates/cgka-engine/src/identity.rs`.

---

### Pitfall 14: Test fixtures silently still legacy, and byte-exact fixtures collide with proof nondeterminism

**What goes wrong, two related failure modes:**
1. **Stale fixtures.** v1.0's own review (01-REVIEW.md WR-01) found that after the *previous* proof migration, five
   files' doc comments still said `.v1` while the runtime constants were correctly `.v2` — "documentation-only" that
   round, but the same drift pattern against *test fixtures* (not just comments) is a correctness bug: a fixture file
   that still encodes an `0xf2f1` leaf, or a mock KeyPackage builder that still calls the legacy proof constructor,
   will keep passing tests that exercise the old code path even after the clean cut ships, giving false confidence
   that the migration is complete. This codebase currently has the legacy proof referenced in **10 non-test source
   files and 10 test files** (`grep -rl 0xf2f1\|AccountIdentityProof src/`) — every one of those 20 files is a
   candidate for "looks migrated but a delegate/fixture still isn't."
2. **Fixture nondeterminism.** v1.0's Phase 5 QA dossiers (`05-02-SUMMARY.md`, `05-05-SUMMARY.md`) hit this directly
   for the *existing* proof: a Rust-produced fixture using real Nostr event signing (auxiliary randomness) produced a
   **different signature on every run**, breaking the "byte-pinned fixture" requirement — the fix was deterministic
   k256 prehash signing instead of ordinary Nostr signing. Separately, 05-05's SafeAAD dossier explicitly could not
   pin the *whole* surrounding dictionary byte-for-byte because "current account-proof timestamps and signatures make
   the surrounding dictionary nondeterministic," and instead projected out just the target component's bytes as the
   stable comparison surface. `0x8009`'s `created_at` is a *real* timestamp (unlike legacy's fixed `0`), so **every**
   fixture/dossier that embeds a live `0x8009` proof inside a larger byte blob (a whole LeafNode, a whole KeyPackage,
   a whole GroupContext) inherits this same nondeterminism, project-wide, for the first time in this codebase's test
   suite.

**How to avoid:** (1) grep-audit all 20 files above during P2 and confirm each either no longer references `0xf2f1`
at all or is deliberately, explicitly testing the *rejection* of `0xf2f1` (not accidentally still exercising it as a
happy path). (2) For any new byte-exact fixture/dossier involving a live `0x8009` proof: either (a) pin
`created_at`/signing key deterministically the way 05-02 did (deterministic secp256k1 signing, fixed timestamp,
documented as test-only), or (b) follow 05-05's pattern and project out only the fields that are structurally
deterministic, explicitly documenting which fields (timestamp, signature) are excluded from the byte-pin and why.
Never assert byte-exact equality on a raw dictionary/LeafNode blob that embeds a live-timestamped proof without one
of those two mitigations — it will flake or silently stop testing what it claims to.

**Phase to address:** P2 (fixture audit as part of the clean cut) and P5 (parity dossiers — decide the
determinism strategy for `0x8009` fixtures explicitly, up front, rather than discovering it mid-dossier as v1.0 did).

**Cited:** v1.0 `01-REVIEW.md` WR-01; `05-02-SUMMARY.md` ("Rust producer... auxiliary randomness changed signatures
between runs... replaced with deterministic k256 prehash signing"); `05-05-SUMMARY.md` ("current account-proof
timestamps and signatures make the surrounding dictionary nondeterministic").

---

### Pitfall 15: Exports-surface churn — public API additions/removals not reflected in the exports snapshot

**What goes wrong:** v1.0 Phase 1's own review file list included `src/__tests__/exports.test.ts` and flagged
(IN-01) a newly-exported helper with no test coverage on the new external-signer surface. This milestone removes
public exports (`0xf2f1` builders/verifiers, the old `AccountIdentityProofSigner` shape if its contract changes) and
adds new ones (the `0x8009` primitive, its external-signer helpers). A clean-cut removal that forgets to also delete
the corresponding export (leaving a dead but still-exported legacy symbol) reopens exactly the kind of "the runtime
constants are correct but the surface still advertises the old thing" gap WR-01 found for documentation — except
for a public export, a downstream consumer can actually still call it.

**How to avoid:** treat `src/__tests__/exports.test.ts` (and the `package.json` `exports` map / subpath entrypoints:
`.`, `./client`, `./core`, `./extra`, `./utils`, `./mls`) as a checklist item for this milestone, not an incidental
diff: every `0xf2f1`-specific export removed, every `0x8009`-specific export added and covered by at least one test
exercising it from its real public entrypoint (not just the internal module).

**Phase to address:** P2 (clean cut — removals) and P1 (primitive — additions), verified at P5.

**Cited:** v1.0 `01-REVIEW.md` IN-01; `CLAUDE.md` "Public Entrypoints" (six subpath exports to keep in sync).

---

### Pitfall 16: Founding-create-via-Welcome changes publish-before-apply and Welcome-failure handling, not just "who calls what"

**What goes wrong:** this is a structural change to the engine's send/publish lifecycle, not a cosmetic rename.
MDK's own design-deviation note is explicit: "Founding creation never invents a group-message publication.
Current-profile creation returns `SendResult::FoundingGroupCreated { welcomes }`: the epoch-0 group and optional
founding Add are already canonical **locally**, and each Welcome is an independent delivery obligation... Neither
variant carries a `msg: TransportMessage`, because every initial invitee arrives through a Welcome containing the
post-Add state." This breaks two assumptions marmot-ts's existing engine likely encodes for "send a commit":
(1) that group creation participates in the ordinary `PendingPublish`→confirm/rollback lifecycle the way every other
commit does (founding creation, per MDK, is **atomic and local** — there is no "pending" window to roll back through,
because there is no founding *commit* to publish at all, only independent Welcome deliveries), and (2) that a failed
publish can be rolled back uniformly (a founding group has no prior canonical state to roll back *to* — failure
modes here are necessarily per-Welcome delivery failures, not a single all-or-nothing commit-publish failure). A
naive port that tries to fit "create + Welcome" into the existing `send({kind:"commit"})` pending/confirm/rollback
machinery will either invent a spurious founding commit message (which the spec says must not exist — "no founding
commit" is explicit in this milestone's target features) or mishandle partial Welcome delivery failure (some
invitees' Welcomes publish, others don't) as if it were a single atomic operation.

**How to avoid:** design founding-create as its own `SendResult`/pending variant distinct from `commit`, mirroring
MDK's `FoundingGroupCreated { welcomes }` shape: the group is canonical the instant creation succeeds locally (no
publish-before-apply staging for the founding state itself), and each Welcome is tracked and retried/reported as an
independent delivery obligation — a Welcome failing to publish does not roll back the group's local existence, it
means an invitee simply hasn't been told yet (a retryable, per-invitee state, not a group-level rollback). Explicitly
decide and test the partial-failure case: N invitees, M<N Welcomes publish successfully — the group exists locally
with all N as members (Welcome delivery is not membership authorization for a founding Add the way an ordinary Add
commit's publish would be), and the remaining Welcomes are outstanding retryable work.

**Phase to address:** P4 (founding create via Welcome) — this is the phase's namesake risk. Cross-check against
v1.0's own lifecycle work (Phase 3's CR-09 finding — a *different* commit-producing seam, `selfUpdate`, was found not
participating in the same persistence/recording path as ordinary commits, silently discarding fork-history-tree state
on the next load) as a cautionary precedent: any "this kind of send doesn't go through the ordinary commit path"
special case is exactly the shape that has previously broken persistence/reconvergence in this codebase when the
special case wasn't also wired into `GroupHistoryTree`/`RetainedHistoryStore` recording.

**Cited:** MDK `crates/cgka-engine/CLAUDE.md` design deviation #2 ("Founding creation never invents a group-message
publication..."); MDK `crates/cgka-engine/CLAUDE.md` "Done — Task 4.13 publish-before-apply" ("Current-profile
`do_create_group` is the founding exception: it atomically makes epoch 0... canonical locally, publishes no ordinary
group commit, and persists each Welcome as independent retryable work"); v1.0 `03-REVIEW-round2.md` CR-09
(`selfUpdate` commits never recorded into retained history/history tree — the cautionary precedent for any
non-ordinary commit-producing seam).

---

### Pitfall 17: Cross-runtime BigInt/DataView issues (Deno/Bun) for the u64 `created_at` field

**What goes wrong:** marmot-ts must pass Vitest on Node 20/22/24, Deno 2, and Bun (latest/1.1) with no
runtime-specific APIs. `DataView.getBigUint64`/`setBigUint64` are broadly supported across all of these runtimes
today, so this is a lower-probability pitfall than the others above, but it's the one place in this milestone's wire
format that genuinely needs 64-bit-wide integer handling (everything else in the envelope is bytes or u16/u32-range
values already handled elsewhere in the codebase). Two concrete failure shapes: (a) using `Number` bit-shifting
(`<<`, `>>>`) to assemble the 8-byte big-endian value instead of `bigint`/`DataView` — `Number` bitwise ops in JS
truncate to 32 bits, silently corrupting anything above `2^32`; (b) endianness mistakes when manually accumulating
bytes into a bigint (the spec is big-endian; a little-endian accumulation would produce a wildly different — but
still "successfully decoded" — timestamp, passing local round-trip tests while failing every cross-impl fixture).

**How to avoid:** use `DataView.getBigUint64(offset, false)` / `setBigUint64(offset, value, false)` (explicit
big-endian, the `littleEndian` param defaults to `false`/big-endian if omitted, but write it explicitly for
clarity/audit-ability) rather than manual byte-shifting with `Number`. Add the spec's exact test vector
(`created_at = 1700000000` → bytes `00 00 00 00 65 53 f1 00`, visible in the spec's own 104-byte fixture) as a
literal encode/decode round-trip test, and run it under all three runtimes in CI (already standard practice per
`CLAUDE.md` CI expectations) rather than assuming Node-only local testing generalizes.

**Phase to address:** P1 (primitive envelope codec) — this is exactly the kind of "no runtime-specific APIs" risk
`CLAUDE.md`'s cross-platform constraint calls out, and the existing test matrix (Vitest on Node/Deno/Bun) already
catches it if the vector test is written and included in the standard suite, not skipped as "obviously fine."

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|--------------------|-----------------|-----------------|
| Reuse the legacy `0xf2f1` tag-builder function with renamed constants instead of a new module | Less new code to write | Byte-wrong wire format that never interops (Pitfall 1) | Never |
| One shared "ciphersuite" parameter threaded through proof-validation calls instead of reading it per-KeyPackage/leaf | Simpler function signatures | Silent wrong-suite validation MDK needed 2 dedicated fixes to close (Pitfall 3) | Never |
| Add the `0x8009` check only to the existing shared `validateCommitLegality` and assume all seams reach it | Fast, single code-change point | Repeats the exact mdk#707 / CR-02/CR-11 class this project already paid 3 review rounds to (partially) close | Never — always write a per-seam parity test alongside |
| Cache/memoize account-proof material by account identity alone | Avoids re-signing on every leaf construction | Stale proof carried onto a rotated key after self-update, fails peer verification (Pitfall 13) | Never |
| Skip deterministic-signing infrastructure for new `0x8009` fixtures, assert byte-equality on whatever the live signer produces | Faster to write the dossier | Flaky/non-reproducible QA-02-class evidence (Pitfall 14) | Only for fixtures that explicitly exclude timestamp/signature bytes from the byte-pin, and say so |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|--------------|-----------------|-------------------|
| MDK Rust reference fixtures | Treating any Rust-signed `0x8009` fixture as reproducible byte-for-byte including signature/timestamp | Pin with deterministic signing (05-02 pattern) or project out nondeterministic fields (05-05 pattern); decide which up front |
| `refs/marmot` spec vs `refs/mdk` Rust | Spec-only reading; the account-identity-proof-v2 doc is spec-authoritative here (status: adopted) but the *legacy→current transition mechanics* (mixed-profile rejection details, per-KeyPackage-suite revalidation) are only visible in MDK's code and its own review-feedback commits | Read both; when they conflict, MDK is source of truth for wire format, spec is source of truth for what's "adopted"/normative going forward |
| MDK's temporary dual-profile (Legacy+Current) design | Porting MDK's "keep legacy joinable" capability/negotiation logic wholesale | marmot-ts's decision is a stricter clean cut than MDK's own transitional stance (Pitfall 10) — port the *rejection* checks, not the *permissiveness* |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `StateNotificationLedger`/`DeliveredPayloadLedger` unbounded growth under `maxRewindCommits: Infinity` (pre-existing, carried tech debt, not new to this milestone but interacts with it: every new `0x8009`-bearing commit still flows through the same ledgers) | Memory grows unboundedly over a long-lived process | Add an absolute entry cap independent of the anchor (flagged, unresolved, in v1.0 WR-02/WR-14) | Long-running clients in large/active groups |
| Per-proof BIP-340 verification cost on every revalidation seam (send, inbound, convergence replay, tree-reconvergence) for every leaf in a large group | Slower ingest/reconvergence as group size grows, worse if seam-asymmetry (Pitfall 11) causes redundant re-derivation | Verify once per leaf per epoch where possible; don't re-verify unchanged leaves on every batch | Groups with many members and frequent convergence passes |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Accepting `created_at` outside `1..=2^53-1` because the range check ran after truncating to `Number` | Malformed/adversarial proof accepted as if it had a valid timestamp | Range-check as `bigint` before any `Number` conversion (Pitfall 2) |
| Trusting an external signer's returned event fields directly instead of recomputing the expected id | A compromised/buggy NIP-46/hardware signer substitutes different signed content while still "verifying" | Recompute the id from the *request*, compare to the returned id (Pitfall 6) — already correctly implemented for legacy, preserve the pattern |
| Treating "component data present" as sufficient without checking "component id also in the support list" (or vice versa) | Peers that only check one condition disagree about validity of the same leaf | Check both independently per spec (Pitfall 7) |
| A guard added to send/inbound but not convergence/replay/Welcome-join | Non-deterministic, peer-order-dependent convergence; a device can be tricked into accepting a leaf/commit its peers reject | Shared validator function, parity test matrix per seam (Pitfall 11) |
| Silent `NaN`→`0` coercion in a hand-rolled hex/byte decoder | Malformed input decodes to a plausible-but-wrong key instead of throwing | Use the existing length/validity-checking decode helpers; delete rather than adapt lenient ones (Pitfall 5, citing WR-02) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Rejecting a group/peer with only a generic "invalid proof" error | Users/developers can't tell "peer is on the legacy profile" from "peer's proof is cryptographically broken" from "peer's proof is present but for a different leaf" | Distinct, attributable rejection reasons per spec validation bullet (mixed profile, missing support-list entry, duplicate entry, wrong location, identity mismatch, signature failure) — mirrors MDK's per-case error strings |
| A join/create call that silently produces a `0xf2f1` legacy artifact because a stale delegate function wasn't migrated (Pitfall 14) | Developer believes they're on the new profile; interop fails downstream with no clear signal at the call site that produced the bad artifact | Fail loudly and early: reject construction of a `0xf2f1` extension anywhere in the new code paths, don't just stop calling the constructor |

## "Looks Done But Isn't" Checklist

- [ ] **`0x8009` proof class**: verify the spec's exact signing-test-vector round-trips byte-for-byte (event id
  `b7e9a15d...`, signature `c5315d3c...`, 104-byte component bytes) — not just "a proof round-trips against itself."
- [ ] **Clean cut**: verify all 10 non-test + 10 test files currently referencing `0xf2f1`/`AccountIdentityProof`
  either no longer reference it, or deliberately test its rejection — grep after the phase, don't assume the diff
  covered everything.
- [ ] **Seam parity**: verify the *same* malformed-input test matrix (missing 0x8009, duplicate 0x8009, mixed
  0xf2f1+0x8009, wrong ciphersuite) is run through send, inbound, convergence/replay, tree-reconvergence, and
  Welcome-join — not just one seam.
- [ ] **GroupContext isolation**: verify `0x8009` cannot be constructed as GroupContext dictionary state via any code
  path, including a generic "write every required component's data" builder.
- [ ] **Self-update binding**: verify identity-preservation AND fresh-proof-on-key-rotation are both tested, as
  distinct assertions, not one combined "self-update still validates" test.
- [ ] **Founding-create via Welcome**: verify partial-Welcome-delivery-failure behavior is defined and tested, not
  just the all-succeed happy path; verify no founding *commit* message is ever constructed or published.
- [ ] **Fixture determinism**: verify every new byte-exact `0x8009` fixture/dossier states explicitly whether it uses
  deterministic signing or field-projection, and why.
- [ ] **Public exports**: verify `src/__tests__/exports.test.ts` and the `package.json` `exports` map reflect both
  removals and additions.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|-----------------|
| Wrong tag encoding shipped (Pitfall 1) | LOW if caught by the spec test vector before merge; HIGH if it reaches a byte-exact MDK dossier or, worse, production interop | Re-derive the exact tag builder against the spec vector; this is a pure function, easy to isolate and re-test in minutes once identified |
| Seam asymmetry defect shipped (Pitfall 11) | HIGH — v1.0's own history shows this took 3 review rounds and an inserted phase to close for the *previous* legality-guard rollout | Don't patch seam-by-seam; extract to one shared validator called from every seam, add the parity matrix, and consider the structural (stamp-at-confirm-time) fix pattern Phase 4 already validated works for a similar defect class |
| Stale legacy fixture/delegate discovered post-merge (Pitfall 14) | LOW–MEDIUM | Grep-audit sweep across the 20 flagged files, convert any surviving legacy-happy-path test into an explicit rejection test |
| Founding-create built on the ordinary commit pending/rollback machinery (Pitfall 16) | HIGH — likely requires a new `PendingState`/`SendResult` variant and history-tree/retained-store wiring, not a local fix | Design the variant explicitly against MDK's `FoundingGroupCreated` shape before implementation, not as a post-hoc refactor |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| 1. Tag encoding regression | P2 | Spec signing-test-vector round-trip test (exact bytes) |
| 2. `created_at` bounds/precision | P1 | bigint range-check tests at 0, 1, 2^53-1, 2^53 |
| 3. Wrong ciphersuite for reconstruction | P2, re-verify P3/P5 | Multi-ciphersuite batch validation test |
| 4. Strict 104-byte decode | P1 | 103/104/105-byte decode tests, no version-byte/length-prefix fields |
| 5. x-only pubkey validity | P1/P2/P3 | Invalid-point rejection tests (not just length checks) |
| 6. External-signer substitution | P1/P2 | Tampered-tags/content mock-signer rejection test |
| 7. Support-list vs dictionary confusion | P2/P3 | Independent tests for each of the two conditions |
| 8. Duplicate dictionary entries | P1/P2 | Two-`0x8009`-entries rejection test |
| 9. 0x8009 leaking into GroupContext | P3 | GroupContext-builder unit test + AppDataUpdate rejection test |
| 10. Mixed-profile states | P2/P3 | Four-combination (neither/both/legacy-only-group/etc.) rejection tests |
| 11. Seam asymmetry (mdk#707 class) | P3 (primary), budget review-fix cycle | Per-seam parity test matrix; consider stamp-at-confirm-time structural pattern |
| 12. Self-update identity change | P3 | Identity-change-on-selfUpdate rejection test |
| 13. Proof reuse on key rotation | P3 | Fresh-proof-on-selfUpdate test, no proof caching by identity alone |
| 14. Stale fixtures / fixture nondeterminism | P2 (audit), P5 (dossier strategy) | Grep-audit of 20 flagged files; documented determinism strategy per fixture |
| 15. Exports snapshot churn | P1 (additions), P2 (removals) | `exports.test.ts` diff review each phase |
| 16. Founding-create lifecycle changes | P4 | Partial-Welcome-failure test; no founding-commit-message test |
| 17. Cross-runtime BigInt/DataView | P1 | Spec vector test run on Node/Deno/Bun in CI |

## Sources

- `refs/marmot/app-components/account-identity-proof-v2.md` (adopted spec, status: adopted) — component id, tag
  shape, validation rules, signing test vector, migration section
- `refs/marmot/foundation/authorization-proofs.md` (adopted spec) — common envelope, `created_at` bounds, producer/
  verifier algorithm, external-signer substitution rule
- MDK Rust reference, pinned at `4daeffe3` head of the four cited commits (`d3375e9e`, `5fe0c8f7`, `516a4828`,
  `4daeffe3`) — `crates/cgka-engine/src/account_identity_proof.rs`, `app_components.rs`, `self_update.rs`,
  `group_lifecycle.rs`, `capability_manager.rs`, `capabilities.rs`, `identity.rs`, `key_package.rs`,
  `crates/cgka-engine/CLAUDE.md` (crate-level invariants, "mdk#707" guard-parity rule, `FoundingGroupCreated` design
  deviation #2)
- `.planning/milestones/v1.0-research/PROOF-V2.md` — the *previous* (v1→"v2" within `0xf2f1`) migration this
  milestone's naming can be confused with
- `.planning/milestones/v1.0-phases/01-proof-v2/01-REVIEW.md` — WR-01 (stale doc/delegate drift), WR-02 (silent
  hex-coercion), IN-01 (uncovered export)
- `.planning/milestones/v1.0-phases/03-commit-integrity-convergence-parity/03-REVIEW-round1.md`,
  `03-REVIEW-round2.md` — CR-01–CR-11, WR-01–WR-18 (seam-asymmetry defect catalog, mdk#707-class findings on this
  codebase specifically)
- `.planning/milestones/v1.0-phases/04-feature-parity-conformance-vectors/04-REFERENCE-FINDINGS.md` — structural
  (`OwnCommitConvergenceStamp`) fix superseding 3 rounds of incremental patching
- `.planning/milestones/v1.0-phases/05-quality-gate/05-02-SUMMARY.md`, `05-05-SUMMARY.md` — fixture
  nondeterminism and legacy/current profile fixture-labeling precedent
- `.planning/PROJECT.md` — milestone scope, clean-cut decision, deliberate divergence from MDK's transitional path
- `src/core/account-identity-proof.ts` (current marmot-ts implementation) — existing legacy tag/encode/decode/
  external-signer patterns to preserve, replace, or explicitly not reuse

---
*Pitfalls research for: marmot-ts v2.0 Account identity proof v2 (0x8009 cutover)*
*Researched: 2026-09-12*
