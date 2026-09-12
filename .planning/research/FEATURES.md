# Feature Landscape: Account identity proof v2 (component `0x8009`)

**Domain:** Marmot (MLS-over-Nostr) member-identity binding — cutover from custom LeafNode extension
`0xf2f1` to MLS app component `0x8009` (`marmot.member.account-identity-proof.v2`)
**Researched:** 2026-09-12

Every behavior below is cited to a spec file:section or an MDK `crates/cgka-engine` file:function. Line numbers are
as of `refs/marmot` (working tree) and `refs/mdk` at `accda242` (per `.planning/PROJECT.md` Context).

## How it works, exactly

### 1. Registry facts

| Fact | Value | Source |
|---|---|---|
| Component id | `0x8009` | `app-components/account-identity-proof-v2.md:13`, `foundation/registries.md:23` |
| Component name | `marmot.member.account-identity-proof.v2` | `account-identity-proof-v2.md:14` |
| Proof event kind | `450` (local signing template, never relayed) | `account-identity-proof-v2.md:15`; `foundation/registries.md:109` |
| Valid location | `app_data_dictionary` in an MLS **LeafNode**, including the LeafNode embedded in a KeyPackage | `account-identity-proof-v2.md:16-17` |
| Invalid locations | GroupContext, KeyPackage-level dictionary (i.e. `KeyPackage.extensions`, not `KeyPackage.leafNode.extensions`), GroupInfo, `AppEphemeral` proposal, SafeAAD item | `account-identity-proof-v2.md:20` |
| Signature algorithm | Nostr account-key BIP-340 Schnorr over a NIP-01 event id | `account-identity-proof-v2.md:18` |
| Legacy id (superseded, kept registered so the value is never reassigned) | `0xf2f1` = `marmot.account-identity-proof.v1` | `foundation/registries.md:61,81-82` |

Rust: `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID: AppComponentId = 0x8009` — `refs/mdk/crates/traits/src/app_components/mod.rs:106`.

### 2. Wire envelope — `MarmotAuthorizationProof` (104 bytes, fixed-width, no version field)

```
opaque signer_pubkey[32];   // raw x-only secp256k1, no length prefix
uint64 created_at;          // big-endian Unix seconds
opaque signature[64];       // BIP-340 Schnorr
```

- Total 104 bytes; truncation or trailing bytes reject (`foundation/authorization-proofs.md:27-29,94`).
- `created_at` MUST be in `[1, 2^53-1]` (`9007199254740991`) — zero is invalid, and the ceiling is chosen so the value
  round-trips through interoperable JSON number implementations (`authorization-proofs.md:34`). This is exactly
  `Number.MAX_SAFE_INTEGER`, so TypeScript can represent `created_at` as a plain `number`, not `bigint`, throughout —
  a real simplification versus the general 64-bit field. marmot-ts already has a big-endian `uint64` codec
  (`src/core/binary.ts:174` write / `:299` read, returns `bigint` on read) that is directly reusable; the new codec
  need only range-check into `number` after reading.
- The component id/carrier is the format's major version. There is deliberately no generic version byte inside the
  104 bytes (`authorization-proofs.md:31-33`; `app-components/CLAUDE.md`: "component id IS the major version").
- Rust mirror: `AccountIdentityProof`/`CURRENT_PROOF_LEN = 32 + 8 + 64` and `account_identity_proof_component` —
  `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs:49,256-285`. Byte layout is `signer_pubkey ‖
  created_at.to_be_bytes() ‖ signature` (`:275-278`), matching the struct order exactly.

### 3. Signing event reconstruction (exact, ordered, no extra tags)

```json
{
  "pubkey": lowercase-hex(signer_pubkey),
  "created_at": created_at,
  "kind": 450,
  "tags": [
    ["d", "marmot.account-identity-proof.v2"],
    ["component", "0x8009"],
    ["ciphersuite", "0x" + 4-lowercase-hex-digits],
    ["signature_scheme", "0x" + 4-lowercase-hex-digits],
    ["mls_signature_key", lowercase-hex(leaf.signature_key, no TLS length prefix)]
  ],
  "content": "Authorize this MLS leaf key for my Marmot account"
}
```

(`account-identity-proof-v2.md:41-71`.) Differences from the legacy `0xf2f1` event marmot-ts currently builds
(`src/core/account-identity-proof.ts:154-174`) — **every one of these is a breaking change, not a tweak**:

| Field | Legacy (`0xf2f1`, current code) | v2 (`0x8009`, required) |
|---|---|---|
| `created_at` | always `0` | producer's real local Unix time, `[1, 2^53-1]` |
| `content` | `""` | `"Authorize this MLS leaf key for my Marmot account"` (exact string) |
| tag 2 | `["extension", "0xf2f1"]` | `["component", "0x8009"]` |
| tag 3 | `["version", "2"]` | *(removed — no version tag in v2)* |
| `ciphersuite` tag value | decimal (`String(number)`) | `0x` + exactly 4 lowercase hex digits |
| `signature_scheme` tag value | decimal | `0x` + exactly 4 lowercase hex digits |
| tag count | 6 | 5 |

Rust mirror and its own byte-exact unit test: `AccountIdentityProofRequest::proof_event` `ProtocolProfile::Current`
arm — `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs:137-169`; test
`current_proof_event_is_the_exact_kind_450_spec_shape` (`:779-811`) pins the tag array verbatim.

`ciphersuite_hex`/`signature_scheme_hex` values are **the applicable ciphersuite** — the KeyPackage's ciphersuite when
validating a KeyPackage, the group's ciphersuite when validating a group member LeafNode (`account-identity-proof-v2.md:65-66`).
marmot-ts's existing `verifyLeafAccountIdentityProof(leaf, ciphersuite)` signature already threads a caller-supplied
ciphersuite id per call site (`invite-user.ts:22` passes the *group's* ciphersuite; `groups-manager.ts:724` likewise) —
this shape carries over unchanged to the v2 validator. `mlsSignatureScheme(ciphersuite)` (`account-identity-proof.ts:87-94`)
is a reusable lookup table (RFC 9420 signature-scheme code point per ciphersuite) and is profile-independent —
keep it, only the hex-vs-decimal tag rendering changes.

The event id is the SHA-256 of the NIP-01 canonical array `[0, signer_pubkey_hex, created_at, kind, tags, content]`
(`authorization-proofs.md:56-64`), computed by `applesauce-core`'s `getEventHash` exactly as the legacy code already
does (`account-identity-proof.ts:191-195` — same helper, new event shape).

### 4. Byte-exact test vector (spec + MDK agree)

`account-identity-proof-v2.md:130-159` fixture, using BIP-340 secret key `3`:

```
signer_pubkey     = f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9
created_at        = 1700000000
ciphersuite       = 0x0001
signature_scheme  = 0x0807
mls_signature_key = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
event_id          = b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b
signature         = c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d
component (104 B) = f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000006553f100c5315d3c85b9d4907cb03395a2a97b3ba2eab393f8e45b13a5d5233acedac60a51d2a295e1b1b5ee372d18a49bdb8041a7dba9dedce722c7c6f712f78bbdfb5d
```

MDK re-derives and asserts the identical event id and component bytes in
`refs/mdk/crates/cgka-engine/src/account_identity_proof.rs::current_proof_matches_the_adopted_signing_vector` (lines
828-869), using `Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` / `SignatureScheme::ED25519` (ciphersuite
id `1`, scheme `0x0807` — matches). **This is byte-exact cross-checked between the spec doc and the Rust reference
today** — a strong, ready-to-port fixture. The existing marmot-ts fixture file shape to follow is
`src/__tests__/fixtures/proof-v2-rust.json` (used by the now-superseded `0xf2f1` test); a new
`account-identity-proof-v2-rust.json` (or similar) should carry the six hex fields above plus `mdk_sha` and `profile:
"current-0x8009"` for provenance, matching that file's existing schema.

There is **no dedicated MDK conformance byte-fixture yet** for `0x8009` under
`refs/mdk/crates/cgka-conformance-simulator/vectors/byte-fixtures/` (checked; only `nostr-routing-v1-*` and
`schema.v1.json` exist there today) — the Rust `#[test]` above is the only existing byte-exact source, not a
`conformance_version`-pinned fixture file. Treat the spec vector text itself as the primary portable fixture.

### 5. Validation algorithm (every rejection case, enumerated)

Per `account-identity-proof-v2.md:115-128` ("Validation"), applied at KeyPackage receipt, proposed-LeafNode
admission, resulting-group-state check, and every received member leaf:

| # | Rejection case | Spec cite | MDK enforcement |
|---|---|---|---|
| 1 | Common envelope: not exactly one valid 104-byte `MarmotAuthorizationProof` (truncated/trailing bytes) | `authorization-proofs.md:94`; `account-identity-proof-v2.md:120` | `validate_current_proof` length check, `account_identity_proof.rs:382-386` |
| 2 | `signer_pubkey` not a valid x-only secp256k1 public key | `authorization-proofs.md:95`; `account-identity-proof-v2.md:122` | `crate::identity::validate_credential_identity` called from `validate_leaf_account_identity_proof`, `account_identity_proof.rs:325` |
| 3 | `created_at == 0` or `> 2^53-1` | `authorization-proofs.md:96` | `validate_current_timestamp`, `account_identity_proof.rs:457-467` |
| 4 | Component id `0x8009` absent from the LeafNode's `app_components` support list | `account-identity-proof-v2.md:117` | explicit check in `validate_leaf_account_identity_proof`, `:352-358` |
| 5 | LeafNode has no `0x8009` dictionary entry, or more than one | `account-identity-proof-v2.md:118` | `(legacy, current)` match on `Option`, `:338-346` — MDK relies on the dictionary's own at-most-one-per-id invariant for "more than one"; **ts-mls already enforces this structurally** at decode (`ts-mls/src/appDataDictionary.ts:63` throws `UsageError` on unsorted/duplicate ids), so marmot-ts gets rule 5's "more than one" half for free and only needs to check "at least one" |
| 6 | Component appears at an invalid location (GroupContext, KeyPackage-level dict, GroupInfo, `AppEphemeral`, SafeAAD) | `account-identity-proof-v2.md:119` | Partially enforced: MDK's `protocol_profile_of_group_extensions` explicitly rejects `0x8009` GroupContext state (`app_components.rs:485-494`, `CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS` checks at `app_components.rs:1079-1085,1105-1107`). MDK does **not** appear to separately probe GroupInfo/AppEphemeral/SafeAAD for a stray `0x8009` entry — those shapes don't naturally carry a LeafNode-typed dictionary today. **Concrete real risk for marmot-ts**: ts-mls's `KeyPackage` type has its own top-level `extensions: CustomExtension[]` *distinct* from `keyPackage.leafNode.extensions` (`ts-mls/src/keyPackage.ts:35`) — a malformed/adversarial KeyPackage could carry an `app_data_dictionary` with a `0x8009` entry at the KeyPackage level instead of the LeafNode level. A validator that reads "the dictionary" without pinning it to `keyPackage.leafNode.extensions` specifically could be tricked. This is a genuine marmot-ts-specific hardening item beyond a line-for-line MDK port. |
| 7 | Component data is not exactly one valid `MarmotAuthorizationProof` (decode failure) | `account-identity-proof-v2.md:120` | same as #1, reused |
| 8 | `proof.signer_pubkey != BasicCredential.identity` (exactly, 32 bytes) | `account-identity-proof-v2.md:121` | `validate_proof_bindings`, `account_identity_proof.rs:414-418` |
| 9 | Credential identity not a valid x-only secp256k1 public key | `account-identity-proof-v2.md:122` | same as #2 |
| 10 | Ciphersuite or signature scheme used to reconstruct the event doesn't match the validated MLS context | `account-identity-proof-v2.md:123` | `validate_proof_bindings`, `:424-433` |
| 11 | Signed MLS signature key ≠ the signature key in that LeafNode | `account-identity-proof-v2.md:124` | `validate_proof_bindings`, `:419-423` |
| 12 | Event id or BIP-340 signature doesn't verify under `signer_pubkey` | `account-identity-proof-v2.md:125` | `verify_proof_signature`, `:437-455` |
| 13 (group-level) | GroupContext doesn't require `0x8009`, OR a current member doesn't advertise support, OR a current member lacks valid component data | `account-identity-proof-v2.md:127-128` | `validate_current_profile_group_context` (`app_components.rs:1021-1121`, `CURRENT_PROFILE_REQUIRED_APP_COMPONENTS` at `:42-45`) + `validate_resulting_leaf_capabilities` (`:1252-1289`) |

marmot-ts already has direct reusable primitives for #2/#9 (`isValidAccountIdentity`, `src/core/credential.ts:16-26`,
already lifts the x-only point via `secp256k1.Point.fromHex`) and for the dictionary read pattern (`getComponentData`,
`getAppDataDictionary` helpers in `src/core/components/dictionary.ts:86-92`). Rejection case 6's KeyPackage-vs-LeafNode
distinction is new and must be an explicit, tested rule (read `keyPackage.leafNode.extensions`, never
`keyPackage.extensions`, when validating a KeyPackage's proof).

### 6. GroupContext requirement mechanics — **not** `required_capabilities`

This is a load-bearing distinction the current legacy code gets wrong for the new profile, and it must not be copied
forward:

- `0x8009` is required via the **`app_components` list entry inside the GroupContext's `app_data_dictionary`**
  (component id `0x0001`, `APP_COMPONENTS_COMPONENT_ID`), not via `required_capabilities.extension_types`.
  MDK's `CURRENT_PROFILE_REQUIRED_GROUP_CONTEXT_EXTENSIONS = [0x0006]` (`app_components.rs:40`) lists only
  `app_data_dictionary` (`0x0006`) as a `required_capabilities` extension; `CURRENT_PROFILE_REQUIRED_APP_COMPONENTS =
  [GROUP_ADMIN_POLICY_COMPONENT_ID, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]` (`:42-45`) is checked against the
  **dictionary's own `app_components` requirement entry**, a completely separate mechanism
  (`required_app_components_of_extensions`, `:1124-1143`).
- Today's marmot-ts (`src/core/capabilities.ts:58-59,101`) pushes `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE` (`0xf2f1`)
  directly into the MLS `required_capabilities.extensionTypes` list — this was only ever correct because `0xf2f1` is a
  raw custom MLS *extension*, not an app component. For `0x8009` this pattern must **not** be repeated: it must be
  removed from `ensureMarmotCapabilities`/`marmotRequiredCapabilitiesExtension` entirely (clean cut) and never re-added
  there; instead `0x8009` joins the same `requiredIds` list that `createGroup` already builds for
  `DEFAULT_GROUP_COMPONENT_IDS` (`src/core/group.ts:69-83`, via `appComponentsEntry(requiredIds)`).
- Confirmed by spec text directly: *"Every Marmot GroupContext MUST require component id `0x8009` in its
  `app_components` required-component list"* (`protocol-core/group-setup.md:32-33`) and *"Every resulting epoch MUST
  require component ids `0x8009` and `0x8003`"* (`group-setup.md:42-44`) — both describe the `app_components` list, the
  same mechanism already used for `0x8003` (admin-policy) today.
- `0x8009`'s data is explicitly barred from GroupContext state even though it's in the *required* list — it's a
  leaf-only requirement (`account-identity-proof-v2.md:20`; MDK's `CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS` at
  `app_components.rs:48-49`, skipped in the "required entry has GroupContext state" loop at `:1079-1085`, and in the
  commit-integrity "protected id must survive" loop, which explicitly `continue`s past
  `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` — `:743-745`). marmot-ts's existing WIRE-03 integrity validator
  (`src/core/components/integrity.ts::validateAppComponentIntegrity`) will need the identical carve-out when `0x8009`
  is added to `requiredIds`, or it will incorrectly demand GroupContext dictionary *state* for an id that must never
  carry any.
- `app_data_update` (`0x0008`) as a required proposal, and `app_data_dictionary` (`0x0006`) as a required extension,
  are **already correct** in `marmotRequiredCapabilitiesExtension()` (`src/core/capabilities.ts:98-117`) and need no
  change for this milestone.

### 7. Negotiation and presence (leaf side)

Every Marmot KeyPackage/LeafNode MUST: (a) advertise `0x8009` in `app_components` support list, and (b) carry exactly
one `0x8009` entry in `app_data_dictionary` (`account-identity-proof-v2.md:88-91`). MDK builds both together in one
call, `leaf_app_components_extension(supported, account_identity_proof)` (`app_components.rs:60-84`) — the support-list
entry always includes the proof id when `account_identity_proof.is_some()` (`:67-69`), and the same call inserts the
raw 104 bytes as the dictionary entry (`:78-80`).

**This is a structural change to marmot-ts's KeyPackage generation, not just a codec swap.** Today,
`generateKeyPackage` (`src/core/key-package.ts:122-150`) builds the leaf's `app_data_dictionary` two ways that must
converge into one:
- `makeLeafAppComponentsExtension()` (`src/core/components/dictionary.ts:141-149`) builds a dictionary with only
  `app_components` + `safe_aad` entries — this is the "supported ids" advertisement, and needs a third entry
  (`0x8009` → 104 bytes) added, and `0x8009` added to the advertised id list.
- The proof itself is currently pushed as a **separate, second, raw `CustomExtension`** onto `leafNodeExtensions`
  (`key-package.ts:131-140`) — i.e. today there are *two* LeafNode extensions (`app_data_dictionary` and
  `0xf2f1`). For v2 there must be exactly **one** `app_data_dictionary` extension containing the proof as one of its
  entries; the two code paths need to merge into a single `buildAppDataDictionary([...supported ids entry, safeAad
  entry, componentEntry(0x8009, encodedProof)])` call. `makeLeafAppComponentsExtension` (or a v2 equivalent) needs a
  new optional parameter carrying the encoded 104-byte proof, mirroring MDK's `account_identity_proof: Option<&[u8]>`
  parameter shape.
- `SUPPORTED_APP_COMPONENT_IDS` (`src/core/components/ids.ts:70-79`) does not list `0x8009` and must gain it (it is
  a leaf/KeyPackage support-list id, unlike the GroupContext-only ids already there).

### 8. Self-update binding, identity equality, and non-removability

- **Non-removability**: `0x8009` and its data MUST NOT be removed from a non-blank member leaf; the data disappears
  only when the whole leaf is removed from the tree (`account-identity-proof-v2.md:110-111`). Also: "A component MUST
  NOT be removed while it is listed as required in the GroupContext `app_components` component"
  (`app-components/README.md` Common Rules) — and `0x8009` is a lifetime-wide required id
  (`group-setup.md:42-44`: "The account-proof and admin-policy requirements are lifetime invariants, not creation
  defaults... A Commit that violates any of those invariants, including a Commit that changes `app_components`, is
  invalid").
- **Replacement-leaf identity equality**: "An existing member may replace this component only as part of an
  MLS-authenticated replacement of its own LeafNode. The replacement leaf's `BasicCredential.identity` MUST equal the
  member's prior account identity. It MUST contain a valid proof for the replacement leaf signature key and other
  signed inputs. A change of account identity is not a self-update" (`account-identity-proof-v2.md:105-108`).
- **MDK's actual self-update commit does not exercise this rule today.** `refs/mdk/crates/cgka-engine/src/self_update.rs`
  builds the commit via `commit_builder().force_self_update(true)` (`:146-158`) — this is OpenMLS's own-leaf path
  update, which rotates HPKE (encryption) key material but leaves the leaf's `credential` and `signature_key`
  (therefore the existing `0x8009` proof, which is bound to that exact signature key) untouched. The staged commit is
  then re-validated through the **same shared validators** every commit uses —
  `validate_staged_commit_account_identity_proofs` (`self_update.rs:165-170`, calling
  `account_identity_proof.rs:552-606`, whose `update_path_leaf_node` arm re-derives and re-checks the proof against
  the committer's identity — `:595-603`) and
  `validate_current_profile_invariants_for_staged_commit` (`self_update.rs:171-175`). So MDK's self-update
  "binding" is enforced *incidentally*, by re-running the general staged-commit validator against an unchanged leaf —
  there is no dedicated "identity-replacement" code path in the engine today that mints a fresh proof for a rotated
  signature key. marmot-ts's own `selfUpdate()` (`src/engine/group-engine.ts:1006-1097`) is architecturally the same
  shape: it calls ts-mls's `createCommit` for the sender's own update path without supplying new leaf
  extensions/credential, so the existing `0x8009` proof passes through unchanged and remains valid (same signature
  key). **The milestone's obligation here is therefore validation-side, not proof-re-signing**: the shared staged-commit
  validator (wherever marmot-ts's `validateCommitLegality`/WIRE-03 seam ends up living for 0x8009) must check, for
  every commit whose staged result rewrites the committer's or an updated member's own leaf: (a) the resulting leaf
  still carries a valid `0x8009` proof, (b) the resulting `BasicCredential.identity` equals the leaf's identity before
  the commit, and (c) the resulting proof binds *that same* resulting leaf's signature key (not a stale one) — i.e. a
  self-update/Update proposal that swaps in a NEW signature key without a correspondingly re-signed proof must be
  rejected. There is no engine-level "rotate my leaf key + get a new proof" convenience function to port from MDK;
  if marmot-ts wants to expose one it is new design, not a port.
- Every seam already runs the same staged-commit proof re-check for Add and Update proposals plus the committer's
  own update-path leaf: `validate_staged_commit_account_identity_proofs`
  (`account_identity_proof.rs:552-606`) iterates `staged.add_proposals()`, `staged.update_proposals()` (checking the
  new leaf's identity equals the *existing* member's via `member_id_of_sender`, `:579-593`), and
  `staged.update_path_leaf_node()` (checking against the *committer's* existing identity, `:595-603`). This triple
  coverage (Add / standalone or in-commit Update / committer's own path) is the shape marmot-ts's
  `validateCommitLegality` (currently in `src/core/components/integrity.ts` plus the admin-policy leaf/proof checks in
  `src/engine/admin-policy.ts`) needs to grow for `0x8009`, replacing the current single "does every current member
  leaf have a proof" sweep (`verifyAllLeafAccountIdentityProofs`) with a proposal-level check that also validates
  identity-equality against the *prior* leaf for Updates.
- **Standalone-proposal seam** (before a commit exists): MDK separately re-validates a queued Add/Update proposal at
  admission time (`validate_standalone_proposal_account_identity_proof`, `account_identity_proof.rs:615-650`) — "a
  syntactically valid MLS proposal must not sit pending until a later Commit discovers its leaf proof or profile is
  invalid" (rustdoc at `:608-614`). marmot-ts's `invite-user.ts` already does the equivalent at proposal-construction
  time (`verifyLeafAccountIdentityProof` at line 22) — same shape, needs only the v2 codec swapped in, plus (new) the
  identity-equality-on-Update check for any place marmot-ts admits standalone Update proposals into its pending set.

### 9. Founding group creation — Welcome-only, no founding commit publication

- Spec: *"Founding group creation is the exception... A one-member creation has an empty creation publish obligation
  and ends at epoch 0. For founding creation with initial invitees, the creator first creates the one-member epoch-0
  group, then creates and locally merges one founding Add Commit from epoch 0 to epoch 1 containing the initial
  invitees. That Add Commit has no group-message publication obligation because no pre-existing peer needs it. The
  creator then attempts the independent per-invitee epoch-1 Welcome deliveries"* (`protocol-core/joining.md:21-27`).
- MDK's `do_create_group` (`refs/mdk/crates/cgka-engine/src/group_lifecycle.rs:236-...`) implements exactly this for
  `ProtocolProfile::Current`: it builds and stages the founding Add (`:482-514`, calling the SAME
  `validate_staged_commit_account_identity_proofs` and `validate_current_profile_invariants_for_staged_commit` used
  by every other commit seam), then, for Current profile only, atomically **merges the Add locally** and persists
  every Welcome as an independent durable outbound obligation inside one storage transaction (`:597-684`) — no
  `PendingStateRef`, no `confirm_published` call is ever produced for this Add. It explicitly documents *why* the
  commit itself is never emitted: *"The creator is the only party who'd care about the 'commit that creates the group
  at epoch 1'... every other member lands in the group via `welcomes`... Dropping the commit avoids a welcome-before-commit
  `AlreadyAtEpoch` bounce"* (`:562-569`).
- The result type is a dedicated `SendResult::FoundingGroupCreated { welcomes: Vec<TransportMessage> }`
  (`refs/mdk/crates/traits/src/engine.rs:307-309`) — deliberately distinct from ordinary `GroupEvolution { msg,
  welcomes, pending }` (`:290-294`) and even from the *temporary* legacy-profile `GroupCreated { welcomes, pending }`
  (`:298-302`, which still stages/confirms a founding commit). Design-deviation note #2 in
  `refs/mdk/crates/cgka-engine/CLAUDE.md`: *"Founding creation never invents a group-message publication... Neither
  variant carries a `msg: TransportMessage`, because every initial invitee arrives through a Welcome containing the
  post-Add state."*
- **marmot-ts gap**: `createGroup`/`createSimpleGroup` (`src/core/group.ts:52-183`) only ever construct the solo
  epoch-0 group via `MLSCreateGroup` — there is no member-add step in `core/group.ts` at all. Initial invitees today
  must be added through the ordinary invite flow (`proposeInviteUser` → the engine's normal `commit`/`groupEvolution`
  send path, which stages a `PendingStateRef` and publishes a kind-445 **group message** that a real MDK-shaped peer
  would never expect for a founding creation with no prior peers). This milestone's "Current-profile founding group
  creation via Welcome only" target requires a **new creation-time code path** in the client/engine layer (not core)
  that: (1) creates the epoch-0 group, (2) if there are initial invitees, stages+validates+merges the founding Add
  **locally without publishing a group message**, (3) wraps and returns/records only the per-invitee Welcomes as
  durable outbound work, mirroring `SendResult::FoundingGroupCreated`. This is new engine-shaped work, not a small
  tweak to `core/group.ts`. It should reuse the existing `GroupRuntime`/`MarmotGroup` publish-lifecycle machinery for
  Welcome delivery (already used for every other invite), but must NOT route the founding Add through the
  `commit`/`groupEvolution` staged-publish path that produces a group-message publish obligation.
- One-member (solo) creation needs no change: it already "ends at epoch 0" with nothing to publish, matching spec.

### 10. External signer returned-event validation

Unchanged in shape from the legacy code, just against the new event/tag set: *"An external signer may return a
complete signed Nostr event. Before extracting the common envelope, the producer MUST verify that the returned
`pubkey`, `created_at`, `kind`, `tags`, and `content` exactly equal the requested values, that the returned event id
equals the NIP-01 event id recomputed from those values, and that the signature verifies... MUST NOT accept an
external signer's substitutions, additional tags, alternate content, or stale response"*
(`authorization-proofs.md:84-88`). marmot-ts's existing `accountIdentityProofSignatureFromSignedEvent`
(`account-identity-proof.ts:221-240`) already implements pubkey/id/signature re-verification against a rebuilt
canonical event — this function's *shape* survives the cutover unchanged; only the event it rebuilds
(`buildAccountIdentityProofEvent`) changes to the v2 fields. Note the spec text additionally calls out `tags` and
`content` equality explicitly as separate checks — worth confirming the ported version checks the full rebuilt event
(it does, transitively, since it recomputes the id from the full canonical array) rather than only checking
`pubkey`/`id`/signature as the current implementation's comments emphasize.

## Categorization

### Table stakes

Required for marmot-ts to interoperate with any MDK-default (Current-profile) group at all; missing any of these means
marmot-ts cannot join or create a joinable group.

| Feature | Why required | Complexity | Depends on |
|---|---|---|---|
| `MarmotAuthorizationProof` 104-byte codec (encode/decode, range-checked `created_at`) | Wire shape every other behavior sits on | Low | `src/core/binary.ts` `uint64` (reuse as-is) |
| Kind-450 v2 event builder (`component`/hex ciphersuite+scheme tags, real `created_at`, fixed content) | Byte-exact signing input; wrong tags/content = wrong event id = signature never verifies against a real MDK peer | Low | `applesauce-core` `getEventHash` (reuse); replaces `buildAccountIdentityProofEvent` in `account-identity-proof.ts` |
| Full validation algorithm (13 rejection cases, §5 above) | Spec-mandated MUST-reject list; a missing case is a real acceptance of an invalid/forged binding | Medium | `isValidAccountIdentity` (`credential.ts`, reuse); dictionary helpers (`components/dictionary.ts`, reuse) |
| Leaf/KeyPackage negotiation: `0x8009` in support list AND exactly one dictionary entry, merged into the single `app_data_dictionary` extension | Spec-mandated presence rule; today's code emits it as a second, separate raw extension | Medium | `makeLeafAppComponentsExtension` (`components/dictionary.ts`) needs a new proof parameter; `key-package.ts` generation flow restructure |
| GroupContext requirement via `app_components` list (not `required_capabilities`) | Spec-mandated group-level invariant; wrong mechanism silently produces a group MDK rejects | Low–Medium | `src/core/group.ts` `createGroup`'s existing `requiredIds` pattern (reuse the same list `0x8003` already uses); `src/core/capabilities.ts` (remove, don't replace, the `0xf2f1`-in-`required_capabilities` line) |
| Commit-integrity carve-out: `0x8009` required but leaf-only (never GroupContext state) | Without the carve-out, WIRE-03's "protected required id must have GroupContext state" rule wrongly demands state for a leaf-only id | Low | `src/core/components/integrity.ts` `validateAppComponentIntegrity` (extend the existing required-ids protection loop) |
| Self-update/Update-proposal identity-equality + fresh-proof-on-rotation check | Spec-mandated; prevents a member silently swapping account identity via "self-update" | Medium | `validateCommitLegality` / `src/engine/admin-policy.ts` seam extension; no MDK engine-level proof-reissue code to port, validation-only |
| Non-removability of `0x8009` from a live leaf | Spec-mandated MUST; a commit that strips it while keeping the leaf must be rejected | Low–Medium | Same integrity/commit-legality seam as above |
| Clean removal of `0xf2f1` from publish, verify, capabilities, admin policy (no fallback, no dual-profile) | Explicit user decision; spec forbids a v1/v2 fallback (`account-identity-proof-v2.md:166-174`) | Medium (touches ~6 files) | `account-identity-proof.ts`, `capabilities.ts`, `key-package.ts`, `groups-manager.ts`, `invite-user.ts`, `admin-policy.ts` |
| Founding group creation via Welcome only (no founding commit publication) | Spec-mandated exception to publish-before-apply; MDK peers never expect a group message from a brand-new epoch-0→1 creation | High | New engine/client-layer code path; cannot reuse the existing `commit`/`groupEvolution` staged-publish flow as-is |

### Differentiators

Not required for minimum MDK interop, but either explicitly spec-mandated hardening MDK's own engine doesn't visibly
exercise, or forward-looking architecture this milestone's own decisions call for.

| Feature | Value | Complexity | Notes |
|---|---|---|---|
| Explicit "invalid location" rejection: KeyPackage-level dictionary vs LeafNode dictionary distinction | Closes a real ts-mls-specific smuggling vector (`KeyPackage.extensions` is a distinct field from `KeyPackage.leafNode.extensions`) that MDK's Rust model doesn't have to think about the same way | Low | Read-path discipline only: always read `keyPackage.leafNode.extensions`, add a regression test with a proof planted at the wrong location |
| Explicit "invalid location" rejection for GroupInfo/AppEphemeral/SafeAAD | Spec literally lists these as MUST-reject; not exercised in MDK's current test suite (no such fixture found) | Low | Mostly documentation/defense-in-depth; these shapes don't naturally carry a `0x8009`-typed entry in ts-mls today, so this is largely "don't accidentally read that field", not new decode logic |
| `MarmotAuthorizationProof` as a shared `src/core` primitive (not proof-class-specific code) | Explicit project decision (`.planning/PROJECT.md` Key Decisions: "Multi-device join authorization and push owner proofs reuse the same 104-byte envelope") — pays off in the *next* milestones (MDEV-01, PUSH-01), not this one | Low now / pays off later | Purely an internal factoring choice; account-identity-proof-v2 is simply "proof class #1" over the shared envelope + validation-algorithm shape from `authorization-proofs.md` |
| Explicit standalone-proposal-admission re-check (mirroring MDK's `validate_standalone_proposal_account_identity_proof`) for every place marmot-ts admits a pending Update, not just Add | Prevents an invalid proof or identity mismatch from sitting in the pending set until a later commit discovers it | Medium | `invite-user.ts` already does this for Add; Update-side coverage needs to be added deliberately, it's easy to fix Add and skip Update |

### Anti-features

Explicitly out of scope or explicitly forbidden by the spec — do not build these.

| Anti-feature | Why avoid | What to do instead |
|---|---|---|
| Legacy `0xf2f1` fallback / dual-profile acceptance | Spec: *"There is no mixed v1/v2 fallback... MUST NOT be accepted as a substitute for component id `0x8009`"* (`account-identity-proof-v2.md:166-171`); user decision: clean cut | Reject any KeyPackage/leaf/group using `0xf2f1` outright, with no legacy code path left in `src/` |
| Receiver-side `created_at` freshness/expiry (past-age or future-skew rejection) | Spec: *"A proof remains valid without a receiver-side age limit"* (`account-identity-proof-v2.md:79`); *"Protocol validity MUST NOT depend on comparing `created_at` with a receiver's local wall clock unless the owning proof class explicitly defines a bounded-time rule"* (`authorization-proofs.md:104-107`) — this class defines no such rule | Only range-validate `[1, 2^53-1]`; never compare against local time |
| Generic version field inside the 104-byte envelope | Spec: *"The envelope therefore has no generic version field"* (`authorization-proofs.md:31-33`); component id IS the version | Keep the codec fixed-width with no version byte (unlike the legacy `0xf2f1` encoding, which had one) |
| Treating an account-identity change as a self-update | Spec: *"A change of account identity is not a self-update; it requires removing the old membership and separately authorizing a new membership"* (`account-identity-proof-v2.md:107-108`) | Reject a self-update/Update proposal whose resulting `BasicCredential.identity` differs from the existing member's; that must go through remove+re-invite instead |
| Reusing one proof across a changed signature key, ciphersuite, scheme, or account identity | Spec: *"a new MLS signature public key, ciphersuite, signature scheme, or account identity requires a new proof"* (`account-identity-proof-v2.md:82-84`) | Always mint a fresh proof whenever any signed input changes; never carry an old 104-byte blob forward across such a change |
| KeyPackage rotation/refresh to retire legacy KeyPackages | Explicitly out of scope this milestone (`.planning/PROJECT.md` Out of Scope) | Apps republish; not library work here |
| Publishing a founding-creation group message/commit for MDK-parity "safety" | Spec explicitly forbids it as unnecessary (`joining.md:24-27`); MDK explicitly avoids it (`group_lifecycle.rs:562-569`) | Founding Add is local-merge-only; only Welcomes are transport work |

## Feature dependencies

```
MarmotAuthorizationProof codec (envelope + range check)
  → Kind-450 v2 event builder
    → Signing (raw-secret and external-signer paths)
    → Validation algorithm (13 rejection cases)
      → Leaf/KeyPackage negotiation (support list + dictionary entry)
        → KeyPackage generation rewrite (merge into single app_data_dictionary)
      → GroupContext requirement (app_components list mechanism)
        → createGroup requiredIds wiring
        → Commit-integrity leaf-only carve-out
      → Self-update / Update-proposal identity-equality + non-removability checks
        → validateCommitLegality / admin-policy seam extension
  → Founding group creation via Welcome only   (depends on: negotiation + GroupContext requirement + validation,
                                                 since the founding Add must itself pass every current-profile check
                                                 before it is locally merged)
Clean removal of 0xf2f1 (can proceed in parallel with the above; touches the same files being rewritten anyway)
```

## MVP recommendation (this milestone)

The milestone has no smaller-than-this slice — it is a clean cutover, and MDK's default groups are unjoinable until
every table-stakes item lands together (a group either has a valid `0x8009` on every current leaf and requires it in
`app_components`, or it doesn't; there's no partial-interop state). Suggested build order, following the dependency
chain above and matching where MDK's own commit-legality seam gets exercised earliest:

1. Shared envelope + v2 event builder + validation algorithm (pure `src/core`, no I/O, easiest to byte-exact test
   against the spec vector immediately).
2. KeyPackage/leaf negotiation rewrite (`key-package.ts`, `components/dictionary.ts`, `components/ids.ts`) — needed
   before anything can produce a v2-shaped leaf to test the rest against.
3. GroupContext requirement + commit-integrity carve-out (`core/group.ts`, `core/capabilities.ts`,
   `components/integrity.ts`) — needed before any group state can legally require `0x8009`.
4. Self-update / Update-proposal identity binding + non-removability (`admin-policy.ts`, `validateCommitLegality`
   seam) — needs (1)-(3) in place to have something real to validate against.
5. Clean-cut removal of `0xf2f1` everywhere (can be threaded through steps 1-4 file-by-file rather than as a separate
   pass, since every touched file already needs rewriting).
6. Founding group creation via Welcome only — highest complexity, most architecturally novel, correctly last since it
   depends on everything above already being correct (the founding Add itself must pass full current-profile
   validation before the local-merge-only path is safe to build).

Defer nothing further within this milestone — KeyPackage rotation, multi-device, and push are already out of scope
per `.planning/PROJECT.md`.

## Sources

- `refs/marmot/app-components/account-identity-proof-v2.md` (adopted, primary source for component behavior + test
  vector)
- `refs/marmot/foundation/authorization-proofs.md` (adopted, shared envelope + validation algorithm)
- `refs/marmot/protocol-core/group-setup.md` (adopted, GroupContext requirement + lifetime invariants)
- `refs/marmot/protocol-core/joining.md` (adopted, founding-creation exception + Welcome receiving flow)
- `refs/marmot/foundation/registries.md` (component/kind registry entries)
- `refs/marmot/app-components/README.md` (app-component placement, negotiation, common rules)
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs` (Current-profile construction, validation, byte-exact
  test vector)
- `refs/mdk/crates/cgka-engine/src/app_components.rs` (GroupContext requirement mechanics, leaf-only carve-out,
  commit-integrity protection loop)
- `refs/mdk/crates/cgka-engine/src/self_update.rs` (self-update commit shape and its shared-validator re-check)
- `refs/mdk/crates/cgka-engine/src/group_lifecycle.rs` (founding-creation Current-profile path, `do_create_group`)
- `refs/mdk/crates/traits/src/engine.rs` (`SendResult::FoundingGroupCreated` vs `GroupEvolution`/`GroupCreated`)
- `refs/mdk/crates/cgka-engine/CLAUDE.md` (design-deviation note on founding creation never publishing a group
  message)
- `refs/mdk/crates/traits/src/app_components/mod.rs` (`ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` constant)
- marmot-ts source read for dependency mapping: `src/core/account-identity-proof.ts`, `src/core/capabilities.ts`,
  `src/core/key-package.ts`, `src/core/group.ts`, `src/core/credential.ts`, `src/core/binary.ts`,
  `src/core/components/{dictionary,ids,app-components-list,integrity}.ts`, `src/client/groups-manager.ts`,
  `src/client/group/proposals/invite-user.ts`, `src/engine/admin-policy.ts`, `src/engine/group-engine.ts`,
  `ts-mls/src/{keyPackage,appDataDictionary}.ts`
- `src/__tests__/fixtures/proof-v2-rust.json` (existing fixture shape to follow for the new `0x8009` vector file)
