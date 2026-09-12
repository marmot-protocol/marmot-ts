# Architecture Research: v2.0 Account identity proof v2 (component `0x8009`)

**Domain:** integration research — how the adopted `marmot.member.account-identity-proof.v2` app component
(`0x8009`) and Current-profile founding-create-via-Welcome cut into the existing marmot-ts layered architecture
**Researched:** 2026-09-12
**Confidence:** HIGH (every claim below is grep-verified against `src/`, cross-checked against
`refs/mdk/crates/cgka-engine/src/{account_identity_proof.rs,app_components.rs,group_lifecycle.rs,self_update.rs,
message_processor/{send,ingest}.rs,openmls_projection.rs,engine.rs}` at `refs/mdk` `accda242` and
`refs/marmot/app-components/account-identity-proof-v2.md` + `refs/marmot/foundation/authorization-proofs.md` +
`refs/marmot/protocol-core/group-setup.md` at `refs/marmot` `4a2bc65`)

## 0. What changes, in one paragraph

Today the proof is a raw MLS **LeafNode custom extension** `0xf2f1` (`src/core/account-identity-proof.ts`), an MLS
capability that must be negotiated via `Capabilities.extensions` (`src/core/capabilities.ts`). The adopted spec moves
it to an **app component** `0x8009` carried as a 104-byte `MarmotAuthorizationProof` entry inside the LeafNode's
`app_data_dictionary` (the same container marmot-ts already uses for GroupContext-level components like
`admin-policy.v1`), advertised via the ordinary `app_components` (`0x0001`) support/require lists that
`src/core/components/` already builds — **not** via MLS `Capabilities.extensions`/`required_capabilities`. This is a
strictly bigger change than "rename a constant": it moves the proof from the MLS-capability-negotiation subsystem to
the Marmot app-component subsystem, adds a GroupContext-level requirement (every resulting epoch's `app_components`
list must contain `0x8009`), and — per the milestone's separate "founding create via Welcome" decision — changes how
`create()` publishes when it seeds initial members. `src/core/components/integrity.ts`'s `validateCommitLegality`
(the shared seam adapter already used by send/inbound/pool-replay/tree-fed) is the natural chokepoint to extend,
mirroring MDK's `validate_current_profile_invariants_for_staged_commit`.

## 1. Complete inventory of files/seams that must change

Grep-verified (`0xf2f1`, `ACCOUNT_IDENTITY_PROOF`, `verifyLeafAccountIdentityProof`, `verifyAllLeafAccountIdentityProofs`,
`capabilities`, `createGroup`/`group-factory`, `accountProofSigner`) against `src/` on 2026-09-12.

### 1.1 Core primitive layer (`src/core/`) — MODIFIED / SPLIT

| File | Current role | What must change |
|---|---|---|
| `src/core/account-identity-proof.ts` (416 lines) | Owns `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1`, the whole `AccountIdentityProofRequest`/proof event/sign/verify pipeline, `encodeAccountIdentityProof`/`decodeAccountIdentityProof` (custom fixed-width layout: version+ciphersuite+scheme+identity+keylen+key+sig), `makeAccountIdentityProofExtension` (LeafNode *extension*, not dictionary entry), `verifyLeafAccountIdentityProof`/`verifyAllLeafAccountIdentityProofs` | Split in two (see §2 "new modules"): the reusable 104-byte envelope moves to a new shared primitive; this file's remainder becomes the `0x8009` proof-class module and loses the `0xf2f1` layout, the `version`/`mls_signature_key`/`extension` tag shape, and the `created_at = 0` convention |
| `src/core/capabilities.ts:58,101` (`ensureMarmotCapabilities`, `marmotRequiredCapabilitiesExtension`) | Pushes `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE` into MLS `Capabilities.extensions` (line 58) and into the `required_capabilities` `extensionTypes` list (line 101) | **Remove both** — 0x8009 is not an MLS extension type at all once it lives in `app_data_dictionary`; MDK's `leaf_app_components_extension` (`refs/mdk/.../app_components.rs:62-79`) never touches `Capabilities`/`required_capabilities` for the proof. Confirms this is a deletion, not a rename, in this file |
| `src/core/key-package.ts:85,96,124-140` (`generateKeyPackage`) | Builds a raw LeafNode `CustomExtension` for the proof (`buildAccountIdentityProofExtension` → `leafNodeExtensions.push(...)`) alongside `makeLeafAppComponentsExtension()` | Proof entry moves **into** the same `app_data_dictionary` extension `makeLeafAppComponentsExtension()` already builds, as a `0x8009` `ComponentData` entry plus a `0x8009` id in the leaf's `app_components` (`0x0001`) support list — one dictionary, not two extensions |
| `src/core/components/ids.ts` | `AppComponentId` registry (`0x8001`..`0x800c`); `DEFAULT_GROUP_COMPONENT_IDS`, `SUPPORTED_APP_COMPONENT_IDS` | **New id**: `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID = 0x8009`. Add to `DEFAULT_GROUP_COMPONENT_IDS` (drives `requiredIds` in `createGroup`, `src/core/group.ts:69-74`) — but NOT to the list of ids that get a GroupContext-level `ComponentData` entry (it is leaf-only; MDK explicitly rejects "GroupContext carries leaf-only proof component 0x8009 state", `account_identity_proof.rs:486-494`) |
| `src/core/components/dictionary.ts:141-150` (`makeLeafAppComponentsExtension`) | Builds the LeafNode `app_data_dictionary` with `app_components` (0x0001) + SafeAAD (0x0002) entries only | Needs a new parameter/overload to also insert the `0x8009` proof `ComponentData` entry and add `0x8009` to the advertised id list — mirrors MDK `leaf_app_components_extension(supported, account_identity_proof: Option<&[u8]>)` (`app_components.rs:62-79`) |
| `src/core/components/integrity.ts:275-336` (`validateCommitLegality`) | Shared seam adapter: `validateAppComponentIntegrity` + `validateAdminLeafCoupling` + disband classification | **Extend**: add a third check mirroring MDK's `validate_current_profile_invariants_for_staged_commit` (`app_components.rs:814-829`) — resulting GroupContext `app_components` (0x0001) list must still contain `0x8009`, and every resulting member leaf must carry a valid `0x8009` proof bound to that leaf's credential/signature key/ciphersuite. New `CommitIntegrityViolationReason` value, e.g. `"account-identity-proof"` |
| `src/core/group.ts:11,69-96` (`createGroup`) | Builds GroupContext extensions incl. `marmotRequiredCapabilitiesExtension()` and the `app_components` (0x0001) required-ids list | `requiredIds` picks up `0x8009` automatically once it's in `DEFAULT_GROUP_COMPONENT_IDS`; no `ComponentData` entry needed for it (leaf-only) |
| `src/core/group-lifecycle.ts` | FSM `Stable\|PendingPublish\|Merging\|Recovering\|Unrecoverable`; `transitionLifecycle()`, `mayPrepareLocalCommit` | Likely unaffected directly, but **founding-create-via-Welcome** (§5) needs a documented answer: does a founding create with invitees ever enter `PendingPublish`, or does it go straight to `Stable` because no group-event commit is published? This FSM is where that decision must be made explicit |

### 1.2 Engine layer (`src/engine/`) — MODIFIED

| File:line | Current role | What must change |
|---|---|---|
| `src/engine/admin-policy.ts:1-17,44-54` (`createAdminCommitPolicyCallback`) | Inline proof check on Add proposals inside the MLS `IncomingMessageCallback`, using raw `0xf2f1` extension lookup + `verifyLeafAccountIdentityProof` | Must read the `0x8009` component from the *proposed* LeafNode's `app_data_dictionary` instead of `leaf.extensions`. Per the doc comment on `withCapturedProposals` (`src/engine/admin-policy.ts:120-158`), this inline check runs pre-apply and is deliberately narrow (rejects unreadable adds) — do not duplicate the full 0x8009 seam-adapter check here; that lives in `validateCommitLegality` (§1.1) which runs post-apply. Keep this file's role scoped to what it already does (admin-only-commit gate) plus the swapped decode |
| `src/engine/ingest.ts:23,730-745` | Direct-ingest seam: calls `validateCommitLegality` after `processMessage` resolves, before `ctx.setState`/`ctx.recordCommit` | No structural change — automatically inherits the new check once `validateCommitLegality` is extended (§1.1). This is marmot-ts's analog of MDK's `message_processor/ingest.rs:1390` direct-apply call |
| `src/engine/group-engine.ts:50,1291-1295` (`#assertStagedCommitLegal`) | Send-producing seam: both `commit` and `selfUpdate` sends call this before releasing `PendingPublish` | No structural change — inherits the extended check. Analog of MDK's two `send.rs` call sites (`send.rs:304,613`) plus `self_update.rs:165` |
| `src/engine/fork-recovery.ts:20,125-131` | Candidate-branch building / tree-fed re-convergence: calls `validateCommitLegality` per candidate edge, converts throw→`"deferred"` | No structural change — inherits the extended check. Analog of MDK's `openmls_projection.rs:3802` stored-convergence/replay apply |
| `src/engine/group-engine.ts` (self-update / replacement-leaf path — grep for `selfUpdate` send kind) | Currently only rotates the leaf's signature key via ts-mls's self-update mechanics; no proof-specific binding logic | **New requirement** (self-update binding, in scope this milestone): a replacement leaf produced by self-update MUST carry a fresh valid `0x8009` proof binding the *same* credential identity to the *new* leaf signature key — `0x8009` is "never removable from a non-blank leaf" (spec). This is the marmot-ts analog of MDK's `self_update.rs:165` call into `validate_staged_commit_account_identity_proofs`, which already covers the update-path leaf; marmot-ts needs the equivalent leaf-rebinding check reachable from the same `#assertStagedCommitLegal` chokepoint (§1.1) so it is never a self-update-only special case |

### 1.3 Client layer (`src/client/`) — MODIFIED

| File:line | Current role | What must change |
|---|---|---|
| `src/client/groups-manager.ts:22,724` (`verifyAllLeafAccountIdentityProofs` call in join) | Verifies every member leaf's proof right after `joinGroup` resolves, before `adoptClientState` | Swap to the `0x8009`-based verifier; add the GroupContext-level check ("this group's `app_components` list requires `0x8009`") since join is exactly the seam MDK's spec text singles out ("A Marmot group is invalid if its GroupContext does not require component id 0x8009…") |
| `src/client/group/proposals/invite-user.ts:5,22` (`proposeInviteUser`) | Verifies the invitee KeyPackage's leaf proof before building the Add proposal | Swap to `0x8009` verifier read from the KeyPackage leaf's `app_data_dictionary` (ciphersuite is the *KeyPackage's* ciphersuite per spec, not necessarily the group's — matches the existing call which already passes `ciphersuite.id` from proposal context) |
| `src/client/key-package-manager.ts:13,151-200`, `src/client/key-package-publisher.ts:14,35,78,85,111`, `src/client/marmot-client.ts:11,102,230,253` | Thread `accountProofSigner: AccountIdentityProofSigner` option down to `generateKeyPackage` | Only the imported type name changes (still "the signer for the account identity proof"); no structural change, since these are pass-through plumbing, not proof logic |
| `src/client/group-factory.ts:13,49,82,101,133` (`GroupFactory.create`) | Solo-admin group creation only (no initial invitees) — confirmed by reading `createSimpleGroup`/`SimpleGroupOptions` (`src/core/group.ts:112-166`), which has no members parameter | **New capability required** for founding-create-via-Welcome (§5): `create()` (or a new sibling entry point) needs an initial-invitees parameter that produces a canonical epoch (0 or higher) with Adds already applied locally, publishing **zero** group-event commits — only Welcomes. Today, adding the *first* invitees after `create()` goes through the ordinary `proposeInviteUser` → `GroupSession.send({kind:"commit"})` → `GroupRuntime.publishCommit` path, which **does** publish a kind-445 handshake commit event (`src/client/runtime/group-runtime.ts:121-153`) — this is exactly the path the milestone says must not fire for Current-profile founding creation |
| `src/client/runtime/group-runtime.ts:48,121-153,449-464` (`GroupPublishWork` "groupEvolution" case, `#publishCommitResult`/`publishCommit`) | Every `groupEvolution` publish work item always publishes `work.envelope` (the commit) to group relays *and* delivers `work.welcome` | Needs a new `GroupPublishWork` variant (or a flag on the existing one) for "welcome-only, no group-event commit" so founding-create can skip the group-relay publish entirely while still driving welcome delivery through the existing `transport/nostr/welcome-delivery.ts` machinery |
| `src/client/session/group-session.ts:601-625` (`send`, `"commit"` case) | Always expects `sendResult.kind === "groupEvolution"` with both `envelope` and optional `welcome` | A founding-create path likely bypasses `GroupSession.send()` entirely (there is no epoch-N→N+1 *transport* commit to produce) and instead calls a new engine/core entry point that returns `{ resultingState, welcomes }` directly — see §5 |

### 1.4 Test/fixture inventory — MODIFIED (not exhaustive; every listed file references `0xf2f1` or the proof API)

- `src/core/__tests__/account-identity-proof.test.ts` — full unit coverage of the current 0xf2f1 codec/verify pipeline; rewritten for the 0x8009 shape
- `src/core/__tests__/capabilities.test.ts` — asserts 0xf2f1 in capabilities/required_capabilities; assertions invert (assert absence) plus new assertions for 0x8009 in `app_components`
- `src/core/__tests__/key-package.test.ts` — asserts proof extension presence on generated KeyPackage leaves
- `src/core/__tests__/darkmatter-invite-compat.test.ts` — cross-impl fixture keyed to the legacy 0xf2f1 shape; needs a v2/Current-profile fixture (or replacement) — this file's `RUST_FIXTURE_CIPHERSUITE` pattern is the natural home for a new MDK-Current fixture
- `src/__tests__/conformance/proof-v2-parity.test.ts` — already-existing conformance test naming ("proof-v2") that in fact tests the pre-adoption 0xf2f1 shape (per PROJECT.md: "v1.0's PROOF-01 shipped the pre-adoption proof shape"); needs to be re-pointed at the adopted 0x8009 vector from `refs/marmot/app-components/account-identity-proof-v2.md` (the doc's own signing test vector: `signer_pubkey=f9308a...`, `created_at=1700000000`, `event_id=b7e9a15d...`)
- `src/__tests__/fixtures/safe-aad-rust.json` — check whether this fixture's leaf bytes embed an 0xf2f1 extension that would need regenerating against MDK at `accda242` for an 0x8009 leaf
- `src/__tests__/helpers/account-proof.ts` (21 lines) — shared test double for building a signed proof; needs its call shape updated once the primitive splits (§2)
- `src/client/group/proposals/__tests__/invite-user.test.ts`, `src/client/group/__tests__/marmot-group.test.ts`, `src/engine/__tests__/group-engine.test.ts` — all construct test leaves/KeyPackages carrying the legacy proof shape
- `src/__tests__/exports.test.ts:319,321` (see §4) — snapshot assertion of the full public export list; will fail on any renamed/removed/added export until updated

## 2. New modules vs modified modules

**New (per the milestone's explicit primitive-first decision — "Shared `MarmotAuthorizationProof` 104-byte envelope
primitive in `src/core`"):**

| New file (suggested) | Purpose | Mirrors |
|---|---|---|
| `src/core/authorization-proof.ts` (or `authorization-proof-envelope.ts`) | The reusable 104-byte envelope: `{ signerPubkey: 32 bytes, createdAt: uint64 (1..2^53-1), signature: 64 bytes }` — pure encode/decode/verify (BIP-340 over a caller-supplied NIP-01 event id), no proof-class-specific event-building. Owns the shared range check (`createdAt` MUST be in `1..=2^53-1`, per `refs/marmot/foundation/authorization-proofs.md`) and the shared "reconstruct event → compute id → verify signature" algorithm | `refs/mdk` has no equivalent shared Rust module yet (MDK's rustdoc at `account_identity_proof.rs:13-25` calls out this exact layering gap as a TODO — mdk#755 — so marmot-ts's clean split is *ahead* of the current Rust engine, not behind it) |
| `src/core/components/account-identity-proof.ts` (or similar, inside `src/core/components/`) | The `0x8009` proof CLASS built on the shared envelope: the exact kind-450 tag order (`d`, `component`, `ciphersuite`, `signature_scheme`, `mls_signature_key`), content string `"Authorize this MLS leaf key for my Marmot account"`, `0x`-hex-encoded ciphersuite/scheme tags, and the binding checks (signer_pubkey == credential identity, mls key == leaf signature key, ciphersuite/scheme match) | `refs/mdk/.../account_identity_proof.rs` `validate_current_proof`/`AccountIdentityProofRequest::current` (current-profile branch only — the legacy branch is dead code for marmot-ts's clean cut) |
| A codec entry in `src/core/components/ids.ts` + `dictionary.ts` for `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID = 0x8009` | Registers 0x8009 alongside the other components (admin-policy, profile, etc.) in the existing descriptor-table pattern (`dictionary.ts:161-221` `ComponentCodec<T>` table) | `refs/mdk/.../traits/src/app_components/mod.rs` `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` |

**Deleted (clean cut, no fallback per the milestone decision):**

- `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1` and its whole custom-extension codec (`encodeAccountIdentityProof`/`decodeAccountIdentityProof` in the current fixed-width `version+ciphersuite+scheme+identity+keylen+key+sig` layout) — this layout has no successor; 0x8009's wire shape is the fixed 104 bytes with no version byte and no embedded key-length prefix
- The two `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE` capability push sites in `src/core/capabilities.ts:58,101` (§1.1)
- `src/core/__tests__/darkmatter-invite-compat.test.ts`'s legacy-only fixture path (once replaced, not before — keep for regression until the 0x8009 fixture lands, since "legacy KeyPackages, leaves, and groups rejected with no fallback" is itself a testable requirement: a legacy-shaped leaf/KeyPackage MUST now be *rejected*, not silently accepted, so the old fixture becomes a negative test rather than being deleted outright)

**Modified only (no new file, logic changes in place):** everything in §1.1–§1.3 tables not listed above as new/deleted.

## 3. Validation seam mapping — MDK call sites → marmot-ts equivalents

Mirroring MDK's own stated rule ("Mirror every ingest invariant on every inbound seam" — `refs/mdk/crates/cgka-engine/CLAUDE.md`
"Conventions in this crate"), every MDK call site of `validate_staged_commit_account_identity_proofs` /
`validate_leaf_account_identity_proof` / `validate_current_profile_invariants_for_staged_commit` has a marmot-ts
seam it must land on:

| # | MDK call site | What it checks | marmot-ts equivalent seam | Status |
|---|---|---|---|---|
| 1 | `message_processor/send.rs:304` (`do_send_invite`) | Staged commit's Add proposals + update-path leaf | `src/client/group/proposals/invite-user.ts:22` (pre-stage, on the KeyPackage) **and** `src/engine/group-engine.ts:1291` `#assertStagedCommitLegal` (post-stage, on the resulting state) — marmot-ts already has both a pre-admission proposal-level check and a post-apply commit-level check; the 0x8009 seam adapter (§1.1) must run in the post-apply one | Extend `validateCommitLegality` |
| 2 | `message_processor/send.rs:613` (another `do_send_*`, e.g. remove/upgrade) | Same staged-commit check | Same `group-engine.ts:1291` chokepoint (all send-producing commits funnel through `#assertStagedCommitLegal`) | Extend `validateCommitLegality` |
| 3 | `self_update.rs:165` | Update-path leaf only (self-update never adds/removes members) | Same `group-engine.ts:1291` chokepoint for the `selfUpdate` send kind | Extend `validateCommitLegality` + add self-update leaf-rebinding check (§1.2) |
| 4 | `message_processor/ingest.rs:1390` (direct-ingest apply) | Full staged-commit check on inbound commits | `src/engine/ingest.ts:730` (already calls `validateCommitLegality` post-`processMessage`) | Extend `validateCommitLegality` |
| 5 | `message_processor/ingest.rs:2076` (standalone proposal admission, pre-commit) | `validate_standalone_proposal_account_identity_proof` — rejects an unreadable Add/Update proposal before it sits in the durable pending set | `src/engine/admin-policy.ts:44-54` inline check inside `createAdminCommitPolicyCallback` already does something similar for Adds today (0xf2f1-based); swap to 0x8009. Consider whether Update proposals need the same treatment (MDK's standalone-proposal check covers both Add and Update; marmot-ts's admin-policy callback currently only checks Add) | Swap decode target; **audit Update-proposal coverage** |
| 6 | `openmls_projection.rs:3802` (stored-convergence/replay apply — the fork-resolution seam) | Same staged-commit check, replay path | `src/engine/fork-recovery.ts:125` (already calls `validateCommitLegality` per candidate edge) | Extend `validateCommitLegality` |
| 7 | `group_lifecycle.rs` `do_create_group` (lines ~257-260, ~309-311) | Requires `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` in `self_supported_components`/`mandatory_components` for Current-profile creation; rejects any member KeyPackage whose `protocol_profile` mismatches | `src/core/group.ts` `createGroup`/`createSimpleGroup` (creator-only today) plus the new founding-invitee path (§5) | New code path, not an extension of an existing one |
| 8 | `group_lifecycle.rs:966` `do_join_welcome` / `protocol_profile_of_group` | Classifies the joined group's profile and rejects a mismatch | `src/client/groups-manager.ts:724` (`verifyAllLeafAccountIdentityProofs` call, right after `joinGroup`) | Extend to also check GroupContext `app_components` requires 0x8009 |

**Because marmot-ts already has a single shared seam adapter (`validateCommitLegality`) that all four commit-producing
seams call, extending that one function closes rows 1-4 and 6 in one change** — this is a structural advantage over
MDK's per-call-site wiring (MDK doesn't have one function all six Rust call sites share; it relies on each call site
remembering to call the shared *validator function*, which is exactly the "guard that exists on one seam only is a
bug" risk its own AGENTS.md warns about). marmot-ts's existing `validateCommitLegality` architecture already
structurally prevents that risk class for this feature, provided the new check is added inside it and not
seam-locally.

## 4. Public API / export changes (`src/__tests__/exports.test.ts`)

The snapshot at `src/__tests__/exports.test.ts:290-321` currently asserts these proof-related names exist:
`signAccountIdentityProof`, `validateAdminLeafCoupling`, `validateAppComponentIntegrity`, `validateCommitLegality`,
`verifyAllLeafAccountIdentityProofs`, `verifyLeafAccountIdentityProof`, plus (grep-confirmed elsewhere in the same
export surface) `mlsSignatureScheme`, `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE`, `ACCOUNT_IDENTITY_PROOF_EVENT_KIND`,
`buildAccountIdentityProofExtension`, `buildAccountIdentityProofEvent`, `accountIdentityProofEventJson`,
`accountIdentityProofEventId`, `accountIdentityProofSigningDigest`, `encodeAccountIdentityProof`,
`decodeAccountIdentityProof`, `makeAccountIdentityProofExtension`, `accountIdentityProofSignatureFromSignedEvent`.

Expected changes to that snapshot:

- **Removed**: `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE`, the whole 0xf2f1 fixed-width codec pair
  (`encodeAccountIdentityProof`/`decodeAccountIdentityProof` in their current shape), `makeAccountIdentityProofExtension`
  (LeafNode-extension builder — superseded by a dictionary-entry builder)
- **Renamed/reshaped**: `verifyLeafAccountIdentityProof`/`verifyAllLeafAccountIdentityProofs` likely keep their names
  (same *purpose*) but change signature/internals to read the `0x8009` dictionary entry instead of the `0xf2f1`
  extension; `buildAccountIdentityProofExtension` becomes something like `buildAccountIdentityProofComponent` (returns
  `ComponentData`, not `CustomExtension`)
- **New**: exports for the shared `MarmotAuthorizationProof` envelope primitive (encode/decode/verify), a new
  `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` constant (0x8009), and — if multi-device/push proof classes are stubbed even
  as forward-looking types this milestone (they are not; explicitly out of scope) — no new proof-class exports beyond
  account identity
- **Unaffected**: `validateAdminLeafCoupling`, `validateAppComponentIntegrity`, `validateCommitLegality` keep their
  names (their *signatures* are unaffected; only their internal behavior/call graph gains the new check)

Any change to this list requires updating the inline snapshot at `exports.test.ts:290-321` in the same commit that
changes the export surface — the test will otherwise fail loudly, which is the intended tripwire.

## 5. Founding-create-via-Welcome: impact on `MarmotGroup`/`GroupRuntime`/lifecycle FSM

**Today's flow (confirmed by reading `src/client/group-factory.ts:120-165`, `src/core/group.ts:112-166`,
`src/client/group/proposals/invite-user.ts`, `src/client/session/group-session.ts:601-625`,
`src/client/runtime/group-runtime.ts:121-153`):**

1. `GroupFactory.create()` builds a **solo** group (creator-only leaf) via `createSimpleGroup` → `createGroup` → ts-mls
   `MLSCreateGroup`. This is already local-only — no MLS commit is published for solo creation (there is nothing to
   commit; epoch 0 has one leaf).
2. Adding the *first* real members happens **after** `create()` returns, through the ordinary invite flow:
   `proposeInviteUser` builds an Add proposal → `GroupSession.send({kind:"commit", ...})` stages it
   (`group-engine.ts:1291` legality gate) → lifecycle FSM `Stable → PendingPublish` → `GroupRuntime.publishCommit`
   publishes **both** the kind-445 commit envelope to group relays **and** the Welcome to each invitee
   (`group-runtime.ts:121-153`) → confirmation flips `PendingPublish → Stable` and applies state.

**What Current-profile founding-create-via-Welcome requires (per MDK's `do_create_group`,
`refs/mdk/.../group_lifecycle.rs:236-743`, and the milestone's explicit decision):**

When a Current-profile group is created *with* initial invitees in one step, the resulting epoch (0, or 1 if founding
Adds are included) must become canonical **without ever producing a group-event commit**. Only Welcomes are durable
send obligations (MDK: "`Sent` deliberately means durable outbound obligation, not transport delivery completed" —
each Welcome tracked/retried independently). This is a structural, not cosmetic, change to marmot-ts because:

- **`GroupFactory`/`create()` needs a members parameter.** Nothing in `SimpleGroupOptions`
  (`src/core/group.ts:112-116`) or `GroupFactoryOptions` (`src/client/group-factory.ts:28-56`) accepts initial
  invitee KeyPackages today. This is new surface, not a modification of an existing parameter.
- **The founding Add (if any) must be applied locally, bypassing the ordinary send/publish pipeline.** The natural
  place is a new core function (near `src/core/group.ts`, using ts-mls's Add-processing/Welcome-generation primitives
  directly — the same primitives `createCommit` already wraps in `group-engine.ts:961` — but returning
  `{ resultingState, welcome }` without ever calling `GroupRuntime.publishCommit`). This bypasses
  `GroupSession.send()` entirely for the founding path; `GroupSession`/`MarmotGroup` would seed directly from the
  already-canonical state (`MarmotGroup(clientState, ...)` in `group-factory.ts:146`), analogous to how `create()`
  already seeds a solo group.
- **`GroupRuntime`/`GroupPublishWork` needs a "welcome-only" case.** Every existing `GroupPublishWork` variant that
  carries a `welcome` (`"groupEvolution"`) also publishes an `envelope` to group relays
  (`group-runtime.ts:121-130,144-151`). A founding create has Welcomes but no group-relay envelope — this is a new
  variant/branch, not reachable by setting an existing field to `undefined`, because `#publishCommitResult`
  unconditionally treats `envelope` as required work.
- **Lifecycle FSM: founding create should skip `PendingPublish` entirely, not enter and immediately confirm it.**
  MDK's founding path never stages a pending commit (`Engine::do_create_group`'s Current-profile branch calls
  `epoch_manager.set_stable(...)` directly, `group_lifecycle.rs:718-719` — no `begin_pending`). The reason matters for
  fidelity: `PendingPublish` in marmot-ts's FSM (`src/core/group-lifecycle.ts`) exists to gate *outbound* work behind
  a single unconfirmed publish so a crash mid-publish can be retried/rolled back; a founding create's "publish
  obligations" are N independent Welcome sends with no shared rollback point (a crash after 2 of 3 Welcomes send
  must resume from Welcome 3, not roll back Welcomes 1-2), so the existing PendingPublish→confirm/rollback pair is
  the wrong shape for it. **This means founding create's persisted state should already read as `Stable`, and
  Welcome delivery becomes a separately-tracked durable queue** (mirroring MDK's per-Welcome `sent_message_ids`,
  independently retryable) — closer in shape to marmot-ts's existing `InviteManager`/welcome-delivery machinery
  (`src/client/transport/nostr/welcome-delivery.ts`) than to the commit-publish pipeline.
- **`MarmotGroup.save(true)`** (already called unconditionally after `create()`, `group-factory.ts:162`) needs no
  change in shape — it already persists a canonical, non-pending state; the founding-with-invitees path just needs to
  produce that same shape of already-resolved `ClientState` before `save()` runs.

**Net effect on the architecture diagram:** a new outbound path exists that goes `GroupFactory` → (new) core
founding-add helper → `MarmotGroup` (seeded Stable) → a Welcome-only delivery queue, entirely parallel to and
bypassing `GroupSession.send()` → lifecycle FSM `PendingPublish` → `GroupRuntime.publishCommit`. The two paths
converge again only at "Welcome delivered to invitee" (both use `transport/nostr/welcome-delivery.ts` today for
non-founding invites, and should reuse it for founding welcomes too, per the "reuse, don't reinvent" architecture
convention already in place for `src/client/`).

## 6. Data-flow changes, summarized

**Inbound (join / KeyPackage discovery):**
```
NIP-65 KeyPackage discovery → KeyPackage event → getKeyPackage() decode
  → LeafNode.app_data_dictionary contains 0x8009 entry (was: LeafNode.extensions contains 0xf2f1)
  → proposeInviteUser (src/client/group/proposals/invite-user.ts:22): verify 0x8009 proof against KeyPackage ciphersuite
  → Add proposal → commit → validateCommitLegality (src/core/components/integrity.ts, extended) checks:
      - resulting app_components (0x0001) list still contains 0x8009
      - every resulting member leaf carries a valid, bound 0x8009 proof
  → GroupsManager.join() / groups-manager.ts:724: verifyAllLeafAccountIdentityProofs (0x8009-based) + GroupContext
    requires-0x8009 check, before adoptClientState
```

**Outbound (self-update / leaf replacement):**
```
GroupSession.send({kind:"selfUpdate"}) → group-engine.ts self-update path builds replacement LeafNode
  → replacement leaf MUST carry a fresh 0x8009 proof (same credential identity, new signature key)
  → #assertStagedCommitLegal (group-engine.ts:1291, extended) rejects a self-update whose replacement leaf
    lacks/breaks the binding
```

**Outbound (founding create with invitees) — new path, see §5:**
```
GroupFactory.create(name, { members: KeyPackage[] }) [NEW parameter]
  → new core helper applies founding Add(s) locally (no commit publish)
  → MarmotGroup seeded directly Stable, save(true)
  → Welcome-only delivery queue (reusing transport/nostr/welcome-delivery.ts) — independently retryable per invitee
  [bypasses GroupSession.send() / lifecycle PendingPublish / GroupRuntime.publishCommit entirely]
```

**Convergence / fork recovery (tree-fed):**
```
fork-recovery.ts:125 candidate branch build → validateCommitLegality (extended) drops a candidate edge whose
  resulting state fails the 0x8009 group-context-requires-it or leaf-proof-valid check, same as any other
  commit-legality violation (D-04/D-09 disposition: drop the edge, don't throw)
```

## 7. Suggested build order (dependency-respecting)

This mirrors the milestone's own stated build-order hint ("primitive → proof class → seams → create flow → parity
fixtures") with file-level specificity:

1. **Shared envelope primitive** — new `src/core/authorization-proof.ts` (104-byte `MarmotAuthorizationProof`
   encode/decode/verify, `createdAt` range check). Zero dependents yet; pure and independently testable. Blocks
   everything else.
2. **0x8009 proof-class module** — new component-id registration (`src/core/components/ids.ts`), dictionary
   integration (`src/core/components/dictionary.ts`), and the proof-class logic (kind-450 event shape, exact tag
   order/content, ciphersuite/scheme hex encoding) built on (1). This is a like-for-like replacement of
   `src/core/account-identity-proof.ts`'s current content, so it can be developed as a parallel new file/module and
   swapped in, keeping the old file as a deletion target once callers migrate. Verify against the spec's own signing
   test vector (`account-identity-proof-v2.md` §"Signing test vector") before touching any call site — this is the
   cheapest possible correctness gate, byte-exact and independent of marmot-ts's own architecture.
3. **Capabilities cut** — remove `0xf2f1` from `src/core/capabilities.ts:58,101` (§1.1). This has no dependency on
   (2) beyond "the old constant is gone"; do it alongside (2) since it's the same file family and both are pure
   deletions/additions with no seam wiring yet.
4. **KeyPackage generation** — `src/core/key-package.ts` swaps its LeafNode-extension push for a dictionary-entry
   push via the extended `makeLeafAppComponentsExtension` (§1.1). Depends on (2). This is the first point at which a
   generated KeyPackage becomes byte-different, so it's also the first point cross-impl fixtures can start failing
   usefully.
5. **Seam wiring — the shared adapter first** — extend `validateCommitLegality`
   (`src/core/components/integrity.ts:275-336`) with the new 0x8009 check. Because ingest.ts, group-engine.ts, and
   fork-recovery.ts all call this one function, this single change propagates to rows 1,2,3,4,6 of the §3 seam table
   simultaneously — do this **before** touching any individual seam file, so there's no window where seams disagree.
   Depends on (2) for the verification logic and (4) for realistic fixtures to test against.
6. **Seam-local swaps that can't be centralized** — `src/engine/admin-policy.ts` (pre-admission Add check),
   `src/client/group/proposals/invite-user.ts` (pre-stage KeyPackage check), `src/client/groups-manager.ts:724`
   (post-join full-group check). These read the proof directly rather than going through the shared adapter, so each
   needs its own swap from `0xf2f1` extension lookup to `0x8009` dictionary lookup. Depends on (2).
7. **Self-update / replacement-leaf binding** — the new leaf-rebinding check reachable from
   `#assertStagedCommitLegal` (§1.2). Depends on (5) being in place as the chokepoint it plugs into.
8. **Group creation / GroupContext requirement** — `src/core/components/ids.ts` `DEFAULT_GROUP_COMPONENT_IDS` gains
   0x8009 (so every new group's required `app_components` list includes it); `src/core/group.ts` needs no further
   change beyond that constant update. Depends on (2).
9. **Founding-create-via-Welcome** — the new `GroupFactory` members parameter, the new core founding-add helper, the
   new `GroupRuntime`/`GroupPublishWork` welcome-only case, and the lifecycle-FSM decision documented in §5. This is
   the largest, most structurally novel piece (new data flow, not a swapped codec) and has the most dependencies —
   sequence it **last** among the functional changes, after (1)-(8) so the 0x8009 proof machinery it relies on
   (every founding leaf still needs a valid proof) is already correct and tested.
10. **Parity fixtures and exports snapshot** — re-point `src/__tests__/conformance/proof-v2-parity.test.ts` at the
    adopted spec vector, regenerate/extend `src/__tests__/fixtures/safe-aad-rust.json` and
    `src/core/__tests__/darkmatter-invite-compat.test.ts` against MDK `accda242`, and update the
    `src/__tests__/exports.test.ts` snapshot (§4). Do this last since it is the acceptance gate for everything above,
    not a dependency of it — but do NOT skip it; it is the only mechanical guarantee of byte-exact interop this
    milestone's core value depends on.

**Why this order and not "seams first":** every seam in §3 is a *consumer* of the proof-verification logic in (2); wiring
seams before the verification logic is stable would mean re-touching every seam file when (2) inevitably needs a
correction against the spec's test vector. Centralizing in `validateCommitLegality` (5) before touching individual
seam files (6) avoids the exact "guard exists on one seam only" bug class both MDK's AGENTS.md and marmot-ts's own
`validateCommitLegality` doc comment (`integrity.ts:264-266`, citing "the mdk#707 bug class") warn about. Founding-create
(9) is sequenced last because it is additive new capability, not a proof-shape swap, and its correctness depends on
(2)-(8) already being right — building it first would mean building on top of an untested proof primitive.

## 8. Sources

- `src/core/account-identity-proof.ts`, `src/core/capabilities.ts`, `src/core/key-package.ts`,
  `src/core/components/{ids,dictionary,integrity,app-components-list}.ts`, `src/core/group.ts`,
  `src/engine/{admin-policy,ingest,group-engine,fork-recovery}.ts`,
  `src/client/{group-factory,groups-manager,marmot-client,key-package-manager,key-package-publisher}.ts`,
  `src/client/group/proposals/invite-user.ts`, `src/client/session/group-session.ts`,
  `src/client/runtime/group-runtime.ts`, `src/__tests__/exports.test.ts` — all read directly, 2026-09-12,
  marmot-ts working tree (branch `master`, clean)
- `refs/mdk` (Rust reference) at `accda242`: `crates/cgka-engine/src/account_identity_proof.rs`,
  `crates/cgka-engine/src/app_components.rs` (lines 1-120, 800-830), `crates/cgka-engine/src/group_lifecycle.rs`
  (lines 230-330, 690-745), `crates/cgka-engine/src/self_update.rs` (full), `crates/cgka-engine/CLAUDE.md`
  ("Conventions in this crate", design deviations #2), `crates/traits/src/engine.rs` (`SendResult`,
  `CreateGroupRequest`), `crates/traits/src/group.rs` (`ProtocolProfile`)
- `refs/marmot` (spec) at `4a2bc65`: `app-components/account-identity-proof-v2.md` (full),
  `foundation/authorization-proofs.md` (full), `protocol-core/group-setup.md` (full)
- `.planning/PROJECT.md` (milestone scope/decisions), `.planning/codebase/ARCHITECTURE.md` and
  `.planning/codebase/INTEGRATIONS.md` (existing layered-architecture baseline, refreshed 2026-07-07)

Confidence note: this is HIGH-confidence internal-codebase analysis (every claim is a direct file read or grep, not
inference from external ecosystem sources), with one explicitly flagged design decision left open for the roadmap/plan
phase — the exact shape of the lifecycle-FSM treatment of founding-create (§5, "skip PendingPublish entirely" is the
recommendation, matching MDK, but is a decision for the phase plan to confirm, not something already decided in
PROJECT.md).

---
*Architecture research for: marmot-ts v2.0 Account identity proof v2*
*Researched: 2026-09-12*
