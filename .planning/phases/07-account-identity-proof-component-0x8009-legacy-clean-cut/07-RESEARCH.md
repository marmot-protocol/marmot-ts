# Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut - Research

**Researched:** 2026-09-14
**Domain:** MLS app-component design (Marmot `app_data_dictionary`), Nostr-event-shaped authorization proofs, TypeScript codec/validator layering over `ts-mls`
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Proof signer in the client API**
- **D-01:** Delete the `accountProofSigner` option everywhere: `MarmotClient`, `GroupsManager`, `GroupFactory`,
  `KeyPackageManager`, `KeyPackagePublisher`, `generateKeyPackage`. Every leaf the client builds signs its kind-450
  proof with the client's existing identity `signer: EventSigner` (`signEvent`). There is no separate override option.
- **D-02:** Core `generateKeyPackage` requires the signer (`Pick<EventSigner, "signEvent">`). The proof-less
  KeyPackage path is removed entirely, because a KeyPackage without `0x8009` is never valid on the wire. Tests pass a
  real signer.
- **D-03:** Proof `created_at` defaults to wall-clock time, per the Phase 6 default. Core `generateKeyPackage` (and any
  core leaf builder) accepts an optional injected `createdAt`/clock so tests and the spec-vector fixture are
  byte-stable. The client layer does not expose it.
- **D-04:** Delete `src/__tests__/helpers/account-proof.ts` and `examples/opentui/src/helpers/account-proof.ts`.
  Callers pass the account's `EventSigner` directly (`PrivateKeyAccount.signer`). Only the spec-vector test keeps a
  hand-rolled `{ signEvent }` using zero aux randomness.

**Phase 7 / Phase 8 boundary**
- **D-05:** Creation side lands now. Add `0x8009` to newly created groups' GroupContext `app_components` required list
  (`DEFAULT_GROUP_COMPONENT_IDS` / `src/core/group.ts`). In the same change, drop `0xf2f1` from
  `marmotRequiredCapabilitiesExtension`. No commit should leave the code creating groups that require neither.
  Phase 8 still owns GRP-01's tests, the "no GroupContext state for `0x8009`" enforcement, and the seam work.
- **D-06:** `src/engine/admin-policy.ts` gets a **like-for-like** swap: detect and validate `0x8009` instead of
  `0xf2f1`, but **keep** the existing skip of Adds whose leaf carries no proof (`if (!hasProof) continue`). This is a
  **known gap Phase 8 must close** (GRP-02/GRP-04). Record it in the Phase 7 summary/deferred items so it is not lost.
- **D-07:** CUT-02 "group requiring `0xf2f1` is rejected" is a **shared pure `src/core` helper**. It classifies a
  GroupContext's proof profile as current, legacy, mixed, or neither (modelled on MDK
  `protocol_profile_of_group_extensions`), and anything except current throws. It also rejects `0x8009` data in the
  GroupContext dictionary. In Phase 7 it is called only on join via Welcome, alongside the whole-tree leaf validation
  in `groups-manager.ts`. Phase 8 wires the same helper into send, ingest, and convergence.
- **D-08:** PROOF-06 wrong-container rejection (`0x8009` in a GroupContext dictionary, GroupInfo, `AppEphemeral`, or
  SafeAAD) goes into the existing pure component/dictionary validators those containers already pass through, such as
  AppDataUpdate/GroupContext dictionary validation and SafeAAD parsing. Each container gets unit tests. Seam-parity
  tests stay in Phase 8.

**Legacy local state**
- **D-09:** Stored KeyPackages whose leaf is legacy (`0xf2f1` / no valid `0x8009`) are **skipped as non-current**.
  `KeyPackageManager.ensurePublished` ignores them and creates a fresh `0x8009` package, while `list()` still returns
  them flagged or filterable so apps can call `purge()` explicitly. Nothing is auto-deleted and no kind-5 is sent;
  published rotation stays out of scope.
- **D-10:** Stored groups persisted by v1.0 that require `0xf2f1` **load untouched** in Phase 7. There is no new
  load-time check; the Phase 8 seams reject them.
- **D-11:** Release as a **major** changeset listing the removed `accountProofSigner` option and legacy exports. Add a
  short migration section to the docs: republish KeyPackages, legacy groups are unreadable, and signer changes. Check
  `docs/signers/` and the client docs for `accountProofSigner` mentions.

**Validator shape & errors**
- **D-12:** The new module is `src/core/components/account-identity-proof.ts`, with the component id/name added to
  `src/core/components/ids.ts`. **Delete `src/core/account-identity-proof.ts` outright** so any surviving legacy
  import fails the build. Do not rename or port legacy functions (Pitfall 1: v1.0's `0xf2f1` proof was also
  internally called "v2").
- **D-13:** Rejections throw a new `AccountIdentityProofError extends Error` (sets `this.name`, carries `reason`).
  Class-level reasons are at minimum: `missing-support`, `missing-data`, `duplicate-data`,
  `legacy-extension-present`, `invalid-location`, `identity-mismatch`, `ciphersuite-mismatch`,
  `signature-key-mismatch`, `invalid-proof`. `invalid-proof` wraps the underlying `AuthorizationProofError` as `cause`,
  so the envelope reason stays reachable. Add profile reasons as needed for D-07 (e.g. `legacy-group`,
  `mixed-profile`, `missing-requirement`). The Phase 6 `AuthorizationProofRejectReason` union stays proof-class
  agnostic.
- **D-14:** Validators **throw**, consistent with Phase 6 D-04. The entry points are a single-leaf validator
  (`leaf, ciphersuite`), a whole-tree validator for join, and the GroupContext profile classifier (D-07). Phase 8's
  `validateCommitLegality` catches these and maps `reason` to its `{ kind }` result.
- **D-15:** A single leaf-dictionary builder emits the one LeafNode `app_data_dictionary`: an `app_components` list
  including `0x8009`, the SafeAAD entry, and exactly one `0x8009` proof entry. It evolves
  `makeLeafAppComponentsExtension` and takes the encoded proof, so the structure is correct by construction. `0x8009`
  joins `SUPPORTED_APP_COMPONENT_IDS`.
- **D-16:** KeyPackages are validated with their own ciphersuite and member leaves with the group's ciphersuite
  (PROOF-04, Pitfall 3). The leaf signature key must be valid for that ciphersuite before the event is reconstructed.

### Claude's Discretion
- Exact exported symbol names, including the builder for the kind-450 template (it wraps the Phase 6
  `AuthorizationProofTemplate`), the leaf/tree validators, and the profile classifier. Follow codebase naming
  conventions.
- Exact reason string spelling beyond the minimum set in D-13, and whether a mixed `0xf2f1`+`0x8009` leaf gets
  `legacy-extension-present` or its own reason. It must be rejected either way.
- How the `list()` legacy flag or filter from D-09 is surfaced, e.g. a field on `ListedKeyPackage` or a filter
  option.
- Where exactly the migration section lives in `docs/` (and `.vitepress/config.ts` if a new page is added).

### Deferred Ideas (OUT OF SCOPE)
- **Phase 8 must close:** admin-policy's skip of proof-less Adds (D-06), and wiring the D-07 profile classifier and
  leaf validators into the send, ingest, pool-replay, and convergence seams.
- **Phase 8 / later:** rejecting legacy stored groups at load time (D-10 chose to load them untouched).
- Automatic purge or rotation of legacy published KeyPackages. It stays out of v2.0 scope; apps call `purge()`
  (D-09).
- Exposing an injectable proof clock on `MarmotClient` for app-level deterministic tests (D-03 keeps it core-only).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROOF-02 | Kind-450 event byte-exact to spec signing test vector | Verified test vector text below; must go through the real class builder (`produceAuthorizationProof`/`buildAuthorizationProofEvent` from Phase 6), not a hand-built template |
| PROOF-03 | Generated KeyPackage/leaf advertises `0x8009` + exactly one dictionary entry, via raw-key and external signers | `makeLeafAppComponentsExtension` evolution (D-15) + `generateKeyPackage` required-signer change (D-02); Phase 6's `AuthorizationProofSigner = Pick<EventSigner,"signEvent">` already covers both signer shapes uniformly |
| PROOF-04 | Rejects missing support/data, signer/ciphersuite/scheme/signature-key mismatch, bad signature | Rust reference `validate_current_proof` + `validate_proof_bindings` mapped to a TS validator below; KeyPackage vs member-leaf ciphersuite split (D-16) |
| PROOF-05 | `0x8009` in KeyPackage-level `extensions` is rejected | No such codepath currently writes `0x8009` there; validator must check location explicitly — see "Wrong-container enforcement points" below |
| PROOF-06 | `0x8009` in GroupContext dictionary / GroupInfo / `AppEphemeral` / SafeAAD is rejected | Container-by-container findings below: GroupContext + SafeAAD have real enforcement points today; GroupInfo/`AppEphemeral` dictionaries do not exist in this codebase's `ts-mls` surface yet |
| CUT-01 | No `0xf2f1` emission anywhere; legacy exports removed | Full file inventory below |
| CUT-02 | Any `0xf2f1`-carrying/requiring KeyPackage, leaf, or group is rejected | D-07 profile classifier (join-time only in Phase 7) + leaf validator rejecting mixed/legacy leaves |
</phase_requirements>

## Summary

Phase 6 (`src/core/authorization-proof.ts`, merged) already implements the entire generic 104-byte
`MarmotAuthorizationProof` envelope — encode/decode, NIP-01 event-id reconstruction, BIP-340 verify, and the
strict external-signer round-trip (`produceAuthorizationProof`). Phase 7 is a thin proof-class layer on top of it:
supply the fixed `{ kind: 450, tags, content }` template for `marmot.member.account-identity-proof.v2`, wire it into
the LeafNode `app_data_dictionary`, and validate it against a leaf's `BasicCredential.identity` / signature key /
ciphersuite. The class-specific work is almost entirely mechanical, because the hard cryptographic and canonical-JSON
work already shipped and passed review.

The harder half of this phase is **subtraction**: `0xf2f1` (the legacy `marmot.account-identity-proof.v1` custom
LeafNode extension) is threaded through nine core/engine/client production files today — it is not confined to one
module. `src/core/account-identity-proof.ts` (416 lines) must be deleted outright, and every one of its eight call
sites (capabilities, key-package, admin-policy, marmot-client, groups-manager, group-factory, key-package-manager,
key-package-publisher, invite-user) needs a same-shape swap to the new `0x8009` module. Because `generateKeyPackage`'s
signer parameter changes from optional to required (D-02), this is not purely additive — every constructor/options
type that threaded `accountProofSigner?` through also loses that parameter name, which is a public API break
correctly scoped as a major changeset (D-11).

A Rust-signed fixture generator for the *legacy* proof already exists at `tools/quality-gate/proof-v2-probe/`
(confusingly named — it produces the `0xf2f1` "legacy-version-byte-2" profile, not the `0x8009` component this phase
implements; this is exactly Pitfall 1's naming collision, now confirmed in the wild). Its output feeds
`src/__tests__/fixtures/proof-v2-rust.json`, consumed by two test files that must be deleted or rewritten. Separately,
an *existing* fixture (`src/__tests__/fixtures/safe-aad-rust.json`, captured from a genuine current-profile MDK
`Engine::fresh_key_package` output for the unrelated SafeAAD parity test) already lists `32777` (`0x8009`) in its
`advertised_app_components` — independent, already-in-repo confirmation that a real MDK build advertises this exact
id in this exact list shape.

**Primary recommendation:** Build the new `src/core/components/account-identity-proof.ts` module directly on Phase
6's `AuthorizationProofTemplate`/`produceAuthorizationProof`/`verifyAuthorizationProof` (no re-implementation of
event/signature logic), re-home `mlsSignatureScheme` into it (ts-mls has no equivalent), then do the `0xf2f1`→`0x8009`
swap file-by-file per the inventory below, ending with the required-signer change to `generateKeyPackage` and the
`exports.test.ts` snapshot update.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Build/verify the kind-450 proof envelope (crypto, event-id, signature) | Core (`src/core/authorization-proof.ts`, Phase 6, unchanged) | — | Pure protocol/crypto logic with no I/O; already built and reviewed |
| `0x8009` template + leaf/tree validators + GroupContext profile classifier | Core (`src/core/components/account-identity-proof.ts`, new) | — | Pure, MLS-aware but I/O-free; mirrors Rust `account_identity_proof.rs`'s placement in the engine's "no I/O, no Nostr SDK" layer |
| Advertise `0x8009` + carry exactly one proof entry on a generated leaf | Core (`src/core/key-package.ts`, `src/core/components/dictionary.ts`) | — | Leaf-building is pure MLS/codec work |
| Reject `0xf2f1`/malformed proof on Add proposals inside a commit | Engine (`src/engine/admin-policy.ts`) | Core (validator called from engine) | Admin-commit policy is an engine-layer incoming-message gate; it calls into the Core validator, doesn't reimplement it |
| Whole-tree leaf validation + GroupContext profile check on join | Client (`src/client/groups-manager.ts` `joinFromWelcome`) | Core (validator called from client) | Join orchestration (candidate selection, MLS `joinGroup`, persistence) is client-layer; the actual proof/profile checks it calls are Core |
| Remove `accountProofSigner` option, thread the client's own signer down | Client (`MarmotClient`, `GroupsManager`, `GroupFactory`, `KeyPackageManager`, `KeyPackagePublisher`) | — | Composition-root wiring; no new crypto, just parameter plumbing |
| Skip legacy KeyPackages in `ensurePublished`/flag them in `list()` | Client (`src/client/key-package-manager.ts`, `key-package-store.ts`) | — | Local persisted-state policy, not protocol validation |
| Drop `0xf2f1` from required-capabilities; add `0x8009` to GroupContext required-component list | Core (`src/core/capabilities.ts`, `src/core/group.ts`) | — | Group-creation-time state shaping |

## Standard Stack

No new external packages. This phase is additive/subtractive TypeScript over already-vendored dependencies:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ts-mls` (local fork, workspace) | rc.14 (unchanged) | `LeafNode`, `KeyPackage`, `Capabilities`, `defaultCredentialTypes` types; no signature-scheme helper exists here (verified — see below) | Already the project's MLS engine |
| `@noble/curves/secp256k1.js` | ^2.2.0 (unchanged) | BIP-340 Schnorr verify, already used by Phase 6's `authorization-proof.ts` | Already in use; no new dependency |
| `@noble/hashes/utils.js` | ^2.2.0 (unchanged) | hex encode/decode | Already in use |
| `applesauce-core` (`EventSigner`, `factories`) | ^6.2.0 (unchanged) | The `Pick<EventSigner,"signEvent">` signer contract Phase 6 already defined | Already in use — D-01 reuses the client's existing `signer` field, no new type |

**Installation:** none — no new packages this phase.

**Version verification:** not applicable; no package versions change. `ts-mls` was checked for a ciphersuite→signature-scheme mapping equivalent to the legacy module's `mlsSignatureScheme` table — none exists (`grep -rn "signatureScheme\|SignatureScheme" ts-mls/src/` outside the crypto provider's own internal ciphersuite struct returns nothing usable as a public export) `[VERIFIED: grep against ts-mls/src/]`. The table must be re-homed (copied, not reimplemented) into the new module, exactly as D-12 anticipates ("Re-home it... before deleting the legacy file").

## Package Legitimacy Audit

**Not applicable.** This phase installs no new external packages — every import used by the new module already ships
in the workspace (`ts-mls` local fork, `@noble/curves`, `@noble/hashes`, `applesauce-core`), all of which were already
audited for prior phases. No `npm view` / registry check is needed.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌───────────────────────────────────────────┐
                         │   refs/marmot/app-components/              │
                         │   account-identity-proof-v2.md (spec)      │
                         └───────────────────┬─────────────────────────┘
                                             │ defines
                                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│ src/core/authorization-proof.ts  (Phase 6, UNCHANGED)                  │
│  buildAuthorizationProofEvent(template, signerPubkey, createdAt)       │
│  produceAuthorizationProof({ template, signerPubkey, signer, createdAt}) │
│  verifyAuthorizationProof(template, proof: bytes|object)               │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ template = { kind:450, tags:[...5], content }
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ src/core/components/account-identity-proof.ts  (NEW, this phase)       │
│  buildAccountIdentityProofTemplate(ciphersuite, mlsSigKey) -> template │
│  produceLeafAccountIdentityProof({accountIdentity, mlsSigKey,          │
│      ciphersuite, signer, createdAt?}) -> Uint8Array (104B)            │
│  validateLeafAccountIdentityProof(leaf, ciphersuite) -> throws          │
│  validateAccountIdentityProofLocation(...)  (PROOF-05/06 guards)        │
│  classifyGroupAccountIdentityProofProfile(extensions) -> current|      │
│      legacy|mixed|neither  (D-07)                                      │
│  mlsSignatureScheme(ciphersuite) -> code point  (re-homed)              │
└───────┬───────────────────────┬───────────────────────┬───────────────┘
        │ used by               │ used by                │ used by
        ▼                       ▼                         ▼
┌──────────────────┐   ┌─────────────────────┐   ┌─────────────────────────┐
│ src/core/         │   │ src/engine/          │   │ src/client/              │
│ key-package.ts    │   │ admin-policy.ts      │   │ groups-manager.ts        │
│ (leaf build:       │   │ (Add-proposal gate,  │   │ joinFromWelcome:         │
│  0x8009 dict entry, │   │  like-for-like swap, │   │  whole-tree leaf check   │
│  required signer)   │   │  D-06 keeps          │   │  + D-07 profile check    │
│                     │   │  proof-less skip)    │   │  on the incoming group   │
└──────────────────┘   └─────────────────────┘   └─────────────────────────┘
        │
        ▼
┌──────────────────┐
│ src/core/          │
│ capabilities.ts    │  drop 0xf2f1 from marmotRequiredCapabilitiesExtension
│ group.ts           │  add 0x8009 to DEFAULT_GROUP_COMPONENT_IDS (required list only)
└──────────────────┘
```

### Recommended Project Structure
```
src/core/
├── account-identity-proof.ts        # DELETE (D-12)
├── authorization-proof.ts           # unchanged (Phase 6)
├── components/
│   ├── account-identity-proof.ts    # NEW — this phase's class module
│   ├── ids.ts                       # + ACCOUNT_IDENTITY_PROOF_COMPONENT_ID = 0x8009
│   ├── dictionary.ts                # makeLeafAppComponentsExtension evolves (D-15);
│   │                                 #   makeAppComponentsExtension gains the same
│   │                                 #   SafeAAD-style guard for 0x8009
│   └── index.ts                     # + export * from "./account-identity-proof.js"
├── capabilities.ts                  # drop 0xf2f1 from required-capabilities
├── group.ts                         # DEFAULT_GROUP_COMPONENT_IDS += 0x8009
└── key-package.ts                   # required signer, leaf dictionary via D-15
```

### Pattern 1: Class-specific template over the shared envelope primitive
**What:** A proof class supplies only `{ kind, tags, content }`; the shared primitive owns hashing/signing/verifying.
**When to use:** Any new `AuthorizationProof`-based component (this is the first of potentially several — self-update
binding in Phase 9 reuses the same primitive per `.planning/REQUIREMENTS.md` "UPD" section note).
**Example:**
```typescript
// Source: refs/marmot/app-components/account-identity-proof-v2.md "Signing event"
//         + src/core/authorization-proof.ts (Phase 6, unchanged)
import {
  buildAuthorizationProofEvent,
  produceAuthorizationProof,
  verifyAuthorizationProof,
  type AuthorizationProofTemplate,
} from "../authorization-proof.js";

const ACCOUNT_IDENTITY_PROOF_DOMAIN = "marmot.account-identity-proof.v2";
const ACCOUNT_IDENTITY_PROOF_CONTENT =
  "Authorize this MLS leaf key for my Marmot account";

function accountIdentityProofTemplate(
  ciphersuite: number,
  mlsSignatureKey: Uint8Array,
): AuthorizationProofTemplate {
  return {
    kind: 450,
    tags: [
      ["d", ACCOUNT_IDENTITY_PROOF_DOMAIN],
      ["component", `0x${ACCOUNT_IDENTITY_PROOF_COMPONENT_ID.toString(16).padStart(4, "0")}`],
      ["ciphersuite", `0x${ciphersuite.toString(16).padStart(4, "0")}`],
      ["signature_scheme", `0x${mlsSignatureScheme(ciphersuite).toString(16).padStart(4, "0")}`],
      ["mls_signature_key", bytesToHex(mlsSignatureKey)],
    ],
    content: ACCOUNT_IDENTITY_PROOF_CONTENT,
  };
}
```
This is a direct transliteration of the spec's "Signing event" section — the tag order, the `0x`-prefixed
4-hex-digit values, and the fixed content string must match exactly, since the whole 104-byte proof round-trips
through NIP-01 event-id hashing.

### Pattern 2: Ciphersuite-scoped validation (KeyPackage vs member leaf)
**What:** The applicable ciphersuite for reconstructing the signing event is the KeyPackage's own ciphersuite when
validating a KeyPackage, and the *group's* ciphersuite when validating a member LeafNode already in a tree — these
can differ, and the Rust reference threads a `ciphersuite` parameter through every call site rather than reading it
off the leaf/KeyPackage itself.
**When to use:** Every `0x8009` validation call site (D-16).
**Example:**
```rust
// Source: refs/mdk/crates/cgka-engine/src/account_identity_proof.rs
// validate_staged_commit_account_identity_proofs — note key_package.ciphersuite() for Adds
// vs the passed-in `ciphersuite: Ciphersuite` (= group ciphersuite) for update-path leaves.
for add in staged.add_proposals() {
    let key_package = add.add_proposal().key_package();
    let leaf = key_package.leaf_node();
    ensure_profile(
        validate_leaf_account_identity_proof(leaf, key_package.ciphersuite())?,
        profile, "Add proposal",
    )?;
    ...
}
if let Some(update_path_leaf) = staged.update_path_leaf_node() {
    let update_profile = validate_leaf_account_identity_proof_for_member(
        update_path_leaf, ciphersuite /* GROUP ciphersuite */, committer, "commit update path",
    )?;
    ...
}
```
The TS validator's public signature should take an explicit `ciphersuite: number` parameter (never derive it from the
leaf/KeyPackage internally) so callers cannot accidentally validate a member leaf against its own possibly-stale
KeyPackage ciphersuite field.

### Anti-Patterns to Avoid
- **Porting `mlsSignatureScheme` by editing the legacy module in place:** D-12 requires the legacy file be deleted
  outright, not renamed. Copy the table into the new module as a fresh, independently-authored export; do not `git mv`.
- **Reusing the legacy `AccountIdentityProofSigner` union type** (`function | { signEvent }`) for the new module: Phase
  6 already defines the correct shape (`AuthorizationProofSigner = Pick<EventSigner, "signEvent">`), and D-01 removes
  the raw-digest-function signer shape from the client API entirely — the client always has a real `EventSigner`, so
  there is no more "raw secret key" code path to support at the client layer. (The spec-vector test may still hand-roll
  a bare `{ signEvent }` object for byte-exact `created_at`/aux-randomness control — that is not the same as the
  deleted function-signer union.)
- **Deriving the "applicable ciphersuite" from the leaf/KeyPackage inside the validator:** see Pattern 2 — always take
  it as an explicit parameter from the caller, which already knows whether it's validating a KeyPackage or a group
  member.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| NIP-01 event-id computation, BIP-340 verify, `created_at` range checks, external-signer round-trip validation | A second copy of any of this inside the new `0x8009` module | Phase 6's `src/core/authorization-proof.ts` (`buildAuthorizationProofEvent`, `produceAuthorizationProof`, `verifyAuthorizationProof`) | Already reviewed once (06-REVIEW.md); a second implementation would need its own review and could silently diverge from the spec's canonical-encoding rules |
| Ciphersuite → MLS signature-scheme code-point mapping | A fresh lookup derived from `ts-mls`'s internal ciphersuite struct (none is exported for this) | The existing `MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE` table from the legacy module, re-homed verbatim | STATE.md records this table was already cross-checked against `refs/mdk`'s `ciphersuite.signature_algorithm() as u16` for all 7 ciphersuites — re-deriving it risks reintroducing a transcription error |
| GroupContext proof-profile classification (current/legacy/mixed/neither) | Ad hoc boolean checks scattered at each call site | One pure classifier function (D-07), modelled 1:1 on `protocol_profile_of_group_extensions` in the Rust reference | The Rust function is the tested source of truth for exactly this four-way classification, including its two rejection cases (mixed, neither) |

**Key insight:** Every piece of genuinely new cryptographic or canonical-encoding logic this phase would otherwise
need was already built, reviewed, and merged in Phase 6. Phase 7's actual net-new code is a template, a handful of
field-equality checks, and a profile classifier — all pure data-shape logic with a byte-exact Rust reference to check
against.

## Wrong-container enforcement points (PROOF-05 / PROOF-06 / D-08)

Traced each container the spec forbids `0x8009` from appearing in, against what this codebase's `ts-mls` fork
actually exposes:

| Forbidden location | Exists in this codebase today? | Enforcement point |
|---|---|---|
| KeyPackage-level `extensions` (not `leafNode.extensions`) | Yes — `GenerateKeyPackageOptions.extensions` / `keyPackageDefaultExtensions()` in `src/core/key-package.ts:48-50,69` `[VERIFIED: src/core/key-package.ts]` | The leaf validator must read the proof **only** from `leaf.extensions`'s `app_data_dictionary`, never from the KeyPackage's own top-level `extensions` array. A dedicated PROOF-05 test constructs a `KeyPackage` with the 0x8009 dictionary entry misplaced at `keyPackage.extensions` instead of `keyPackage.leafNode.extensions` and asserts rejection (the validator simply won't find it there, which is itself the rejection — but add an explicit "did you mean the leaf?" detection so a caller can't silently produce a proof-less-looking KeyPackage by mistake). |
| GroupContext `app_data_dictionary` | Yes — `src/core/components/dictionary.ts` `makeAppComponentsExtension` (group-state builder) and `src/core/components/integrity.ts` `validateAppComponentIntegrity` (commit-time diff) `[VERIFIED: src/core/components/dictionary.ts:124-133, src/core/components/integrity.ts]` | Two layers: (1) **create-time guard** — extend `makeAppComponentsExtension`'s existing SafeAAD rejection (`dictionary.ts:127-131`) to also throw for `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID`, so a caller cannot construct a group requesting it as state. (2) **join-time guard** — the D-07 classifier itself rejects `0x8009` present in the GroupContext dictionary (mirrors `protocol_profile_of_group_extensions`'s explicit `app_data.dictionary().contains(&ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)` early-return error). Phase 8 will additionally wire this into `validateAppComponentIntegrity`'s commit-time path (an `AppDataUpdate` trying to write `0x8009` as group state) — out of Phase 7 scope per D-08 ("seam-parity tests stay in Phase 8"), but the **create-time** and **join-time** guards above are in-scope now and give PROOF-06 real unit-testable coverage without waiting for Phase 8. |
| GroupInfo | **No dictionary/component surface exists** — `grep -rn "GroupInfo" ts-mls/src/` finds the `GroupInfo` struct itself (used for Welcome previews, `readWelcomeGroupInfo`) but no `app_data_dictionary`-style accessor on it, and no code in `src/` reads or writes components from a `GroupInfo` today `[VERIFIED: grep against ts-mls/src/ and src/]`. | No enforcement code is needed because no code path can currently *put* `0x8009` there. Document this explicitly as "not reachable in this codebase's current `ts-mls` surface" rather than silently skipping it — if a future `ts-mls` update adds GroupInfo dictionary support, this becomes a real gap. |
| `AppEphemeral` proposal | **Same as GroupInfo — no surface exists.** `grep -rln "AppEphemeral\|appEphemeral"` across `ts-mls/src/` and `src/` returns nothing `[VERIFIED: grep, zero results]`. | Same as above: no enforcement code needed today; document as not-yet-reachable. |
| SafeAAD item | Yes — `src/core/components/dictionary.ts:141-150` `makeLeafAppComponentsExtension` hardcodes the SafeAAD entry as `componentEntry(SAFE_AAD_COMPONENT_ID, encodeComponentsList([]))` (always empty) `[VERIFIED: src/core/components/dictionary.ts:141-150]` | Since this codebase's SafeAAD entry is currently always the empty list and is built by exactly one function, PROOF-06's SafeAAD guard is: when D-15 evolves `makeLeafAppComponentsExtension` to accept the proof, verify the function signature keeps the SafeAAD entry's list independent of `supportedIds` (it must NOT get `0x8009` folded into the SafeAAD advertised-component-set entry — only into `app_components`). A unit test asserting the SafeAAD entry decodes to `[]` even after `0x8009` is added covers this. |

**Net effect for Phase 7:** two of the four forbidden locations (KeyPackage-level `extensions`, GroupContext
dictionary) get real, testable enforcement now; the SafeAAD location gets a regression test proving the existing
"always empty" invariant survives D-15's change; GroupInfo and `AppEphemeral` have no code surface to guard yet and
should be called out as such in the plan rather than silently treated as "handled."

## Runtime State Inventory

> Included because this phase changes what proof format persisted KeyPackages/groups are expected to carry — the
> canonical "did I check every place the old string/format is durably stored" question applies here to `0xf2f1`.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `KeyPackageStore` entries (`src/client/key-package-store.ts`) persist full `KeyPackage` objects including `leafNode.extensions`; any locally-stored KeyPackage generated before this phase may carry a `0xf2f1` extension instead of a `0x8009` dictionary entry. `[VERIFIED: src/client/key-package-store.ts]` | **Code edit, no data migration.** D-09: `KeyPackageManager.ensurePublished` must classify existing stored packages and skip legacy ones (treat as if unused-but-invalid), always minting a fresh `0x8009` package rather than reusing a legacy one. `list()` must expose enough to let a caller identify/`purge()` legacy entries. No bytes are rewritten in place. |
| Stored data | `GenericKeyValueStore<SerializedClientState>` (`groupStateStore`) persists full `ClientState` including the ratchet tree, so any group joined/created before this phase has member leaves carrying `0xf2f1` and a GroupContext requiring `0xf2f1`. `[VERIFIED: src/client/marmot-client.ts MarmotClientOptions.groupStateStore]` | **No action in Phase 7 (D-10 explicit).** These groups load untouched; Phase 8's seams (send/ingest/convergence) are where they eventually get rejected. Do not add a load-time check in this phase. |
| Live service config | None — no external service configuration (relay-side state) encodes the proof format; Nostr relays only ever saw kind-30443/kind-445/kind-444 events, whose bodies are opaque MLS bytes to the relay. | None. |
| OS-registered state | None — this is a library, not a process with OS-level registrations. | None. |
| Secrets/env vars | None — the proof signing key is the client's existing Nostr identity key (already threaded as `EventSigner`); no new secret/env var is introduced or renamed. | None. |
| Build artifacts | `src/__tests__/exports.test.ts`'s inline snapshot (lines 42-331) enumerates every legacy export by name (`ACCOUNT_IDENTITY_PROOF_*`, `accountIdentityProof*`, `*AccountIdentityProof*`, `mlsSignatureScheme`, `signAccountIdentityProof`) — this is a stale test fixture, not an installed package artifact, but it WILL fail to compile/match the moment the legacy module is deleted and MUST be updated in the same commit that deletes it (not a follow-up commit) or the build goes red. `[VERIFIED: src/__tests__/exports.test.ts:42-331]` | Regenerate the inline snapshot (`pnpm vitest run src/__tests__/exports.test.ts -u` or manual edit) as part of the same commit as the deletion. |

## Common Pitfalls

### Pitfall 1: "v2" name collision between the legacy and current proof (already confirmed live in this repo)
**What goes wrong:** The legacy `0xf2f1` extension's own domain tag is literally `marmot.account-identity-proof.v2`
(see `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs:46` `ACCOUNT_IDENTITY_PROOF_DOMAIN`, and the deleted
TS module's own doc comment calls itself "`marmot.account-identity-proof.v2`" at `src/core/account-identity-proof.ts:65`
and `:41`). Meanwhile `tools/quality-gate/proof-v2-probe/` — named for "proof v2" — generates fixtures tagged
`"profile": "legacy-version-byte-2"`, i.e. it is a generator for the **legacy** `0xf2f1` proof, not the new `0x8009`
component this phase implements.
**Why it happens:** The domain tag `d` value stayed the same string across the legacy custom-extension era and the
new spec-defined component (the *new* spec's kind-450 event, per `account-identity-proof-v2.md` "Signing event", also
uses `["d", "marmot.account-identity-proof.v2"]` as its very first tag) — the "v2" refers to the second version of the
Nostr-account-binds-MLS-key *idea*, not to component `0x8009` specifically. Reusing that literal `d` tag value in the
new module is spec-correct (it's what the vector expects) but easy to grep-confuse with the deleted module.
**How to avoid:** `[VERIFIED: refs/marmot/app-components/account-identity-proof-v2.md "Signing event", tags[0]]`
confirms `["d", "marmot.account-identity-proof.v2"]` is required verbatim in the *new* component's event too — do not
"fix" this by changing the string. Instead, rename/delete the confusingly-named Rust probe tool and its fixture (see
Pitfall 2) so the *tooling* name no longer collides, and do not port any function/type name from the legacy TS module
verbatim (D-12 already mandates this).

### Pitfall 2: The `proof-v2-probe` Rust tool and its fixture become dead code that still passes `cargo test`/`pnpm vitest`
**What goes wrong:** `tools/quality-gate/proof-v2-probe/src/main.rs` calls MDK's now-`ProtocolProfile::Legacy`
constructor (`AccountIdentityProofRequest::new`, `account_identity_proof_extension`) to print a legacy-profile fixture
JSON, which is checked into `src/__tests__/fixtures/proof-v2-rust.json` and consumed by
`src/core/__tests__/darkmatter-invite-compat.test.ts` and `src/__tests__/conformance/proof-v2-parity.test.ts`. If this
phase deletes `src/core/account-identity-proof.ts` but leaves the probe/fixture/tests in place unmodified, `pnpm
vitest run` fails immediately (missing imports), which is a fine fail-fast signal — but if someone "fixes" it by
patching import paths onto the *new* module instead of replacing the legacy-profile assertions, the tests would
silently start asserting the wrong (or a type-mismatched) thing.
**Why it happens:** Both test files exist specifically to pin Rust/TS parity for the **legacy** proof (PROOF-01,
already closed per STATE.md's Phase 01 log: "closing PROOF-01"). That requirement is now obsolete under CUT-01/CUT-02
— there must be no code path that can even construct a `0xf2f1` proof anymore.
**How to avoid:** Delete `src/__tests__/conformance/proof-v2-parity.test.ts` and the legacy-proof-specific portions of
`darkmatter-invite-compat.test.ts` entirely (the file's *other* three tests — leaf-extension/proposal/app-component
capability parity — should be updated in place to assert `0x8009` instead of `0xf2f1`, not deleted, since interop
parity with darkmatter's *current* required set is still exactly what that file is for). Retire
`tools/quality-gate/proof-v2-probe/` (delete the crate directory and its `Cargo.toml`/`Cargo.lock`/`src/main.rs`,
remove `proof-v2-rust.json`) rather than leaving it to Phase 11 — it is dead weight the moment `0xf2f1` is gone from
production code, and Phase 11's QA-03 is about a **new** Rust-signed `0x8009` fixture, not a repaired old one; keeping
the old probe around risks someone reaching for it as a template and reproducing the legacy shape by copy-paste.

### Pitfall 3: KeyPackage ciphersuite vs group ciphersuite (PROOF-04)
**What goes wrong:** Validating a member leaf already in a group's ratchet tree against that leaf's own
`KeyPackage.cipherSuite` field (if one is even still attached) instead of the *group's* negotiated ciphersuite lets a
stale or attacker-supplied ciphersuite tag slip through, because the signing event's `ciphersuite`/`signature_scheme`
tags are exactly what the proof binds — get the applicable ciphersuite wrong and you validate a proof against the
wrong reconstructed event, which either always fails (safe but wrong error) or, worse, could be made to pass for the
wrong ciphersuite if an attacker controls both the leaf and a mismatched-but-still-valid ciphersuite value.
**Why it happens:** It's tempting to have one `validateLeafAccountIdentityProof(leaf)` signature that "figures out"
the ciphersuite from context, mirroring how some other validators in this codebase read ciphersuite off already-known
state. The Rust reference deliberately does not do this — see Pattern 2 above; `validate_staged_commit_account_identity_proofs`
passes `key_package.ciphersuite()` for Add proposals but the outer `ciphersuite: Ciphersuite` (group ciphersuite) for
the update-path leaf, in the *same function*.
**How to avoid:** Keep `ciphersuite: number` an explicit, required parameter on every validator entry point; never
infer it inside the validator. `[CITED: refs/mdk/crates/cgka-engine/src/account_identity_proof.rs, validate_staged_commit_account_identity_proofs]`

### Pitfall 4: Forgetting the "exactly one" and "advertised in support list" checks are separate failure modes
**What goes wrong:** A leaf that has the `0x8009` data entry but never listed `0x8009` in its `app_components`
support list (or vice versa) is invalid per the spec ("A support list entry does not substitute for the required
proof data entry" — `account-identity-proof-v2.md` "Negotiation and presence"), but it's easy to write a validator
that only checks one side (e.g. "does the dictionary have a 0x8009 entry?") and calls it done.
**Why it happens:** The Rust reference itself makes this an explicit two-step check inside the `(None, Some(raw))`
match arm of `validate_leaf_account_identity_proof`: first `advertised.contains(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID)`
(support list), separately the dictionary entry lookup that got it into that match arm at all.
**How to avoid:** Test both directions independently: support-listed-but-no-data, and data-present-but-not-listed.
Both must reject. `[CITED: refs/mdk/crates/cgka-engine/src/account_identity_proof.rs, validate_leaf_account_identity_proof lines 351-361]`

## Code Examples

### The verified signing test vector (PROOF-02)
```text
// Source: refs/marmot/app-components/account-identity-proof-v2.md "Signing test vector"
signer_pubkey            = f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9
created_at               = 1700000000
ciphersuite              = 0x0001
signature_scheme         = 0x0807
mls_signature_key        = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f

// Canonical NIP-01 serialization the id is computed over:
[0,"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",1700000000,450,
 [["d","marmot.account-identity-proof.v2"],["component","0x8009"],
  ["ciphersuite","0x0001"],["signature_scheme","0x0807"],
  ["mls_signature_key","000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"]],
 "Authorize this MLS leaf key for my Marmot account"]

event_id  = b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b
signature = c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d

// The resulting 104-byte component:
f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000006553f100c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d
```
This EXACT vector is also independently pinned in the Rust reference's own test suite (`current_proof_matches_the_adopted_signing_vector`,
`refs/mdk/crates/cgka-engine/src/account_identity_proof.rs` lines 828-869), so the plan's PROOF-02 test should assert
against literally this same hex, going through the real class builder (`produceAuthorizationProof`/`buildAuthorizationProofEvent`
composed with the new template function), not a hand-copied constant. `[VERIFIED: both refs/marmot and refs/mdk agree byte-for-byte]`

### Rust reference: the four-way leaf classification this phase's validator must mirror for CUT-02 rejection
```rust
// Source: refs/mdk/crates/cgka-engine/src/account_identity_proof.rs, validate_leaf_account_identity_proof
match (legacy, current) {
    (Some(_), Some(_)) => Err(/* "LeafNode mixes legacy proof extension 0xf2f1 with current proof component 0x8009" */),
    (None, None)        => Err(/* "LeafNode carries neither legacy proof extension 0xf2f1 nor current proof component 0x8009" */),
    (Some(raw), None)   => { /* MDK still accepts Legacy profile here — marmot-ts does NOT (CUT-02, no fallback) */ }
    (None, Some(raw))   => { /* validate as Current */ }
}
```
**Divergence from MDK is intentional and required by CONTEXT.md:** MDK's temporary explicit-legacy path still accepts
the `(Some(raw), None)` legacy-only case. marmot-ts's `0x8009` leaf validator must throw for BOTH `(Some, Some)`
(mixed) AND `(Some, None)` (legacy-only) AND `(None, None)` (neither) — only `(None, Some)` (current-only) may pass.
This is the exact shape CUT-02 requires and is a strictly narrower acceptance set than the Rust reference's.

### GroupContext profile classifier the D-07 helper mirrors
```rust
// Source: refs/mdk/crates/cgka-engine/src/account_identity_proof.rs, protocol_profile_of_group_extensions
// 1. app_data_dictionary MUST NOT contain 0x8009 as group state -> Err if it does
// 2. legacy_required = RequiredCapabilities.extension_types contains 0xf2f1
// 3. current_required = app_components (0x0001) entry, decoded, contains 0x8009
// 4. (legacy_required, current_required) match:
//    (true, false)  -> Legacy
//    (false, true)  -> Current
//    (true, true)   -> Err "mixes legacy proof requirement 0xf2f1 with current proof requirement 0x8009"
//    (false, false) -> Err "requires neither legacy proof extension 0xf2f1 nor current proof component 0x8009"
```
marmot-ts's D-07 helper should throw on every branch except `Current` (again narrower than MDK, which still returns
`Ok(Legacy)` for the legacy-required case — marmot-ts has no legacy acceptance path at all, per CUT-02 and the
"Migration from v1" spec section: "There is no mixed v1/v2 fallback").

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `0xf2f1` custom LeafNode extension, hand-rolled event/binary framing, `version` byte = 2, decimal ciphersuite/scheme tag values | `0x8009` spec-defined `app_data_dictionary` component, `0x`-prefixed 4-hex-digit ciphersuite/scheme tag values, no version byte (component id IS the version) | Spec status: "adopted" as of this research (`refs/marmot/app-components/account-identity-proof-v2.md` header) | Wire-incompatible; MDK's Current profile (the default group shape a downstream darkmatter peer creates) already requires `0x8009`, confirmed independently by `src/__tests__/fixtures/safe-aad-rust.json`'s `advertised_app_components: [1, 32769, 32771, 32777, 32780]` (32777 = `0x8009`), captured from a genuine `Engine::fresh_key_package()` call `[VERIFIED: existing repo fixture, decoded inline above]` |
| `accountProofSigner?: AccountIdentityProofSigner` optional parameter, accepting either a raw-digest function or `{ signEvent }` | Required `signer` (the client's own `EventSigner`, already present) — `Pick<EventSigner,"signEvent">` only, no raw-digest function shape | This phase (D-01/D-02) | Every constructor/options type that threaded the old optional parameter loses that parameter name entirely; this is a breaking public API change (major changeset per D-11) |

**Deprecated/outdated:**
- `src/core/account-identity-proof.ts` and its Rust-fixture-consuming tests: superseded entirely, not incrementally
  patched (D-12: delete outright).
- `tools/quality-gate/proof-v2-probe/`: superseded — see Pitfall 2.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommending deletion of `tools/quality-gate/proof-v2-probe/` and its fixture inside Phase 7 (rather than leaving them for Phase 11) is a scoping call, not a spec/CONTEXT.md requirement — CONTEXT.md's orchestrator notes explicitly left this decision to research/planning. | Pitfall 2 | If the planner disagrees and prefers to leave the dead tool in place until Phase 11 cleans it up, the only cost is a longer window where the repo contains a legacy-profile fixture generator; no functional risk either way. |
| A2 | GroupInfo dictionary and `AppEphemeral` proposal support genuinely do not exist anywhere in this codebase's vendored `ts-mls` or in `src/` (verified via `grep`, zero matches for both). | Wrong-container enforcement points table | If a very recent unmerged `ts-mls` fork change (not reflected in the currently-checked-out `ts-mls` submodule state at research time) adds either surface, the "no enforcement needed" conclusion for those two rows would be stale — re-grep before implementing if the `ts-mls` fork was touched since this research. |

**If this table is empty:** N/A — see rows above. Everything else in this document is either a direct spec/Rust-reference
citation or a direct codebase read (`Read`/`grep` against files in this repo), not training-data recall.

## Open Questions

1. **Exact new `AccountIdentityProofError` reason-to-D-13-string mapping for the four "not reachable yet" PROOF-06
   sub-cases (GroupInfo, `AppEphemeral`).**
   - What we know: no code path exists today that could trigger these, so no reason string is needed for them yet.
   - What's unclear: whether the plan should still add placeholder reason literals to the `AccountIdentityProofError`
     reason union now (for forward-compatibility when `ts-mls` eventually grows these surfaces) or defer that entirely.
   - Recommendation: don't add unused reason literals speculatively — D-13 already says "Add profile reasons as needed";
     add them when the surface exists. Document the gap in the PROOF-06 test file's comments instead, so a future
     `ts-mls` upgrade has a clear TODO marker.

## Environment Availability

Not applicable — this phase has no new external tool/service/runtime dependencies. All work is within the existing
Node/TypeScript workspace and the already-vendored `ts-mls` fork; the only "external" pieces (`refs/marmot`,
`refs/mdk` git submodules) were already re-fetched and found current at plan time (see Orchestrator notes in
`07-CONTEXT.md`: "No refs bump is needed; read them as checked out.").

## Security Domain

> `security_enforcement` is absent from `.planning/config.json` → treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | No user-facing login/session; this is a device-key binding, not user authentication |
| V3 Session Management | No | Not applicable to this phase |
| V4 Access Control | Partial | `src/engine/admin-policy.ts`'s admin-commit gate already exists (Phase 3/4 work); this phase only swaps which extension id it checks for proof presence (D-06 like-for-like) — no new access-control logic |
| V5 Input Validation | Yes | The entire `0x8009` validator (`src/core/components/account-identity-proof.ts`) is input validation over attacker-influenceable LeafNode/KeyPackage bytes — length checks, location checks, field-equality checks, all before any signature verify (mirrors Phase 6's "length, then structural, then signature" ordering, which 06-REVIEW.md confirmed is correct) |
| V6 Cryptography | Yes | BIP-340 Schnorr verify via `@noble/curves/secp256k1.js` `schnorr.verify` (already in use, never hand-rolled) — this phase adds no new cryptographic primitive, only a new template over the existing verified primitive |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Legacy-proof downgrade / fallback acceptance (an attacker crafts a `0xf2f1`-only or mixed `0xf2f1`+`0x8009` leaf hoping a lenient validator accepts it) | Spoofing / Tampering | CUT-02's leaf validator must reject strictly narrower than the Rust reference's own "Legacy" acceptance branch — see the four-way match table in Code Examples above. No fallback path, no feature flag to re-enable it. |
| Proof/leaf-key confusion (a valid proof for one MLS signature key attached to a leaf using a *different* signature key) | Tampering / Spoofing | `validate_proof_bindings`-equivalent check: `proof.signer_pubkey == leaf.credential.identity` AND `mls_signature_key (signed) == leaf.signature_key (actual)`, both exact-equality, both before signature verify (matches Phase 6's WR-03 review finding pattern: compare fields structurally, not just decode-and-trust) |
| Ciphersuite/scheme substitution (attacker supplies a proof signed for a different ciphersuite than the leaf is validated under, hoping the wrong reconstructed event still happens to verify) | Tampering | Explicit `ciphersuite` parameter threading (Pitfall 3) — never inferred from the leaf being validated |
| Wrong-container smuggling (PROOF-05/06): placing `0x8009` where MLS/ts-mls integrity guarantees don't cover it as tightly (e.g. KeyPackage-level `extensions` vs `leafNode.extensions`) | Tampering / Elevation of Privilege | Explicit location checks per the Wrong-container enforcement points table above, not implicit "wherever the codec happens to look for it" |

## Sources

### Primary (HIGH confidence)
- `refs/marmot/app-components/account-identity-proof-v2.md` — component registry entry, signing event shape, production/reuse rules, negotiation/presence rules, validation list, signing test vector, migration-from-v1 rules (read in full)
- `refs/marmot/app-components/README.md`, `refs/marmot/app-components/CLAUDE.md` — component id range, negotiation model, GroupContext update processing ownership rules
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs` — full file read: request construction, legacy vs current material, `validate_leaf_account_identity_proof`, `validate_proof_bindings`, `protocol_profile_of_group_extensions`, `validate_staged_commit_account_identity_proofs`, `validate_standalone_proposal_account_identity_proof`, and the module's own pinned-vector unit test
- `refs/mdk/crates/cgka-engine/CLAUDE.md`, `refs/mdk/crates/cgka-engine/src/CLAUDE.md` — shared-chokepoint/seam-parity conventions the Phase 8 wiring will need to follow
- `src/core/authorization-proof.ts` (Phase 6, full read) — the exact primitive this phase's template plugs into
- `src/core/account-identity-proof.ts` (legacy, full read, to be deleted) — confirms exact current `0xf2f1` shape and every symbol name that must disappear
- `src/core/components/{dictionary,ids,app-components-list}.ts`, `src/core/{key-package,capabilities,group}.ts`, `src/engine/admin-policy.ts`, `src/client/{marmot-client,groups-manager,group-factory,key-package-manager,key-package-publisher,key-package-store}.ts`, `src/client/group/proposals/{invite-user,update-metadata}.ts` — full reads, all call sites verified directly
- `src/__tests__/exports.test.ts` — current public-export snapshot, verified exact symbol list to remove/re-home
- `tools/quality-gate/proof-v2-probe/src/main.rs`, `src/__tests__/conformance/proof-v2-parity.test.ts`, `src/core/__tests__/darkmatter-invite-compat.test.ts`, `src/__tests__/helpers/account-proof.ts`, `examples/opentui/src/helpers/account-proof.ts` — full reads confirming the legacy-fixture toolchain and its consumers
- `src/__tests__/fixtures/safe-aad-rust.json` — decoded inline (`python3 -c "json.load(...)"`), confirms `0x8009` (32777) already appears in a genuine current-profile MDK fixture's `advertised_app_components`

### Secondary (MEDIUM confidence)
- `docs/client/best-practices.md:53-55`, `docs/client/marmot-client.md:41`, `docs/client/proposals.md:13`, `docs/core/index.md:15`, `docs/core/protocol.md:89-90`, `docs/guide/architecture.md:50` — grepped for exact `accountProofSigner`/`0xf2f1`/`account-identity-proof.v1` mentions needing D-11 doc updates

### Tertiary (LOW confidence)
- None — every claim above traces to a spec file, the Rust reference, or a direct read/grep of this repository.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; every type/function reused is already merged and reviewed (Phase 6)
- Architecture: HIGH — traced every current `0xf2f1` call site by direct file read, not inference
- Pitfalls: HIGH — Pitfall 1 and 2 are directly confirmed in this repository's own files (naming collision, dead-tool risk), not speculative

**Research date:** 2026-09-14
**Valid until:** 30 days (stable spec surface; `refs/marmot`/`refs/mdk` re-checked at phase start per this project's CLAUDE.md standing rule, so staleness self-corrects at the next phase's kickoff)
