---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
fixed_at: 2026-09-15T00:20:00Z
review_path: .planning/phases/07-account-identity-proof-component-0x8009-legacy-clean-cut/07-REVIEW.md
iteration: 1
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 07: Code Review Fix Report

**Fixed at:** 2026-09-15T00:20:00Z
**Source review:** .planning/phases/07-account-identity-proof-component-0x8009-legacy-clean-cut/07-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 2 (WR-01, WR-02; fix_scope `critical_warning`, 0 critical)
- Fixed: 2
- Skipped: 0
- Out of scope (Info, not attempted): IN-01 to IN-09

## Fixed Issues

### WR-01: Admin-policy Add gate skips KeyPackages whose proof material is only at the KeyPackage level (the invite seam rejects these)

**Files modified:** `src/core/components/account-identity-proof.ts`, `src/engine/admin-policy.ts`, `src/client/group/__tests__/marmot-group.test.ts`, `src/core/components/__tests__/account-identity-proof.test.ts`
**Commit:** 296ef86
**Status:** fixed: requires human verification (logic change to an authorization gate)
**Applied fix:**
- **Helper:** widened `hasAccountIdentityProofMaterial` to take any `{ extensions }` holder
  (LeafNode or KeyPackage) instead of `LeafNode` only.
  - It still reads only the holder's own `extensions`, fail-closed on an undecodable dictionary.
  - The change is backward-compatible for existing leaf callers.
  - No new export, so the `exports.test.ts` snapshot and the changeset's "13 new runtime
    exports" count are unchanged. This avoids the reviewer's separate
    `hasKeyPackageAccountIdentityProofMaterial` helper.
- **Gate:** the admin-policy Add gate now skips an Add only when neither the KeyPackage nor its
  leaf carries material.
  - KeyPackage-level legacy `0xf2f1` extensions, or a misplaced `0x8009` entry, now reach the
    same `validateKeyPackageAccountIdentityProof` validator the invite seam uses, and are
    rejected there.
  - The KNOWN GAP (D-06) comment is narrowed to "no proof material anywhere".
- **Regression test** (`marmot-group.test.ts`): with an admin committer and a bare leaf, both
  of these return `"reject"`:
  - a KeyPackage-level `0xf2f1` extension;
  - a KeyPackage-level `0x8009` dictionary entry.

  The shared validator rejects the same KeyPackages. A control with no material gets past
  the proof gate. The test uses `onUnverifiableCommit: "retry"`, so a returned `"reject"` can
  only come from the proof gate.
- **Unit test:** added a KeyPackage-input case for `hasAccountIdentityProofMaterial`.
- **Verification:**
  - `tsc -b tsconfig.build.json` passes; root `tsc --noEmit` shows no errors in touched files.
  - 95 tests pass across the affected files (account-identity-proof, marmot-group,
    group-engine, commit-authorization-seams, exports, invite-user).
  - The new WR-01 test fails with the `admin-policy.ts` change reverted and passes with it
    restored.

### WR-02: Migration docs and changeset overstate what `nonCurrent` handling does

**Files modified:** `docs/client/best-practices.md`, `.changeset/account-identity-proof-v2.md`, `src/client/key-package-store.ts`, `src/client/key-package-manager.ts`
**Commit:** 8a7986b
**Status:** fixed
**Applied fix:** docs-only, following the review's primary recommendation. No behaviour change;
the optional `selectForWelcome` skip and auto-purge were not implemented. The wording now
matches the code:
- **What `nonCurrent` does:** only `ensurePublished`'s local "is a current one already
  published" check skips flagged entries.
- **What it does not do:**
  - Their kind-30443 events stay discoverable on relays, so peers' invites that pick them
    fail.
  - `selectForWelcome` still offers them as Welcome candidates.
  - `rotate()`, `remove()`, `clear()`, and `purge()` act on them like any other entry.
- **Removal:** "only removed by an explicit `purge()`" is now "never removed automatically".
- **Migration guide:** `purge()` is now an explicit migration step (with a snippet: filter
  `list()` by `nonCurrent`, then `purge()` their `keyPackageRef`s) that publishes the NIP-09
  deletion.
- **JSDoc:** the `ListedKeyPackage` and `ensurePublished` JSDoc are updated the same way.

**Verification:**
- `tsc -b tsconfig.build.json` passes.
- `key-package-manager.test.ts` and `key-package-eligibility.test.ts` pass (80 tests).
- The snippet's API names (`client.keyPackages`, `keyPackageRef`, the `purge` signature) were
  checked against the source.
- No other copies of the stale wording remain in docs, src, or the changeset.

---

_Fixed: 2026-09-15T00:20:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
