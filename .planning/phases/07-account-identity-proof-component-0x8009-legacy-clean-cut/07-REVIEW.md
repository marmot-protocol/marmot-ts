---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
reviewed: 2026-09-14T00:00:00Z
depth: standard
files_reviewed: 94
files_reviewed_list:
  - AGENTS.md
  - .changeset/account-identity-proof-v2.md
  - docs/client/best-practices.md
  - docs/client/marmot-client.md
  - docs/client/proposals.md
  - docs/core/groups.md
  - docs/core/index.md
  - docs/core/key-packages.md
  - docs/core/protocol.md
  - docs/guide/architecture.md
  - examples/opentui/README.md
  - examples/opentui/src/marmot/setup.ts
  - README.md
  - src/client/group-factory.ts
  - src/client/group/proposals/invite-user.ts
  - src/client/group/proposals/__tests__/invite-user.test.ts
  - src/client/groups-manager.ts
  - src/client/group/__tests__/disbanded.test.ts
  - src/client/group/__tests__/fork-tree-view.test.ts
  - src/client/group/__tests__/group-media-service.test.ts
  - src/client/group/__tests__/invite.test.ts
  - src/client/group/__tests__/marmot-group.test.ts
  - src/client/key-package-manager.ts
  - src/client/key-package-publisher.ts
  - src/client/key-package-store.ts
  - src/client/marmot-client.ts
  - src/client/session/__tests__/group-session.test.ts
  - src/client/__tests__/disband-routing.test.ts
  - src/client/__tests__/join-account-identity-proof.test.ts
  - src/client/__tests__/key-package-manager.test.ts
  - src/client/__tests__/leave-group.test.ts
  - src/client/__tests__/marmot-client.test.ts
  - src/core/capabilities.ts
  - src/core/components/account-identity-proof.ts
  - src/core/components/dictionary.ts
  - src/core/components/ids.ts
  - src/core/components/index.ts
  - src/core/components/integrity.ts
  - src/core/components/__tests__/account-identity-proof.test.ts
  - src/core/components/__tests__/dictionary.test.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/components/__tests__/safe-aad-parity.test.ts
  - src/core/index.ts
  - src/core/key-package.ts
  - src/core/__tests__/capabilities.test.ts
  - src/core/__tests__/darkmatter-invite-compat.test.ts
  - src/core/__tests__/group-message.test.ts
  - src/core/__tests__/group.test.ts
  - src/core/__tests__/key-package-event.test.ts
  - src/core/__tests__/key-package-tag-parity.test.ts
  - src/core/__tests__/key-package.test.ts
  - src/core/__tests__/media.test.ts
  - src/core/__tests__/welcome.test.ts
  - src/engine/admin-policy.ts
  - src/engine/__tests__/commit-authorization-seams.test.ts
  - src/engine/__tests__/commit-legality-seams.test.ts
  - src/engine/__tests__/convergence-parity.test.ts
  - src/engine/__tests__/convergence-scheduling.test.ts
  - src/engine/__tests__/convergence-status.test.ts
  - src/engine/__tests__/disband-convergence.test.ts
  - src/engine/__tests__/disband-request.test.ts
  - src/engine/__tests__/group-engine.test.ts
  - src/engine/__tests__/history-tree-ingest.test.ts
  - src/engine/__tests__/history-tree.test.ts
  - src/engine/__tests__/ingest-deferred.test.ts
  - src/engine/__tests__/ingestion-pool.test.ts
  - src/engine/__tests__/message-dedup.test.ts
  - src/engine/__tests__/retained-store.test.ts
  - src/engine/__tests__/self-eviction.test.ts
  - src/engine/__tests__/send-commit-legality.test.ts
  - src/engine/__tests__/state-notification-withdrawal.test.ts
  - src/__tests__/conformance/adapter.test.ts
  - src/__tests__/conformance/extended.spec.ts
  - src/__tests__/conformance/named-vectors.test.ts
  - src/__tests__/conformance/smoke.test.ts
  - src/__tests__/exports.test.ts
  - src/__tests__/groups-manager.test.ts
  - src/__tests__/helpers/test-accounts.test.ts
  - src/__tests__/helpers/test-accounts.ts
  - src/__tests__/integration/app-message-replay-restart.test.ts
  - src/__tests__/integration/convergence-status.test.ts
  - src/__tests__/integration/end-to-end-invite-join-message.test.ts
  - src/__tests__/integration/group-connect.test.ts
  - src/__tests__/integration/history-tree-persistence.test.ts
  - src/__tests__/integration/ingest-commit-race.test.ts
  - src/__tests__/integration/invite-listen-ensure.test.ts
  - src/__tests__/integration/invite-preview-canjoin.test.ts
  - src/__tests__/integration/key-package-eligibility.test.ts
  - src/__tests__/integration/own-proposal-snapshot.test.ts
  - src/__tests__/integration/removed.test.ts
  - src/__tests__/integration/rewind-persistence.test.ts
  - src/__tests__/integration/self-remove.test.ts
  - src/__tests__/integration/self-update-persistence.test.ts
  - src/__tests__/integration/send-chat-message.test.ts
findings:
  critical: 0
  warning: 2
  info: 9
  total: 11
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-09-14T00:00:00Z
**Depth:** standard
**Files Reviewed:** 94
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

Reviewed the new `0x8009` proof class (`src/core/components/account-identity-proof.ts`), the
leaf dictionary builder, the GroupContext integrity guard, the invite / admin-policy Add /
join-via-Welcome seams, the KeyPackage store `nonCurrent` flag, the removed `accountProofSigner`
option, the docs and changeset, and diffs for the test files that moved to real signers.

**Wire format checked against the spec and the Rust reference, and it matches:**
- **Signing template:** the kind-450 event has tags `d` / `component` / `ciphersuite` /
  `signature_scheme` / `mls_signature_key`, with `0x%04x` lowercase hex and the fixed content
  string. This matches `refs/marmot/app-components/account-identity-proof-v2.md` and MDK
  `AccountIdentityProofRequest::proof_event` (Current).
- **Test vector:** the spec signing vector (event id, signature, 104-byte data) is pinned in
  `src/core/components/__tests__/account-identity-proof.test.ts`.
- **Leaf dictionary:** `makeLeafAppComponentsExtension` builds the same shape as MDK
  `leaf_app_components_extension`. The `0x0001` list advertises itself plus `0x8009`, then an
  empty SafeAAD `0x0002` entry, then the proof. `encodeComponentsList` de-duplicates, so the
  doubled `0x8009` in the input is harmless.
- **Raw dictionary parse:** `readDictionaryEntries` uses the same `uint16 + varint-opaque`
  vector layout as ts-mls `appDataDictionaryEncoder`.
- **Validation:** the checks match MDK `validate_current_proof` / `validate_proof_bindings`.
  The signature key is rebuilt from the leaf's own key, the signer must equal the credential
  identity, and the scheme comes from the ciphersuite. KeyPackages are validated with the
  KeyPackage ciphersuite, members with the group ciphersuite.
- **Join-time profile check:** matches MDK `protocol_profile_of_group_extensions`.

**Self-update keeps the proof valid:**
- ts-mls `updatePath.ts:105-111` and `createMessage.ts:160-167` both keep the leaf's
  `signaturePublicKey` and `extensions`.
- Commit-path and Update-proposal leaves therefore keep a valid proof (no silent strip).

**Test helper:** the order claim in `test-accounts.ts` was checked by computing the pubkeys.
Slots are strictly ascending, and slot 14 is secret key 3, as documented.

**Changeset:** the export counts (15 removed, 13 added) match the `exports.test.ts` snapshot.

No BLOCKER-class defect could be proven. Two WARNINGs remain:
1. The admin-policy Add gate is slightly wider than the documented D-06 gap.
2. The migration guidance promises behaviour that the code does not deliver.

**Known items confirmed:**
- **Stale references to the deleted `../account-identity-proof.js`:** confirmed, listed as
  IN-01.
- **D-06 gap:** confirmed as documented for leaves with no proof material. It is wider in two
  ways:
  - KeyPackage-level proof material is ignored (WR-01).
  - Standalone Add proposals short-circuit to `"accept"` at `admin-policy.ts:40`. Phase 8
    success criterion 4 already covers this, so it is not a separate finding.
- **Inbound Update / commit update-path leaves:** they are not validated on ingest. This is
  scoped to Phase 9 (UPD-01..04) and is not re-reported.

## Warnings

### WR-01: Admin-policy Add gate skips KeyPackages whose proof material is only at the KeyPackage level (the invite seam rejects these)

**File:** `src/engine/admin-policy.ts:45-52` (with `src/core/components/account-identity-proof.ts:490-512`)

**Issue:** The gate decides whether to validate by calling
`hasAccountIdentityProofMaterial(keyPackage.leafNode)`, which only looks at the leaf.

- **What slips through:** a KeyPackage whose leaf has no proof material, but whose
  KeyPackage-level `extensions` carry the legacy `0xf2f1` extension or an `app_data_dictionary`
  with a `0x8009` entry.
- **What happens:** the gate hits `continue` and the Add is accepted.
- **The same KeyPackage on the send seam:** `proposeInviteUser` → `validateKeyPackageAccountIdentityProof`
  rejects it with `legacy-extension-present` / `invalid-location`
  (`validateKeyPackageAccountIdentityProof` lines 556-567).

That is exactly the send/inbound asymmetry (mdk#707) the project is trying to remove. The
KNOWN GAP comment says only "Adds without proof material are skipped", but a KeyPackage that
*does* carry misplaced or legacy material is skipped too. Phase 8 may well close this along
with the rest of D-06. Until then, the documented gap is narrower than what the code does.

**Fix:** Count KeyPackage-level material as material, so misplaced or legacy proofs always go
through the validator:
```ts
const keyPackage = proposal.add.keyPackage;
const kpHasMaterial =
  keyPackage.extensions.some((e) => e.extensionType === 0xf2f1) ||
  (() => {
    try {
      assertNoAccountIdentityProofComponent(keyPackage.extensions, "key-package");
      return false;
    } catch {
      return true;
    }
  })();
// KNOWN GAP (D-06): only Adds with no proof material anywhere are skipped.
if (!kpHasMaterial && !hasAccountIdentityProofMaterial(keyPackage.leafNode)) continue;
```
A cleaner option: add a `hasKeyPackageAccountIdentityProofMaterial(keyPackage)` helper in the
component module, next to `hasAccountIdentityProofMaterial`.

### WR-02: Migration docs and changeset overstate what `nonCurrent` handling does

**File:** `docs/client/best-practices.md:61`, `.changeset/account-identity-proof-v2.md:47-50`, `src/client/key-package-store.ts:92-97`

**Issue:** The docs make three claims that are wrong or misleading:

1. **"is never reused for new invitations"** (best-practices.md). `ensurePublished` only avoids
   picking the legacy entry *locally*. The kind-30443 event is still on relays unless the new
   KeyPackage happens to reuse the same `d` slot. Peers keep discovering it, and their invite
   then fails in `proposeInviteUser` (v2 peers) or MDK `do_send_invite`. Following the guide
   ("Nothing is deleted automatically") leaves the user un-invitable through that event until
   they call `purge()`.
2. **"are only removed by an explicit `purge()`"** (changeset and `ListedKeyPackage` JSDoc).
   `KeyPackageManager.rotate()` (line 370), `remove()` (line 390), and `clear()` also remove
   them.
3. **Welcome selection.** `selectForWelcome` does not skip `nonCurrent` entries. A Welcome
   addressed to a legacy KeyPackage gets through `joinGroup`, then fails with
   `account identity proof invalid for group member N`. That message does not tell the user
   their own KeyPackage is the stale one.

**Fix:**
- Reword the docs to say a non-current KeyPackage stays discoverable on relays, and invites
  that pick it will fail until `purge()` publishes the NIP-09 deletion. Either recommend
  `purge()` explicitly as part of migration, or have `ensurePublished` optionally purge
  non-current entries.
- Change "only removed by an explicit purge()" to "never removed automatically".
- Optionally skip or deprioritize `nonCurrent` candidates in `selectForWelcome`, or raise a
  clearer error when the local leaf is the invalid one.

## Info

### IN-01: Stale references to the deleted legacy module and "later task" wording

**File:**
- `src/core/components/account-identity-proof.ts:4-7, 15-17, 68-71, 219-222`
- `src/core/__tests__/key-package.test.ts:44`
- `src/core/__tests__/darkmatter-invite-compat.test.ts:72`
- `src/core/__tests__/capabilities.test.ts:22`

**Issue:** These still point at `../account-identity-proof.js`, which this phase deleted:
- "a purely additive replacement … which this module does not import from or modify"
- "Re-homed verbatim from … `MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE`"

The module header also says the validators are "added in a later task of this module", but
they are already in the file. (Known item, confirmed.)

**Fix:** Rewrite the header to describe the current module. Refer to the legacy extension only
by type (`0xf2f1`), not by a file path.

### IN-02: `"group-info"` location guard is exported but never enforced

**File:** `src/core/components/account-identity-proof.ts:133-135, 521-535`; `src/client/groups-manager.ts:714-726`

**Issue:** The spec says the component is invalid in GroupInfo. `AccountIdentityProofLocation`
includes `"group-info"`, but nothing in `src` calls `assertNoAccountIdentityProofComponent(…, "group-info")`.
`joinFromWelcome` checks the GroupContext and the member leaves, not the Welcome's GroupInfo
extensions. MDK's `do_join_welcome` does not check this either, so it is not an interop defect.

**Fix:** Either enforce it in `joinFromWelcome` via `readWelcomeGroupInfo`, or drop
`"group-info"` from the exported union until a seam uses it. Track it under Phase 8.

### IN-03: ECDSA signature-key length table accepts compressed SEC1 points

**File:** `src/core/components/account-identity-proof.ts:230-236`

**Issue:** `0x0403/0x0503/0x0603` accept the compressed lengths 33/49/67. RFC 9420 ECDSA
signature keys are uncompressed SEC1, which OpenMLS/MDK produce and expect. This matches ts-mls
(noble `getPublicKey` defaults to compressed), so marmot-ts can validate a P-256 leaf that MDK
would reject at the MLS layer. This is a ts-mls interop issue that predates this phase, and the
length table hides it rather than causing it.

**Fix:** Record the divergence in a comment that references the ts-mls issue. Tighten to
uncompressed-only once the fork emits uncompressed keys.

### IN-04: Member index in error message is an ordinal, not a tree position

**File:** `src/core/components/account-identity-proof.ts:572-595`

**Issue:** The JSDoc says the error names "the member's tree position". The loop index is
actually the position in `getGroupMembers(state)`, which skips blank leaves. In a tree with
blanks, "group member 2" is not leaf index 2, so diagnostics point at the wrong leaf.

**Fix:** Walk `state.ratchetTree` and report `nodeIndex / 2` (the leaf index), or change the
wording to "member ordinal".

### IN-05: Redundant nested ternary in `wrapAsInvalidProof`

**File:** `src/core/components/account-identity-proof.ts:304-310`

**Issue:** `AuthorizationProofError` extends `Error`, so the first branch is dead code.

**Fix:** `{ cause: err instanceof Error ? err : undefined }`.

### IN-06: `KeyPackageStore.list()` turns every validator exception into `nonCurrent`

**File:** `src/client/key-package-store.ts:316-322`

**Issue:** The bare `catch {}` treats any throw as "non-current". That includes a real bug in
the validator, or a store adapter that does not revive `Uint8Array`: `dictionaryExtensionsOf`
filters on `instanceof Uint8Array`, so every entry would come back `missing-support`. In that
case every stored KeyPackage is flagged `nonCurrent`, and `ensurePublished` quietly publishes a
fresh KeyPackage on each call, with no log line.

**Fix:** Catch only `AccountIdentityProofError`. Log or rethrow anything else, or at least
`this.#log` the reason.

### IN-07: The produce path does not guard caller-supplied KeyPackage-level extensions

**File:** `src/core/key-package.ts:131-133`

**Issue:** `generateKeyPackage` passes caller `extensions` through unchanged. A caller who
supplies an `app_data_dictionary` containing `0x8009`, or a `0xf2f1` extension, gets a
KeyPackage that `validateKeyPackageAccountIdentityProof` itself rejects (`invalid-location` /
`legacy-extension-present`). There is no error at generation time.

**Fix:** Call `assertNoAccountIdentityProofComponent(resolvedExtensions, "key-package")` and
reject `0xf2f1` before signing.

### IN-08: `createGroup` can still produce a legacy or mixed group the library refuses to join

**File:** `src/core/group.ts:85-96`

**Issue:** A caller-supplied `required_capabilities` in `extensions` replaces the Marmot
baseline completely, and may list `0xf2f1`. `createGroup` then builds a group that classifies
as `"mixed"`, and `joinFromWelcome` (including other marmot-ts clients) rejects it. This is
Phase 8 GRP-01 territory, noted so it is not lost.

**Fix:** Call `assertCurrentGroupAccountIdentityProofProfile(groupExtensions)` before
`MLSCreateGroup`.

### IN-09: No Rust-signed cross-implementation check for `0x8009` until Phase 11; docs leftover

**File:**
- `src/core/__tests__/darkmatter-invite-compat.test.ts` (the removed Rust fixture block)
- deleted `src/__tests__/conformance/proof-v2-parity.test.ts`, `src/__tests__/fixtures/proof-v2-rust.json`
- `docs/core/key-packages.md:60`

**Issue:**
- **Test coverage:** the only Rust-produced proof fixture (legacy shape) was removed and not
  replaced. The spec vector is still pinned, and MDK's own tests pin it too, so parity
  currently rests on the spec vector alone. A leaf built and signed by MDK is not
  cross-verified until Phase 11.
- **Docs:** the requirements list in `docs/core/key-packages.md` that this phase edited still
  says "Support Marmot Group Data Extension (0xf2ee)", right next to the new `0x8009` bullet.
  That contradicts the v2 `app_data_dictionary` (`0x0006`) model.

**Fix:** Keep Phase 11's Rust-signed fixture requirement. Replace the `0xf2ee` bullet with
`app_data_dictionary (0x0006)`.

---

_Reviewed: 2026-09-14T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
