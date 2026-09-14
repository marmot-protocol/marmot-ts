# Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut - Context

**Gathered:** 2026-09-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the adopted `marmot.member.account-identity-proof.v2` proof class (component `0x8009`, kind-450 event) on
top of the Phase 6 `MarmotAuthorizationProof` primitive. Generated KeyPackages and leaves advertise `0x8009` in their
LeafNode `app_components` list and carry exactly one `0x8009` entry in the single LeafNode `app_data_dictionary`. This
works with any `{ signEvent }` signer. Leaves and KeyPackages with a missing, invalid, misplaced, or legacy proof are
rejected. The legacy `0xf2f1` extension is removed from publish, verify, capabilities, admin policy, and the exports,
with no fallback.

Covers PROOF-02..06, CUT-01, CUT-02.

**Not in this phase:**
- Enforcing the GroupContext `0x8009` requirement identically on the send, ingest, pool-replay, and convergence seams, plus the seam-parity tests (Phase 8, GRP-01..04).
- Self-update identity binding (Phase 9).
- Founding create via Welcome (Phase 10).
- Rust-signed interop fixtures and the QA gate (Phase 11).

</domain>

<decisions>
## Implementation Decisions

### Proof signer in the client API
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

### Phase 7 / Phase 8 boundary
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

### Legacy local state
- **D-09:** Stored KeyPackages whose leaf is legacy (`0xf2f1` / no valid `0x8009`) are **skipped as non-current**.
  `KeyPackageManager.ensurePublished` ignores them and creates a fresh `0x8009` package, while `list()` still returns
  them flagged or filterable so apps can call `purge()` explicitly. Nothing is auto-deleted and no kind-5 is sent;
  published rotation stays out of scope.
- **D-10:** Stored groups persisted by v1.0 that require `0xf2f1` **load untouched** in Phase 7. There is no new
  load-time check; the Phase 8 seams reject them.
- **D-11:** Release as a **major** changeset listing the removed `accountProofSigner` option and legacy exports. Add a
  short migration section to the docs: republish KeyPackages, legacy groups are unreadable, and signer changes. Check
  `docs/signers/` and the client docs for `accountProofSigner` mentions.

### Validator shape & errors
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Proof class spec (normative)
- `refs/marmot/app-components/account-identity-proof-v2.md`: registry, valid/invalid locations, the exact kind-450
  event (5 ordered tags, `0x`-hex ciphersuite/scheme, fixed content), production/reuse, negotiation and presence,
  validation list, the **signing test vector** (PROOF-02 must reproduce it through the real class builder), and
  migration from v1 (no fallback; legacy group outside the profile).
- `refs/marmot/foundation/authorization-proofs.md`: the envelope rules the Phase 6 primitive implements.
- `refs/marmot/foundation/canonical-encoding.md`: NIP-01 serialization and hex rules.
- `refs/marmot/app-components/README.md`: component negotiation, the LeafNode `app_components` support list vs the
  GroupContext required list, and the dictionary rules.
- `refs/marmot/foundation/key-packages.md`: KeyPackage structure, where the leaf proof lives vs KeyPackage-level
  extensions (PROOF-05).

### Rust reference
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`:
  - `validate_leaf_account_identity_proof` (legacy/current/mixed/neither classification of a leaf; MDK accepts
    legacy, marmot-ts rejects it).
  - `validate_current_proof`, `validate_proof_bindings` (identity, signature key, ciphersuite, scheme checks).
  - `protocol_profile_of_group_extensions` (GroupContext profile classifier plus rejection of `0x8009` in GroupContext;
    the model for D-07).
  - `validate_staged_commit_account_identity_proofs` and `validate_standalone_proposal_account_identity_proof`
    (the Phase 8 seam shape).
- `refs/mdk/crates/cgka-engine/src/app_components.rs`: leaf `app_components` / dictionary helpers,
  `app_data_dictionary_extension_for_group` (no `0x8009` branch).
- `refs/mdk` was bumped to `17496e98` at the start of this phase (commit `86fdd2b`). None of the new upstream commits
  touch proof code.

### Phase 6 (dependency)
- `src/core/authorization-proof.ts`: `encode/decode/verify/produceAuthorizationProof`,
  `buildAuthorizationProofEvent`, `AuthorizationProofError` / `AuthorizationProofRejectReason`,
  `AuthorizationProofSigner`.
- `.planning/phases/06-shared-authorization-proof-envelope-primitive/06-CONTEXT.md`: D-01..D-13 (template plug-in,
  throw model, signEvent-only, `createdAt` rules).
- `.planning/phases/06-shared-authorization-proof-envelope-primitive/06-REVIEW.md`: open warnings WR-01 (kind
  range), WR-02 (non-canonical text escaping), WR-03 (sparse tags escape as plain Error). The `0x8009` class uses
  fixed ASCII kind 450, so these are latent here. The planner should decide whether to fix them first, since Phase 7
  is the first consumer.

### Planning / research
- `.planning/REQUIREMENTS.md`: PROOF-02..06, CUT-01, CUT-02 (and GRP-*, UPD-* for boundary awareness).
- `.planning/research/PITFALLS.md`: Pitfalls 1 (decimal-tag regression), 3 (KeyPackage vs group ciphersuite),
  7 (support list vs data entry), 8 (duplicate dictionary entries), 9 (`0x8009` leaking into GroupContext/AppDataUpdate),
  10 (mixed-profile states), 14 (legacy fixtures; grep-audit of all `0xf2f1` files), 15 (exports snapshot churn).
- `.planning/research/ARCHITECTURE.md`, `.planning/research/SUMMARY.md`: v2.0 phase rationale.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/authorization-proof.ts`: the complete envelope primitive. The class only supplies
  `{ kind: 450, tags, content }` and the expected signer pubkey.
- `src/core/components/dictionary.ts`: `buildAppDataDictionary`, `componentEntry`, `getComponentData`,
  `makeLeafAppComponentsExtension` (evolve per D-15), `makeAppComponentsExtension` (already rejects SafeAAD as group
  state, the pattern for rejecting `0x8009`).
- `src/core/components/app-components-list.ts`: `encodeComponentsList` / `decodeComponentsList`.
- `src/core/components/ids.ts`: `SUPPORTED_APP_COMPONENT_IDS`, `DEFAULT_GROUP_COMPONENT_IDS`, component id/name
  constants.
- `mlsSignatureScheme(ciphersuite)` in the legacy module is the ciphersuite→scheme mapping. Re-home it (or use
  ts-mls's) before deleting the legacy file.

### Established Patterns
- `makeAppComponentsExtension` throwing `UsageError` for SafeAAD in GroupContext: the precedent for location
  rejection.
- `BinaryDecodeError` / `AuthorizationProofError`: typed error pattern (`this.name`, `reason` literal union).
- Named exports, `.js` import extensions, `Uint8Array`, no `Buffer`. Tests must pass on Node 20/22/24, Deno 2, and
  Bun.

### Integration Points (all current `0xf2f1` references; each must be migrated or deleted)
- **Core:**
  - `src/core/account-identity-proof.ts` (delete).
  - `src/core/key-package.ts` (`generateKeyPackage`: signer required, leaf dictionary via D-15).
  - `src/core/capabilities.ts` (drop `0xf2f1` from `ensureMarmotCapabilities` extensions and from
    `marmotRequiredCapabilitiesExtension`).
  - `src/core/group.ts` / `ids.ts` (D-05 required `0x8009`).
- **Engine:** `src/engine/admin-policy.ts` (D-06 like-for-like).
- **Client:**
  - `src/client/marmot-client.ts`, `groups-manager.ts`, `group-factory.ts`, `key-package-manager.ts`,
    `key-package-publisher.ts` (remove `accountProofSigner`, D-01).
  - `groups-manager.ts:724` (join: whole-tree validator plus the D-07 profile helper).
  - `src/client/group/proposals/invite-user.ts` (validate the invitee KeyPackage with its own ciphersuite).
  - `key-package-manager.ts` `ensurePublished` / `list` (D-09).
- **Tests:**
  - `src/core/__tests__/account-identity-proof.test.ts`, `capabilities.test.ts`, `key-package.test.ts`,
    `darkmatter-invite-compat.test.ts`.
  - `src/engine/__tests__/group-engine.test.ts`.
  - `src/client/group/__tests__/marmot-group.test.ts`, `src/client/group/proposals/__tests__/invite-user.test.ts`.
  - `src/__tests__/conformance/proof-v2-parity.test.ts` (legacy "v2" parity; replace with the `0x8009` vector).
  - `src/__tests__/exports.test.ts` (snapshot: legacy exports removed, new exports added).
  - `src/__tests__/helpers/account-proof.ts` (delete, D-04).
- **Examples:** `examples/opentui/src/helpers/account-proof.ts` (delete) and its call sites; they must still compile.
- **Docs:** `docs/signers/`, `docs/client/` (mentions of `accountProofSigner` and raw-key digest signing), `.changeset/`
  (D-11).

</code_context>

<specifics>
## Specific Ideas

- PROOF-02 byte-exact test goes through the **real class builder**, not a hand-built template: secret key 3,
  zero aux, `created_at` 1700000000, ciphersuite `0x0001`, scheme `0x0807`, `mls_signature_key` `000102…1f`.
  It must match event id `b7e9a15d…af6b`, the signature, and the 104-byte component hex.
- Negative tests from PITFALLS 7/8/10 must each be rejected:
  - support listed but no data;
  - data but not listed;
  - two `0x8009` entries;
  - a leaf with only `0xf2f1`;
  - a leaf with both `0xf2f1` and `0x8009`;
  - a GroupContext requiring `0xf2f1` only;
  - a GroupContext requiring both;
  - a GroupContext requiring neither;
  - `0x8009` data in a GroupContext;
  - `0x8009` in KeyPackage-level `extensions`.
- After the phase, a grep audit must show no `0xf2f1` / `AccountIdentityProof` references in `src/` or `examples/`
  except tests that deliberately assert rejection.

</specifics>

<deferred>
## Deferred Ideas

- **Phase 8 must close:** admin-policy's skip of proof-less Adds (D-06), and wiring the D-07 profile classifier and
  leaf validators into the send, ingest, pool-replay, and convergence seams.
- **Phase 8 / later:** rejecting legacy stored groups at load time (D-10 chose to load them untouched).
- Automatic purge or rotation of legacy published KeyPackages. It stays out of v2.0 scope; apps call `purge()`
  (D-09).
- Exposing an injectable proof clock on `MarmotClient` for app-level deterministic tests (D-03 keeps it core-only).

</deferred>

---

*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Context gathered: 2026-09-14*
